import {
  ARTIFACT_KINDS,
  STUDIO_STYLE_REFERENCE_NOTES_PATH,
  cardsFromDraft,
  designComponentSchema,
  directDependencies,
  isUiCard,
  studioBoardDraftSchema,
  type AppSettings,
  type ArtifactKind,
  type BoardCard,
  type BoardStatus,
  type CardCheck,
  type CardRun,
  type PersistedEvent,
  type StudioArtifacts,
  type StudioBoard,
  type StudioDesign,
  type StudioReadiness,
  type UiCheckResult,
} from '@kai/contracts';
import { loadProjectContext, parseJsonResponse } from './learning-tutor';
import type { StructuredRequester } from './prompt-guide';
import type { StudioArtifacts as ArtifactStore } from './artifacts';
import type { StudioBoardStore } from './board';
import { changedNodes, designErrorMessage, readDesign, type DesignPorts, type DesignRead } from './design-source';
import { failureSummary, type DesktopUiCheck } from './ui-check';
import { boardDraftFromStories, replySnippet } from './studio-fallbacks';

/**
 * The rest of the studio: it turns the interview's brief into the artifact set, and the stories into a board of
 * cards. Both are model calls over the Prompt Guide's connection, so the studio still adds no key and no second
 * bill. The one artifact it does not generate is `tokens`, which is pulled from open-pencil — the design tool is
 * the source of truth for tokens, and a model never invents them.
 *
 * Everything it writes goes through `spec-store.ts`, so the copy it replaces is kept and the dependency table
 * decides what goes stale.
 */

/**
 * The artifacts a model writes. `brief` comes from the interview. `tokens` is written here from the style guide so a
 * project always has them; pulling the design from open-pencil replaces them, because the design tool is the source of truth.
 */
export const MODEL_ARTIFACTS: ArtifactKind[] = ['prd', 'stories', 'stack', 'flows', 'style-guide', 'tokens', 'pages', 'decisions', 'architecture', 'conventions', 'acceptance', 'risks', 'glossary', 'setup'];

const NAMES = { feature: 'the Project Studio', card: 'Project Studio' };
const GENERATE_CONTEXT_CHARS = 12_000;
/** A document or a board for a big brief is long, and a reasoning model spends part of the budget thinking first. */
const STUDIO_MAX_OUTPUT_TOKENS = 24_000;

const CONTENT_SCHEMA = { type: 'object', additionalProperties: false, required: ['content'], properties: { content: { type: 'string' } } } as const;
const BOARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['cards'],
  properties: {
    cards: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'title', 'kind'],
        properties: {
          key: { type: 'string' },
          title: { type: 'string' },
          kind: { type: 'string', enum: ['backend', 'component', 'page', 'flow', 'chore'] },
          story: { type: 'string' },
          acceptance: { type: 'array', items: { type: 'string' } },
          route: { type: 'string' },
          dependsOnKeys: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

export interface StudioPorts {
  settings(): Promise<AppSettings>;
  projectRoot(projectId: string): Promise<string>;
  requester: StructuredRequester;
  /** The interview already answers "is the model connection ready"; the studio asks the same question in the same way. */
  interview: { readiness(): Promise<StudioReadiness> };
  artifacts: ArtifactStore;
  board: StudioBoardStore;
  /** The visual check for UI cards. It runs through the Playwright MCP, so it needs no browser of its own. */
  uiCheck: DesktopUiCheck;
  /**
   * open-pencil, when it is configured. Null means the design layer is not set up, and the studio says so instead
   * of failing: everything except the tokens and the design's own cards works without it.
   */
  openPencil?(): Promise<DesignPorts | null>;
  /**
   * Gets open-pencil running and KAI's connection to it fresh, launching the editor when it is not already open.
   * Optional so tests that only read the design (never build it) can leave it out.
   */
  ensureOpenPencilRunning?(): Promise<void>;
  /**
   * Runs one design-build prompt as a real agent turn with open-pencil's tools available, through whichever
   * provider the user has configured. `onEvent` carries the turn's own tool calls live, the same events a
   * composer run reports, keyed by `conversationId` so the caller can tell one step's events from another's.
   * Optional for the same reason as `ensureOpenPencilRunning`.
   */
  runDesignAgent?(
    prompt: string,
    projectRoot: string,
    conversationId: string,
    onEvent?: (event: PersistedEvent) => void,
  ): Promise<{ status: 'completed' | 'failed'; output: string; error?: string; costUsd?: number }>;
  /** Writes the status file and the root agent instructions. Optional so tests can leave it out. */
  handoff?: { write(projectId: string, board: StudioBoard, catalog: StudioArtifacts): Promise<void> };
  now(): string;
}

export class DesktopStudio {
  constructor(private readonly ports: StudioPorts) {}

  readiness(): Promise<StudioReadiness> {
    return this.ports.interview.readiness();
  }

  artifacts(projectId: string): Promise<StudioArtifacts> {
    return this.ports.artifacts.read(projectId);
  }

  board(projectId: string): Promise<StudioBoard> {
    return this.ports.board.read(projectId);
  }

  /** The files the studio has written under `.kai/spec`, for a UI that lists real files rather than guesses. */
  files(projectId: string): Promise<string[]> {
    return this.ports.artifacts.files(projectId);
  }

  /** One artifact's text, or null when it has not been written yet. This is what a card's brief is built from. */
  artifactText(projectId: string, kind: ArtifactKind): Promise<string | null> {
    return this.ports.artifacts.readText(projectId, kind);
  }

  /** Every written artifact's text, keyed by kind, for the planner that turns cards into briefs. */
  async artifactTexts(projectId: string): Promise<Partial<Record<ArtifactKind, string>>> {
    const catalog = await this.ports.artifacts.read(projectId);
    const entries = await Promise.all(catalog.artifacts.map(async (entry) => [entry.kind, await this.ports.artifacts.readText(projectId, entry.kind)] as const));
    return Object.fromEntries(entries.filter(([, text]) => text !== null)) as Partial<Record<ArtifactKind, string>>;
  }

  /** Generates every artifact that is missing or stale, in the order the dependency table gives. */
  async generateAll(projectId: string): Promise<StudioArtifacts> {
    const readiness = await this.ports.interview.readiness();
    if (!readiness.ready) throw new Error(readiness.reason ?? 'The Project Studio is not ready.');
    const catalog = await this.ports.artifacts.read(projectId);
    const byKind = new Map(catalog.artifacts.map((entry) => [entry.kind, entry]));
    // One artifact the model gets wrong must not stop the rest: write what can be written, then say what could not.
    const failed = new Map<ArtifactKind, string>();
    for (const kind of ARTIFACT_KINDS) {
      if (!MODEL_ARTIFACTS.includes(kind)) continue;
      const entry = byKind.get(kind);
      if (entry && !entry.stale) continue;
      const blockedBy = directDependencies(kind).find((dependency) => failed.has(dependency));
      if (blockedBy) {
        failed.set(kind, `it is built from ${blockedBy}, which could not be written`);
        continue;
      }
      try {
        await this.generate(projectId, kind);
      } catch (error) {
        failed.set(kind, error instanceof Error ? error.message : String(error));
      }
    }
    await this.refreshHandoff(projectId);
    if (failed.size > 0) {
      const cause = [...failed.entries()].find(([, reason]) => !reason.startsWith('it is built from'));
      const wrote = MODEL_ARTIFACTS.filter((kind) => !failed.has(kind)).length;
      throw new Error(`Wrote ${wrote} of ${MODEL_ARTIFACTS.length} artifacts. Could not write: ${[...failed.keys()].join(', ')}.${cause ? ` ${cause[0]}: ${cause[1]}` : ''}`);
    }
    return this.ports.artifacts.read(projectId);
  }

  /** Generates one artifact from the artifacts it reads, then updates the catalog. */
  async generate(projectId: string, kind: ArtifactKind): Promise<StudioArtifacts> {
    const settings = await this.ports.settings();
    const root = await this.ports.projectRoot(projectId);
    const inputs: Record<string, string> = {};
    for (const dependency of directDependencies(kind)) {
      inputs[dependency] = (await this.ports.artifacts.readText(projectId, dependency)) ?? '';
    }
    const missing = Object.entries(inputs).filter(([, text]) => !text.trim()).map(([name]) => name);
    if (missing.length > 0) throw new Error(`Write ${missing.join(', ')} first: ${kind} is built from it.`);
    // Reference images, once a model has described them, steer the look: the style guide and the tokens follow them.
    if (kind === 'style-guide' || kind === 'tokens') {
      const reference = await this.ports.artifacts.readSpecText(projectId, STUDIO_STYLE_REFERENCE_NOTES_PATH);
      if (reference?.trim()) inputs['style reference (from the user\'s images; follow it)'] = reference;
    }
    const context = await loadProjectContext(root, undefined, GENERATE_CONTEXT_CHARS).catch(() => null);
    const content = await this.ports.requester.structuredRequest(
      settings.promptGuide,
      NAMES,
      artifactPrompt(kind, inputs, context),
      `kai_studio_${kind.replace('-', '_')}`,
      CONTENT_SCHEMA,
      (raw) => parseArtifact(raw, kind),
      { maxOutputTokens: STUDIO_MAX_OUTPUT_TOKENS },
    );
    const catalog = await this.ports.artifacts.write(projectId, kind, content, settings.promptGuide.model);
    await this.refreshHandoff(projectId);
    return catalog;
  }

  /** Turns the stories and the stack into board cards, keeping the work already done on cards that survive. */
  async plan(projectId: string): Promise<StudioBoard> {
    const settings = await this.ports.settings();
    const root = await this.ports.projectRoot(projectId);
    const [brief, stories, stack] = await Promise.all([
      this.ports.artifacts.readText(projectId, 'brief'),
      this.ports.artifacts.readText(projectId, 'stories'),
      this.ports.artifacts.readText(projectId, 'stack'),
    ]);
    if (!stories?.trim()) throw new Error('Write the stories first: the board is built from them.');
    const context = await loadProjectContext(root, undefined, GENERATE_CONTEXT_CHARS).catch(() => null);
    // A model that will not return the card JSON must not leave the project with no board: the stories already say
    // what the cards are, so fall back to reading them directly.
    const draft = await this.ports.requester.structuredRequest(
      settings.promptGuide,
      NAMES,
      boardPrompt(brief ?? '', stories, stack ?? '', context),
      'kai_studio_board',
      BOARD_SCHEMA,
      parseBoardDraft,
      { maxOutputTokens: STUDIO_MAX_OUTPUT_TOKENS },
    ).catch((error: unknown) => {
      const fallback = boardDraftFromStories(stories);
      if (fallback.cards.length === 0) throw error;
      return fallback;
    });
    const cards = cardsFromDraft(draft, this.ports.now());
    const catalog = await this.ports.artifacts.read(projectId);
    const board = await this.ports.board.replace(projectId, cards, catalog.artifacts);
    await this.refreshHandoff(projectId);
    return board;
  }

  /**
   * Puts an existing board in a better order, and sets the dependencies that hold that order.
   *
   * The board is planned once, from the stories, and a plan made before anything was built rarely survives contact
   * with the work: hosting and managed services written early stay early, and a person opening the board is handed a
   * cloud database as their first task. This is the second pass, for a board that already exists.
   *
   * Nothing is lost. The model returns ids, cards it leaves out keep their place at the end, and `replace` merges by
   * id — so every status, run and check survives arranging.
   */
  async arrange(projectId: string): Promise<StudioBoard> {
    const settings = await this.ports.settings();
    const root = await this.ports.projectRoot(projectId);
    const [brief, stack, board] = await Promise.all([
      this.ports.artifacts.readText(projectId, 'brief'),
      this.ports.artifacts.readText(projectId, 'stack'),
      this.ports.board.read(projectId),
    ]);
    if (board.cards.length === 0) throw new Error('This project has no board to arrange yet.');
    const context = await loadProjectContext(root, undefined, GENERATE_CONTEXT_CHARS).catch(() => null);
    const plan = await this.ports.requester.structuredRequest(
      settings.promptGuide,
      NAMES,
      arrangeBoardPrompt(board, brief ?? '', stack ?? '', context),
      'kai_studio_arrange',
      ARRANGE_SCHEMA,
      parseArrangePlan,
      { maxOutputTokens: STUDIO_MAX_OUTPUT_TOKENS },
    );

    const known = new Map(board.cards.map((card) => [card.id, card]));
    const ordered: BoardCard[] = [];
    const placed = new Set<string>();
    for (const entry of plan.cards) {
      const card = known.get(entry.id);
      // A card named twice, or one that does not exist, is skipped rather than duplicated.
      if (!card || placed.has(card.id)) continue;
      placed.add(card.id);
      // A dependency on a card that is not on the board, or on itself, would make a card unworkable for good.
      const dependsOn = entry.dependsOn.filter((id) => id !== card.id && known.has(id));
      ordered.push({ ...card, dependsOn, updatedAt: this.ports.now() });
    }
    // Whatever the model did not name keeps its place, so arranging can never drop a card.
    for (const card of board.cards) if (!placed.has(card.id)) ordered.push(card);

    const catalog = await this.ports.artifacts.read(projectId);
    const arranged = await this.ports.board.replace(projectId, ordered, catalog.artifacts);
    await this.refreshHandoff(projectId);
    return arranged;
  }

  next(projectId: string): Promise<BoardCard | null> {
    return this.ports.board.next(projectId);
  }

  async claim(projectId: string, cardId: string, agent: string): Promise<BoardCard> {
    const card = await this.ports.board.claim(projectId, cardId, agent);
    await this.refreshHandoff(projectId);
    return card;
  }

  /**
   * Runs the visual check on one UI card and files the result. A pass records the check and leaves the card in
   * `review` for a person to look at; a failure records the checks and hands the card back with what to repair.
   * Either way it never marks the card `done` — that stays with `move`.
   */
  async checkUi(projectId: string, cardId: string): Promise<{ card: BoardCard; result: UiCheckResult }> {
    const board = await this.ports.board.read(projectId);
    const card = board.cards.find((item) => item.id === cardId);
    if (!card) throw new Error(`No card ${cardId} on the board.`);
    if (!isUiCard(card)) throw new Error(`${card.title} is not a component or page, so there is no screen to check.`);
    if (!card.route) throw new Error(`${card.title} has no route recorded, so there is no screen to open. Fill in "route" on the card first.`);
    const route = card.route;
    const root = await this.ports.projectRoot(projectId);
    const result = await this.ports.uiCheck.run(projectId, root, card, route);
    await this.ports.board.setCheck(projectId, cardId, {
      runId: card.check?.runId ?? 'visual-only',
      at: this.ports.now(),
      visual: result.passed ? 'passed' : 'failed',
      screenshots: result.screenshots,
    });
    const moved = await this.ports.board.move(
      projectId,
      cardId,
      result.passed ? 'review' : 'ready',
      result.passed ? 'The visual check passed; waiting for a person to approve the screenshots.' : failureSummary(result),
      'check',
    );
    return { card: moved, result };
  }

  /** A move made through the app (a drag, the phone) is the person's; agents move cards through the project tools. */
  async move(projectId: string, cardId: string, status: BoardStatus, note = '', by: 'user' | 'agent' | 'check' = 'user'): Promise<BoardCard> {
    const card = await this.ports.board.move(projectId, cardId, status, note, by);
    await this.refreshHandoff(projectId);
    return card;
  }

  /**
   * Rewrites `status.md` (and the root `AGENTS.md` when KAI owns it) from the board and the catalog. It is a
   * convenience for whoever picks the project up next, so a failure here never fails the move that triggered it.
   */
  async refreshHandoff(projectId: string): Promise<void> {
    if (!this.ports.handoff) return;
    try {
      const [board, catalog] = await Promise.all([this.ports.board.read(projectId), this.ports.artifacts.read(projectId)]);
      await this.ports.handoff.write(projectId, board, catalog);
    } catch {
      // Best effort by design.
    }
  }

  recordRun(projectId: string, cardId: string, run: CardRun): Promise<BoardCard> {
    return this.ports.board.recordRun(projectId, cardId, run);
  }

  setCheck(projectId: string, cardId: string, check: CardCheck): Promise<BoardCard> {
    return this.ports.board.setCheck(projectId, cardId, check);
  }

  /**
   * Saves a hand edit. The copy it replaces is kept in the spec history, the catalog records that a person wrote it,
   * and everything that reads it is flagged stale so nothing trusts a document built on the old text.
   */
  async saveArtifact(projectId: string, kind: ArtifactKind, content: string): Promise<StudioArtifacts> {
    if (!content.trim()) throw new Error('An artifact cannot be saved empty. Regenerate it instead if you want it rewritten.');
    await this.ports.artifacts.write(projectId, kind, content.endsWith('\n') ? content : content + '\n', 'user');
    const catalog = await this.ports.artifacts.markEdited(projectId, kind);
    await this.refreshHandoff(projectId);
    return catalog;
  }

  markEdited(projectId: string, kind: ArtifactKind): Promise<StudioArtifacts> {
    return this.ports.artifacts.markEdited(projectId, kind);
  }

  /** What KAI last read from open-pencil, for the UI to show when the design was last pulled. */
  design(projectId: string): Promise<StudioDesign> {
    return this.ports.board.design(projectId);
  }

  /**
   * Reads the design from open-pencil and folds it into `.kai/spec`: the tokens become `design/tokens.json`, the
   * components and pages get their cards, and every card holding a node that changed goes stale. Tokens are pulled
   * from the editor rather than written by a model — the design is the source of truth, so a model never invents one.
   */
  async pullDesign(projectId: string): Promise<{ design: StudioDesign; board: StudioBoard; changed: string[]; tokensChanged: boolean; tokenCount: number }> {
    const ports = await this.ports.openPencil?.();
    if (!ports) throw new Error('open-pencil is not connected. Set it up under Settings, Design tools, then pull the design again.');
    const previous = await this.ports.board.design(projectId);
    let read: DesignRead;
    try {
      read = await readDesign(ports);
    } catch (error) {
      throw new Error(designErrorMessage(error));
    }
    const changed = changedNodes(previous.hashes, read.hashes);
    const tokens = `${JSON.stringify(read.tokens, null, 2)}\n`;
    // Only a real change writes: pulling the same design twice must not bump the artifact's version.
    const tokensChanged = tokens !== (await this.ports.artifacts.readText(projectId, 'tokens'));
    if (tokensChanged) await this.ports.artifacts.write(projectId, 'tokens', tokens, 'open-pencil');
    const design = await this.ports.board.saveDesign(projectId, {
      schemaVersion: 1,
      endpoint: ports.endpoint(),
      pulledAt: this.ports.now(),
      treeHash: read.treeHash,
      hashes: read.hashes,
      components: read.components.map((component) => designComponentSchema.parse(component)),
    });
    const board = await this.ports.board.applyDesign(projectId, read.components, changed);
    return { design, board, changed, tokensChanged, tokenCount: read.tokenCount };
  }

  /**
   * Runs one design-build prompt as a real agent turn against open-pencil's tools, instead of a person pasting it
   * into the composer by hand. Launches the editor first if it is not already running. The caller is expected to
   * pull the design afterward to see what actually got drawn — this only reports whether the turn itself finished,
   * the same way a composer run does.
   */
  async buildDesignStep(
    projectId: string,
    prompt: string,
    stepId: string,
    onEvent?: (event: PersistedEvent) => void,
  ): Promise<{ status: 'completed' | 'failed'; output: string; error?: string; costUsd?: number }> {
    if (!this.ports.ensureOpenPencilRunning || !this.ports.runDesignAgent) {
      throw new Error('The design-build loop is not available in this build.');
    }
    await this.ports.ensureOpenPencilRunning();
    const root = await this.ports.projectRoot(projectId);
    return this.ports.runDesignAgent(prompt, root, stepId, onEvent);
  }
}

/** The prompt for one artifact: what it is for, and the artifacts it is built from. */
export function artifactPrompt(kind: ArtifactKind, inputs: Record<string, string>, context: string | null): { system: string; user: string } {
  const system = [
    'You are the Project Studio inside KAI, a desktop workbench where a team of coding agents builds software.',
    'You write one document at a time from the documents it is built on. Return only JSON matching the schema.',
    '',
    ARTIFACT_BRIEFS[kind],
    'Write plain markdown in "content". Be specific and concrete: name real files and folders from the snapshot, and prefer decisions over options. Do not invent files the snapshot shows do not exist — say "a new file under <folder>" instead.',
    'Do not ask the reader questions and do not include a preamble; start at the first heading.',
  ].join('\n');
  const user = [
    ...Object.entries(inputs).map(([name, text]) => `${name.toUpperCase()}:\n${text}`),
    context ? `Project snapshot (read-only; for naming real files and folders):\n${context}` : 'No project snapshot is available.',
  ].join('\n\n');
  return { system, user };
}

const ARTIFACT_BRIEFS: Record<ArtifactKind, string> = {
  brief: 'Write the brief.',
  prd: 'Write the PRD: the product requirements — the problem, who it is for, the features in priority order, and what is explicitly out of scope. Every requirement should be checkable.',
  stories: 'Write the user stories: a numbered list of small, independent stories. Each says who wants it, what they want, and why, then its acceptance criteria as a short list. These become the board cards, so make them small enough for one agent to finish. Order them so the product works on a developer server first; deployment, hosting and a managed database are the last stories, not the first.',
  stack: 'Write the stack document: the languages, frameworks, data store, and hosting, each with the one-line reason it was chosen. Name the concrete packages and versions where it matters, and say where the code lives.',
  flows: 'Write the flows document: the main user journeys end to end. Use a "## Journey name" heading for each journey, then a numbered list with one short step per line. Name screens with their route, like "Sign-in page (/sign-in)", and endpoints like "POST /api/sessions". Start a step with "If ...?" when the journey branches, and say where each branch goes. A diagram is drawn from this, so keep the format.',
  pages: 'Write the page inventory for a designer drawing in open-pencil: one "## Page name" section for EVERY screen the project will have, not only the main pages. Include sign-in, sign-up and password screens, settings and profile, admin screens, error and not-found pages, modals and dialogs, and confirmation screens. Each section gives its route, what it is for, the main components on it, the states it must show (empty, loading, error, disabled), whether it needs a phone version, and the story numbers it serves. These become the screens drawn in the design tool and the page cards on the board.',
  'style-guide': 'Write the design style guide for a designer working in open-pencil: the look and feel in words, then the design variables to create (colour roles with light and dark values, spacing, radius), the text styles for the type scale, and the shared components to build first (buttons, inputs, cards, navigation, modals, empty, loading and error blocks) with their states. Follow any style reference supplied. Where a user choice (colours, light or dark, feel) is in the brief, use it exactly. Use names that a variable or text style could carry.',
  tokens: 'Write the design tokens as one JSON object, with no commentary: "colors" (semantic names such as background, surface, text, muted, primary, accent, success, warning, danger, each with "light" and "dark" hex values), "typography" (font families and a size scale), "spacing" and "radius" scales. Take the colours and the feel from the style guide and the brief. Where none were chosen, pick a restrained palette that fits the product and explain the choice in a top-level "notes" string. Put the whole JSON document, as text, in "content".',
  decisions: 'Write the decision log: one entry per significant choice already made in the brief and the stack. Each entry has a number, the decision, the reason, and the alternatives that were dropped, so a new agent does not reverse a choice without knowing why.',
  architecture: 'Write the architecture map: the folders and modules, what each owns, how data flows between them, and where state lives. A new agent should know which files to touch for a given change.',
  conventions: 'Write the conventions: naming, file layout, error handling, how tests are written, the exact commands to install, build, test and run, and the areas an agent must not change without asking.',
  acceptance: 'Write the acceptance and test plan: for each story, the checks that prove it works, as concrete steps or test cases. Keep the story numbering from the stories document.',
  risks: 'Write the risks and open questions: what could go wrong or is still undecided, each with the impact, a suggested owner (the user or an agent) and the next step to settle it.',
  glossary: 'Write the glossary of domain terms and product words used in the brief, each with a one-line definition, so people and agents use the same words.',
  setup: 'Write the setup notes: prerequisites, environment variable NAMES with what each is for (never real values or secrets), services to run, seed data, and the steps from a clean machine to a running project.',
};

/** The prompt for the board: the stories, the stack, and the rule that a page is blocked by its endpoints. */
export function boardPrompt(brief: string, stories: string, stack: string, context: string | null): { system: string; user: string } {
  const system = [
    'You are the Project Studio inside KAI. You turn the stories into a board of cards that a team of coding agents works through one at a time.',
    'Return only JSON matching the schema.',
    '',
    'Rules:',
    '- One card per story, plus a card for each shared component and page the stories imply. Keep a card small enough for one agent to finish in one turn.',
    '- "kind" is "backend" for an endpoint or data work, "component" for a reusable UI piece, "page" for a screen, "flow" for tying pages together, "chore" for setup.',
    '- "key" is a short stable slug, unique on the board. "dependsOnKeys" names other cards by their key.',
    '- "route" is the path the screen is reached at ("/sign-up"), for a page card and for a component that owns one; leave it empty for a component that only appears inside a page.',
    '- Order the work so the product runs locally first: the data model, the endpoints and the screens on a developer server, then shared components, then pages. A page card depends on the endpoint and component cards it needs.',
    '- Anything that only matters once the product is hosted comes LAST: deploying, containerising, a hosted or managed database, a release pipeline, domains and production secrets. Those cards depend on the work that makes the product run without them, so an agent reaches them only when everything else is done. Never put hosting or a managed database before the feature that uses it.',
    '- Each "acceptance" item is one checkable statement. These are what the card is closed on.',
  ].join('\n');
  const user = [
    `BRIEF:\n${brief}`,
    `STORIES:\n${stories}`,
    stack ? `STACK:\n${stack}` : '',
    context ? `Project snapshot (read-only; for naming real files and folders):\n${context}` : 'No project snapshot is available.',
  ].filter(Boolean).join('\n\n');
  return { system, user };
}

/** One card's place in an arranged board: which card, and what it must wait for. */
export interface StudioArrangeEntry {
  id: string;
  dependsOn: string[];
}

const ARRANGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['cards'],
  properties: {
    cards: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'dependsOn'],
        properties: {
          id: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

/**
 * The prompt for arranging a board that already exists. Unlike the board prompt, these cards carry work — runs,
 * checks, a status — so this asks only for their order and their dependencies, and names them by id rather than
 * asking for new cards. The order is the list; dependencies are what make the order hold when Autopilot picks work.
 */
export function arrangeBoardPrompt(board: StudioBoard, brief: string, stack: string, context: string | null): { system: string; user: string } {
  const cards = board.cards
    .map((card) => `- ${card.id} [${card.kind}${card.status === 'done' ? ', already done' : ''}] ${card.title}${card.dependsOn.length > 0 ? ` (currently waiting on: ${card.dependsOn.join(', ')})` : ''}`)
    .join('\n');
  const system = [
    'You are the Project Studio inside KAI. You are given the cards of a board that already exists, and you put them in the order a person should work them.',
    'Return only JSON matching the schema.',
    '',
    'Rules:',
    '- Return every card exactly once. The order of your list is the order the work happens in.',
    '- Put the work that makes the product run on a developer server first: the data model, then the endpoints, then the shared components, then the pages.',
    '- Anything that only matters once the product is hosted comes LAST: deploying, containerising, a hosted or managed database, release pipelines, domains and production secrets. A managed database is never before the features that use it.',
    '- "dependsOn" lists the ids of the cards that must be finished before it, and only those. Use it so a card cannot be reached before what it needs. An empty list is normal for the cards that come first.',
    '- Use the ids exactly as given. Do not invent a card, do not leave one out, and do not rewrite any title.',
  ].join('\n');
  const user = [
    `CARDS:\n${cards}`,
    brief ? `BRIEF:\n${brief}` : '',
    stack ? `STACK:\n${stack}` : '',
    context ? `Project snapshot (read-only; for naming real files and folders):\n${context}` : '',
  ].filter(Boolean).join('\n\n');
  return { system, user };
}

/** Reads an arranged order. A reply that names no card is refused rather than applied as an empty board. */
export function parseArrangePlan(content: string): { cards: StudioArrangeEntry[] } {
  let json: unknown;
  try {
    json = parseJsonResponse(content, 'Project Studio');
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)} ${replySnippet(content)}`);
  }
  const raw = (json as { cards?: unknown } | null)?.cards;
  if (!Array.isArray(raw)) throw new Error(`The arrange reply had no card list. ${replySnippet(content)}`);
  const cards: StudioArrangeEntry[] = [];
  for (const item of raw) {
    const entry = item as { id?: unknown; dependsOn?: unknown };
    if (typeof entry?.id !== 'string' || !entry.id.trim()) continue;
    const dependsOn = Array.isArray(entry.dependsOn)
      ? entry.dependsOn.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map((id) => id.trim())
      : [];
    cards.push({ id: entry.id.trim(), dependsOn });
  }
  if (cards.length === 0) throw new Error(`The arrange reply named no cards. ${replySnippet(content)}`);
  return { cards };
}

/** Reads the model's reply as markdown content, trimming fences it may have added anyway. */
export function parseArtifact(content: string, kind: ArtifactKind): string {
  let parsed: unknown;
  try {
    parsed = parseJsonResponse(content, 'Project Studio');
  } catch (error) {
    // Some providers ignore the JSON wrapper and answer with the document itself. A document is plain markdown, so
    // accept it as one — unless it opens like JSON, which means a broken wrapper and not a document.
    const plain = content.trim().replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/, '').trim();
    if (plain.length < 20 || /^[{[]/.test(plain)) throw new Error(`${error instanceof Error ? error.message : String(error)} ${replySnippet(content)}`);
    return `${plain}\n`;
  }
  const record = parsed && typeof parsed === 'object' ? (parsed as { content?: unknown }) : {};
  // A model asked for a token file often returns the tokens themselves instead of wrapping them as text.
  if (kind === 'tokens' && typeof record.content !== 'string' && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return `${JSON.stringify(parsed, null, 2)}\n`;
  }
  if (typeof record.content !== 'string' || !record.content.trim()) {
    throw new Error(`The Project Studio reply for ${kind} did not match the expected shape.`);
  }
  return record.content.trim().replace(/^```(?:markdown|md)?\n?/, '').replace(/\n?```$/, '').trim() + '\n';
}

/** Reads the model's reply as a board draft. */
export function parseBoardDraft(content: string) {
  let json: unknown;
  try {
    json = parseJsonResponse(content, 'Project Studio');
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)} ${replySnippet(content)}`);
  }
  const parsed = studioBoardDraftSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`The Project Studio board reply did not match the expected shape (${issue ? `${issue.path.join('.') || 'reply'}: ${issue.message}` : 'unknown error'}).`);
  }
  if (parsed.data.cards.length === 0) throw new Error('The Project Studio board reply had no cards.');
  return parsed.data;
}
