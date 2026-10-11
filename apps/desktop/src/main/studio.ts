import {
  ARTIFACT_KINDS,
  STUDIO_STYLE_REFERENCE_NOTES_PATH,
  cardsFromDraft,
  designComponentSchema,
  directDependencies,
  isUiCard,
  renamePageHeading,
  renamedPageName,
  screenTitleKey,
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
  type StudioDesignPull,
  type StudioReadiness,
  type StudioRouteRepairResult,
  type UiCheckResult,
} from '@kai/contracts';
import { loadProjectContext, parseJsonResponse, ReplyShapeError } from './learning-tutor';
import type { StructuredRequester } from './prompt-guide';
import type { StudioArtifacts as ArtifactStore } from './artifacts';
import type { StudioBoardStore } from './board';
import { changedNodes, designErrorMessage, readDesign, type DesignPorts, type DesignRead } from './design-source';
import { deletePageNode, renamePageNode } from './design-ops';
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
function parseRouteSuggestions(raw: string, allowed: BoardCard[]): Array<{ cardId: string; route: string; confidence: 'medium'; reason: string }> {
  const parsed = parseJsonResponse(raw, 'Project Studio') as { routes?: unknown };
  if (!Array.isArray(parsed?.routes)) throw new Error('The route repair reply did not include a routes list.');
  const byId = new Map(allowed.map((card) => [card.id, card]));
  const seen = new Set<string>();
  const routes: Array<{ cardId: string; route: string; confidence: 'medium'; reason: string }> = [];
  for (const item of parsed.routes as Array<{ cardId?: unknown; route?: unknown; reason?: unknown }>) {
    if (typeof item?.cardId !== 'string' || typeof item.route !== 'string' || !byId.has(item.cardId) || seen.has(item.cardId)) continue;
    const route = item.route.trim();
    if (!route.startsWith('/') || route.length > 300 || /\s/.test(route)) continue;
    seen.add(item.cardId);
    routes.push({ cardId: item.cardId, route, confidence: 'medium', reason: typeof item.reason === 'string' ? item.reason.slice(0, 500) : 'Suggested from project context.' });
  }
  return routes;
}
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
    contextChips?: import('@kai/contracts').ContextChip[],
  ): Promise<{ status: 'completed' | 'failed'; output: string; error?: string; costUsd?: number }>;
  /**
   * Stops the turn a design-build step started. Answers whether one was running. Optional for the same reason as
   * the two above.
   */
  cancelDesignAgent?(conversationId: string): boolean;
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
      // Only a reply that could not be read falls back to the stories. A request that never got an answer — signed
      // out, no network, a provider refusing — is reported instead: covering it with a heading-derived board hid the
      // real problem behind a worse result, and the person was left with a thin board and no idea why.
      if (!(error instanceof ReplyShapeError)) throw error;
      const fallback = boardDraftFromStories(stories);
      if (fallback.cards.length === 0) throw error;
      return fallback;
    });
    const pages = await this.ports.artifacts.readText(projectId, 'pages');
    const cards = withRoutesFromPages(cardsFromDraft(draft, this.ports.now()), pages ?? '');
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
   * Sets the route a component or page card is checked at.
   *
   * A card field, not a status, so it goes through neither `move` nor the handoff refresh — but it still goes through
   * the board's own writer, because that is what re-reads the board before writing it.
   */
  async setCardRoute(projectId: string, cardId: string, route: string): Promise<BoardCard> {
    return this.ports.board.setRoute(projectId, cardId, route);
  }

  /** Suggests missing routes by reconciling the pages artifact, pulled design metadata and implementation snapshot. */
  async suggestRouteRepairs(projectId: string): Promise<StudioRouteRepairResult> {
    const board = await this.ports.board.read(projectId);
    const missing = board.cards.filter((card) => card.kind === 'page' && !card.route.trim());
    if (missing.length === 0) return { suggestions: [], unresolved: [] };
    const [pages, root] = await Promise.all([
      this.ports.artifacts.readText(projectId, 'pages'), this.ports.projectRoot(projectId),
    ]);
    const design = await this.ports.board.design(projectId);
    const reconciled = await this.ports.board.applyDesign(projectId, design.components, [], pages ?? '');
    const refreshedMissing = reconciled.cards.filter((card) => card.kind === 'page' && !card.route.trim());
    const indexed = withRoutesFromPages(refreshedMissing, pages ?? '');
    const suggestions = indexed.filter((card) => card.route.trim()).map((card) => ({
      cardId: card.id, route: card.route, confidence: 'high' as const,
      reason: `Matched “${card.title}” to its route in the pages inventory.`,
    }));
    const remaining = refreshedMissing.filter((card) => !suggestions.some((item) => item.cardId === card.id));
    if (remaining.length === 0) return { suggestions, unresolved: [] };
    const settings = await this.ports.settings();
    const context = await loadProjectContext(root, undefined, GENERATE_CONTEXT_CHARS).catch(() => null);
    const schema = { type: 'object', additionalProperties: false, required: ['routes'], properties: { routes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['cardId', 'route', 'reason'], properties: { cardId: { type: 'string' }, route: { type: 'string' }, reason: { type: 'string' } } } } } } as const;
    const parsed = await this.ports.requester.structuredRequest(settings.promptGuide, NAMES, {
      system: 'Suggest routes for unresolved page cards. Use only evidence from the page inventory, pulled design page names, project brief, and source snapshot. Return only JSON. Routes must start with /, must not be guessed from unrelated evidence, and every cardId must be one of those supplied. Leave uncertain screens out.',
      user: [
      `UNRESOLVED CARDS:\n${remaining.map((card) => `${card.id}: ${card.title}\n${card.story}`).join('\n\n')}`,
        `PAGES INVENTORY:\n${pages ?? '(none)'}`, `PULLED DESIGN PAGES:\n${design.components.filter((item) => item.screen).map((item) => `${item.name} (node ${item.id})`).join('\n') || '(none recorded)'}`,
        context ? `PROJECT SOURCE SNAPSHOT:\n${context}` : '',
      ].filter(Boolean).join('\n\n'),
    }, 'kai_studio_route_repair', schema, (raw) => parseRouteSuggestions(raw, remaining), { maxOutputTokens: 3_000 });
    const valid = parsed.filter((entry) => !suggestions.some((item) => item.cardId === entry.cardId));
    return { suggestions: [...suggestions, ...valid], unresolved: remaining.filter((card) => !valid.some((entry) => entry.cardId === card.id)).map((card) => card.id) };
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
  async pullDesign(projectId: string): Promise<{ design: StudioDesign; board: StudioBoard; changed: string[]; tokensChanged: boolean; tokenCount: number; tokensPreserved: boolean; differentDocument: boolean }> {
    const ports = await this.ports.openPencil?.();
    if (!ports) throw new Error('open-pencil is not connected. Set it up under Settings, Design tools, then pull the design again.');
    const previous = await this.ports.board.design(projectId);
    let read: DesignRead;
    try {
      read = await readDesign(ports);
    } catch (error) {
      throw new Error(designErrorMessage(error));
    }
    // The editor holds whatever document it was last opened on, and KAI reads that one. Opening a different
    // project's file and pulling used to fold its pages and tokens into this project: its pages marked this
    // project's screens drawn, and its tokens replaced this project's. Nothing recorded which document a pull came
    // from, so nothing could tell.
    //
    // A page's node id is stable within its document, so two documents sharing no page id are two documents. Adding
    // or removing a page keeps the rest, which is why this asks for any overlap rather than an exact set — a rename
    // or an edit inside the document must not read as a different one.
    const previousPages = new Set(previous.components.filter((component) => component.screen).map((component) => component.id));
    const currentPages = read.components.filter((component) => component.screen).map((component) => component.id);
    const idsOverlap = currentPages.some((id) => previousPages.has(id));
    // The ids are not always stable: reopening or re-importing the same file numbers its pages again, and the same
    // pages arrive under new ids. Page names settle that case, but only when nearly all of them are here — a stranger's
    // file can easily share one page called "Sign in", and must still be refused.
    const sameByName = !idsOverlap && sharesTheseScreens(
      previous.components.filter((component) => component.screen).map((component) => component.name),
      read.components.filter((component) => component.screen).map((component) => component.name),
    );
    if (previousPages.size > 0 && currentPages.length > 0 && !idsOverlap && !sameByName) {
      return {
        design: previous,
        board: await this.ports.board.read(projectId),
        changed: [],
        tokensChanged: false,
        tokenCount: read.tokenCount,
        tokensPreserved: false,
        differentDocument: true,
      };
    }
    // Hashes are keyed by node id, so a document that was renumbered has nothing to compare against: every node would
    // read as changed and every card as stale. The cards are matched to the new ids by name just below instead.
    const changed = sameByName ? [] : changedNodes(previous.hashes, read.hashes);
    const tokens = `${JSON.stringify(read.tokens, null, 2)}\n`;
    // Only a real change writes: pulling the same design twice must not bump the artifact's version.
    const hadTokens = await this.ports.artifacts.readText(projectId, 'tokens');
    // A pull that read nothing must not empty a token file the project already has. That is what an editor open on
    // the wrong document, or on a blank one, looks like — and it used to write `{}` over the tokens the foundation
    // prompt reads. Worse, the artifact then counted as written by open-pencil, so "generate all" skipped it and the
    // real tokens were never written back.
    const wouldWipe = read.tokenCount === 0 && Boolean(hadTokens?.trim()) && hadTokens?.trim() !== '{}';
    const tokensChanged = !wouldWipe && tokens !== hadTokens;
    if (tokensChanged) await this.ports.artifacts.write(projectId, 'tokens', tokens, 'open-pencil');
    const design = await this.ports.board.saveDesign(projectId, {
      schemaVersion: 1,
      endpoint: ports.endpoint(),
      pulledAt: this.ports.now(),
      treeHash: read.treeHash,
      hashes: read.hashes,
      components: read.components.map((component) => designComponentSchema.parse(component)),
    });
    const pages = await this.ports.artifacts.readText(projectId, 'pages');
    const board = await this.ports.board.applyDesign(projectId, read.components, changed, pages ?? '');
    return { design, board, changed, tokensChanged, tokenCount: read.tokenCount, tokensPreserved: wouldWipe, differentDocument: false };
  }

  /**
   * Renames one screen in the two places its name lives: its `pages.md` heading and, when it is drawn, its open-pencil
   * page. Both, or the checklist stops matching — a row reads as drawn only while its name reduces to the same key as
   * the page's, so renaming one side alone turns a drawn screen back into "to draw" and a second, unplanned row.
   *
   * The route is left alone: it lives in the section body, which the splice never touches, so a rename is a rename
   * and not a reroute. The file edit is worked out before the editor is called, so a name that matches no heading
   * fails with nothing renamed.
   *
   * A screen that is only in open-pencil — a stray page the build drew under a name the pages list does not carry —
   * has no heading to splice. It is renamed in the editor alone, which is how such a page is brought back under a
   * planned screen's name so the row turns drawn.
   */
  async renameDesignPage(projectId: string, currentName: string, name: string): Promise<StudioDesignPull> {
    const ports = await this.ports.openPencil?.();
    if (!ports) throw new Error('open-pencil is not connected. Set it up under Settings, Design tools, then try again.');
    const previous = await this.ports.board.design(projectId);
    const key = screenTitleKey(currentName);
    const page = previous.components.find((component) => component.screen && screenTitleKey(component.name) === key);
    // The prefix follows the name the person is editing — the heading, or the page name for a stray — so a heading
    // that read `/sign-in — Sign in` keeps its `/sign-in —` and only the screen's name changes.
    const nextName = renamedPageName(currentName, name);
    const pagesText = await this.ports.artifacts.readText(projectId, 'pages');
    const splice = pagesText === null ? null : renamePageHeading(pagesText, key, nextName);
    if (!splice?.renamed && !page) {
      throw new Error(`There is no screen named "${currentName}" to rename, in the pages list or in open-pencil.`);
    }
    if (page) {
      try {
        await renamePageNode(ports, page.id, nextName);
      } catch (error) {
        throw new Error(designErrorMessage(error));
      }
    }
    if (splice?.renamed) await this.saveArtifact(projectId, 'pages', splice.markdown);
    const pulled = await this.pullDesign(projectId);
    // The pull re-attaches the card by the page's id, which a rename does not move, so the title is set after it —
    // `mergeDesign` leaves an existing card's title as it found it, by design.
    return page ? { ...pulled, board: await this.ports.board.retitleDesignPage(projectId, page.id, nextName) } : pulled;
  }

  /**
   * Deletes one screen's page from open-pencil, with everything drawn on it. This is the direct answer to a page that
   * errored or is named so nothing matches it — the build loop's "Fix & redraw" asks an agent to delete "whatever is
   * in the way", a guess, where this deletes the exact node the pull identified.
   *
   * Only open-pencil is touched. The screen stays in `pages.md`, so it reads as still to draw: that is the recovery
   * path, and it is why the board card is kept rather than removed, flagged with the reason instead of dropped.
   */
  async deleteDesignPage(projectId: string, pageId: string): Promise<StudioDesignPull> {
    const ports = await this.ports.openPencil?.();
    if (!ports) throw new Error('open-pencil is not connected. Set it up under Settings, Design tools, then try again.');
    const previous = await this.ports.board.design(projectId);
    const page = previous.components.find((component) => component.screen && component.id === pageId);
    if (!page) throw new Error('That screen is not part of this project\'s design. Pull the design again, then delete it.');
    try {
      await deletePageNode(ports, pageId);
    } catch (error) {
      throw new Error(designErrorMessage(error));
    }
    const pulled = await this.pullDesign(projectId);
    return {
      ...pulled,
      board: await this.ports.board.detachDesignPage(projectId, pageId, `The open-pencil page "${page.name}" was deleted in KAI. Draw the screen again.`),
    };
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

  /** Runs a conversational design correction with project, board and Open Pencil context attached. */
  async chatDesign(projectId: string, message: string, imageDataUrl: string | undefined, stepId: string,
    onEvent?: (event: PersistedEvent) => void): Promise<{ status: 'completed' | 'failed'; output: string; error?: string; costUsd?: number }> {
    if (!this.ports.ensureOpenPencilRunning || !this.ports.runDesignAgent) throw new Error('The design chat is not available in this build.');
    await this.ports.ensureOpenPencilRunning();
    const [root, pages, board, design] = await Promise.all([
      this.ports.projectRoot(projectId), this.ports.artifacts.readText(projectId, 'pages'),
      this.ports.board.read(projectId), this.ports.board.design(projectId),
    ]);
    const context = await loadProjectContext(root, undefined, 10_000).catch(() => null);
    const prompt = [
      'You are the Design assistant inside this Project Studio. Treat this as a continuing conversation and act on the user’s correction. Inspect Open Pencil before claiming a page is missing. If the page already exists, identify it by name/node id and report that you found it; do not redraw or delete it unless asked. Never claim success unless the Open Pencil tools confirm the change.',
      `USER MESSAGE:\n${message}`,
      `PROJECT PAGE INVENTORY:\n${pages ?? '(none)'}`,
      `BOARD SCREENS:\n${board.cards.filter((card) => card.kind === 'page').map((card) => `${card.id}: ${card.title} | route=${card.route || '(missing)'} | designRef=${card.designRef ?? '(none)'}`).join('\n') || '(none)'}`,
      `LAST PULLED OPEN PENCIL PAGES:\n${design.components.filter((item) => item.screen).map((item) => `${item.name} | node=${item.id}`).join('\n') || '(none recorded; inspect live Open Pencil)'}`,
      context ? `PROJECT SOURCE CONTEXT:\n${context}` : '',
      imageDataUrl ? `SCREENSHOT ATTACHED (inspect it as visual evidence): ${imageDataUrl.slice(0, 80)}…` : '',
      'After any Open Pencil change, report exactly what changed and remind the user to pull the design so the board and project record reconcile.',
    ].filter(Boolean).join('\n\n');
    const contextChips: import('@kai/contracts').ContextChip[] | undefined = imageDataUrl ? [{ type: 'image', path: 'studio-screenshot', name: 'Design screenshot', dataUrl: imageDataUrl }] : undefined;
    return this.ports.runDesignAgent(prompt, root, stepId, onEvent, contextChips);
  }

  /** Stops the turn one design-build step is running. Answers false when it had already finished. */
  cancelDesignStep(stepId: string): boolean {
    return this.ports.cancelDesignAgent?.(stepId) ?? false;
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

/**
 * Whether the pages now in the editor are the pages this project was drawn from, judged by name. Nearly all of the
 * recorded screens have to be there — all of them when there are only a few — so one name two projects happen to share
 * is never enough.
 */
export function sharesTheseScreens(recorded: readonly string[], current: readonly string[]): boolean {
  const before = new Set(recorded.map(screenTitleKey).filter(Boolean));
  if (before.size === 0) return false;
  const now = new Set(current.map(screenTitleKey));
  const shared = [...before].filter((key) => now.has(key)).length;
  const needed = before.size < 3 ? before.size : Math.ceil(before.size * 0.8);
  return shared > 0 && shared >= needed;
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

/**
 * The list of cards in an arrange reply, under whatever key the model chose. The schema asks for `cards`, but a
 * model that returned `order`, `arrangement` or a bare list was still answering the question, so the list is found
 * rather than demanded by name: `cards` first, then the first value, at most two levels in, that is a list of
 * cards or of ids.
 */
function findArrangeList(json: unknown, depth = 0): unknown[] | null {
  const looksLikeCards = (list: unknown[]): boolean => list.length > 0 && list.every((item) => typeof item === 'string' || (item !== null && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string'));
  if (Array.isArray(json)) return looksLikeCards(json) ? json : null;
  if (!json || typeof json !== 'object' || depth > 2) return null;
  const record = json as Record<string, unknown>;
  if (Array.isArray(record.cards)) return record.cards;
  for (const value of Object.values(record)) {
    const found = findArrangeList(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Reads an arranged order. A reply that names no card is refused rather than applied as an empty board. */
export function parseArrangePlan(content: string): { cards: StudioArrangeEntry[] } {
  let json: unknown;
  try {
    json = parseJsonResponse(content, 'Project Studio');
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)} ${replySnippet(content)}`);
  }
  const raw = findArrangeList(json);
  if (!raw) throw new Error(`The arrange reply had no card list. ${replySnippet(content)}`);
  const cards: StudioArrangeEntry[] = [];
  for (const item of raw) {
    // A bare id is a card with no dependencies named: some models answer with just the order.
    if (typeof item === 'string') {
      if (item.trim()) cards.push({ id: item.trim(), dependsOn: [] });
      continue;
    }
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

/** The routes the pages document gives: a "## Name" heading, then a "Route:" line with the path in backticks. */
export function routesFromPagesDocument(pages: string): Array<{ name: string; route: string }> {
  const found: Array<{ name: string; route: string }> = [];
  let name = '';
  for (const line of pages.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) { name = heading[1] ?? ''; continue; }
    const route = name ? /Route:?\*{0,2}:?\s*`(\/[^`\s]*)`/i.exec(line) : null;
    if (route?.[1] && !route[1].includes('*')) { found.push({ name, route: route[1] }); name = ''; }
  }
  return found;
}

const wordsOf = (text: string): Set<string> => new Set(text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((word) => word.length > 2 && !['the', 'and', 'page', 'screen', 'with', 'for'].includes(word)));

/**
 * A screen card the model left without a route gets the one its page has in the pages document, when the names
 * agree closely enough to be the same screen. A card with no route can never pass its screen check, and a person
 * should not have to type thirteen paths the document already holds. Cards that already have a route are untouched.
 */
export function withRoutesFromPages(cards: BoardCard[], pages: string): BoardCard[] {
  const known = routesFromPagesDocument(pages).map((page) => ({ ...page, words: wordsOf(page.name) }));
  if (known.length === 0) return cards;
  return cards.map((card) => {
    if (!isUiCard(card) || card.route.trim()) return card;
    const own = wordsOf(card.title);
    if (own.size === 0) return card;
    let best: { route: string; score: number } | null = null;
    for (const page of known) {
      const shared = [...own].filter((word) => page.words.has(word)).length;
      const score = shared / Math.min(own.size, Math.max(page.words.size, 1));
      if (shared > 0 && score >= 0.6 && (!best || score > best.score)) best = { route: page.route, score };
    }
    return best ? { ...card, route: best.route } : card;
  });
}

/** Reads the model's reply as a board draft. */
export function parseBoardDraft(content: string) {
  let json: unknown;
  try {
    json = parseJsonResponse(content, 'Project Studio');
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)} ${replySnippet(content)}`);
  }
  // Models wrap the cards with a title, a summary or a bare array; only the cards matter, so ignore the rest
  // instead of failing the whole board on a key nobody asked for.
  const cards = Array.isArray(json) ? json : json && typeof json === 'object' ? (json as { cards?: unknown }).cards : undefined;
  const parsed = studioBoardDraftSchema.safeParse({ cards });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ReplyShapeError(`The Project Studio board reply did not match the expected shape (${issue ? `${issue.path.join('.') || 'reply'}: ${issue.message}` : 'unknown error'}).`);
  }
  if (parsed.data.cards.length === 0) throw new ReplyShapeError('The Project Studio board reply had no cards.');
  return parsed.data;
}
