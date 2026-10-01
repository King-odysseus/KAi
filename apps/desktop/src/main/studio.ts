import {
  ARTIFACT_KINDS,
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

/**
 * The rest of the studio: it turns the interview's brief into the artifact set, and the stories into a board of
 * cards. Both are model calls over the Prompt Guide's connection, so the studio still adds no key and no second
 * bill. The one artifact it does not generate is `tokens`, which is pulled from open-pencil — the design tool is
 * the source of truth for tokens, and a model never invents them.
 *
 * Everything it writes goes through `spec-store.ts`, so the copy it replaces is kept and the dependency table
 * decides what goes stale.
 */

/** The artifacts a model writes. `brief` comes from the interview and `tokens` from open-pencil. */
export const MODEL_ARTIFACTS: ArtifactKind[] = ['prd', 'stories', 'stack', 'flows', 'style-guide', 'decisions', 'architecture', 'conventions', 'acceptance', 'risks', 'glossary', 'setup'];

const NAMES = { feature: 'the Project Studio', card: 'Project Studio' };
const GENERATE_CONTEXT_CHARS = 12_000;

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
    for (const kind of ARTIFACT_KINDS) {
      if (!MODEL_ARTIFACTS.includes(kind)) continue;
      const entry = byKind.get(kind);
      if (entry && !entry.stale) continue;
      await this.generate(projectId, kind);
    }
    await this.refreshHandoff(projectId);
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
    const context = await loadProjectContext(root, undefined, GENERATE_CONTEXT_CHARS).catch(() => null);
    const content = await this.ports.requester.structuredRequest(
      settings.promptGuide,
      NAMES,
      artifactPrompt(kind, inputs, context),
      `kai_studio_${kind.replace('-', '_')}`,
      CONTENT_SCHEMA,
      (raw) => parseArtifact(raw, kind),
    );
    return this.ports.artifacts.write(projectId, kind, content, settings.promptGuide.model);
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
    const draft = await this.ports.requester.structuredRequest(
      settings.promptGuide,
      NAMES,
      boardPrompt(brief ?? '', stories, stack ?? '', context),
      'kai_studio_board',
      BOARD_SCHEMA,
      parseBoardDraft,
    );
    const cards = cardsFromDraft(draft, this.ports.now());
    const catalog = await this.ports.artifacts.read(projectId);
    const board = await this.ports.board.replace(projectId, cards, catalog.artifacts);
    await this.refreshHandoff(projectId);
    return board;
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
  async move(projectId: string, cardId: string, status: BoardStatus, note = ''): Promise<BoardCard> {
    const card = await this.ports.board.move(projectId, cardId, status, note, 'user');
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
    if (!ports) throw new Error('open-pencil is not configured. Turn it on in Settings, then pull the design again.');
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
  stories: 'Write the user stories: a numbered list of small, independent stories. Each says who wants it, what they want, and why, then its acceptance criteria as a short list. These become the board cards, so make them small enough for one agent to finish.',
  stack: 'Write the stack document: the languages, frameworks, data store, and hosting, each with the one-line reason it was chosen. Name the concrete packages and versions where it matters, and say where the code lives.',
  flows: 'Write the flows document: the main user journeys end to end, each as an ordered list of steps naming the screens or endpoints they pass through.',
  'style-guide': 'Write the design style guide around the token names that exist: colour, type, spacing and radius. Reference tokens by name; never invent values that contradict the token file.',
  tokens: 'Write the token file.',
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
    '- Order the work: backend and setup first, then shared components, then pages; a page card depends on the endpoint and component cards it needs.',
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

/** Reads the model's reply as markdown content, trimming fences it may have added anyway. */
export function parseArtifact(content: string, kind: ArtifactKind): string {
  let parsed: unknown;
  try {
    parsed = parseJsonResponse(content, 'Project Studio');
  } catch (error) {
    // Some providers ignore the JSON wrapper and answer with the document itself. A document is plain markdown, so
    // accept it as one — unless it opens like JSON, which means a broken wrapper and not a document.
    const plain = content.trim().replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/, '').trim();
    if (plain.length < 20 || /^[{[]/.test(plain)) throw error;
    return `${plain}\n`;
  }
  const record = parsed && typeof parsed === 'object' ? (parsed as { content?: unknown }) : {};
  if (typeof record.content !== 'string' || !record.content.trim()) {
    throw new Error(`The Project Studio reply for ${kind} did not match the expected shape.`);
  }
  return record.content.trim().replace(/^```(?:markdown|md)?\n?/, '').replace(/\n?```$/, '').trim() + '\n';
}

/** Reads the model's reply as a board draft. */
export function parseBoardDraft(content: string) {
  const parsed = studioBoardDraftSchema.safeParse(parseJsonResponse(content, 'Project Studio'));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`The Project Studio board reply did not match the expected shape (${issue ? `${issue.path.join('.') || 'reply'}: ${issue.message}` : 'unknown error'}).`);
  }
  if (parsed.data.cards.length === 0) throw new Error('The Project Studio board reply had no cards.');
  return parsed.data;
}
