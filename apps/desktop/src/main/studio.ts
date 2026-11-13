import {
  ARTIFACT_KINDS,
  CARD_KINDS,
  STUDIO_STYLE_REFERENCE_NOTES_PATH,
  appendPageSection,
  appendStorySection,
  boardCardSchema,
  cardsFromDraft,
  defaultNeeds,
  designComponentSchema,
  directDependencies,
  isUiCard,
  newPageHeading,
  parsePages,
  removePageSection,
  renamePageHeading,
  renamedPageName,
  routeFromScreenName,
  findScreen,
  screenTitleKey,
  setPageRoute,
  studioBoardDraftSchema,
  studioPlanActionSchema,
  type AppSettings,
  type ArtifactKind,
  type BoardCard,
  type BoardStatus,
  type CardCheck,
  type CardRun,
  type PersistedEvent,
  type StudioArtifacts,
  type StudioArtifactsGenerationResult,
  type StudioBoard,
  type StudioDesign,
  type StudioDesignStatus,
  type StudioDesignPull,
  type StudioPlanAction,
  type StudioPlanApplyResult,
  type StudioPlanChatResult,
  type StudioPlanIntent,
  type StudioPlanStage,
  type StudioReadiness,
  type StudioRouteRepairResult,
  type UiCheckResult,
  dependencyBlocks,
  lacksRoute,
} from '@kai/contracts';
import { loadProjectContext, parseJsonResponse, ReplyShapeError } from './learning-tutor';
import type { StructuredRequester } from './prompt-guide';
import type { StudioArtifacts as ArtifactStore } from './artifacts';
import { withPlanRoutes, type StudioBoardStore } from './board';
import { changedNodes, designErrorMessage, readDesign, type DesignPorts, type DesignRead } from './design-source';
import { deletePageNode, renamePageNode, switchToPage } from './design-ops';
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

function normalizeRouteKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Pair explicit route declarations with nearby component names; never invent a route from a screen title alone. */
function routesInSource(source: string): Array<{ route: string; keys: string[] }> {
  const found = new Map<string, Set<string>>();
  const patterns = [
    /<Route\b[^>]*\bpath=["']([^"']+)["'][^>]*\belement=\{\s*<([A-Z][\w.]*)/g,
    /\{\s*path:\s*["']([^"']+)["'][\s\S]{0,240}?element:\s*<([A-Z][\w.]*)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const route = match[1].startsWith('/') ? match[1] : `/${match[1]}`;
      const keys = found.get(route) ?? new Set<string>();
      keys.add(normalizeRouteKey(match[2].split('.').at(-1) ?? match[2]));
      keys.add(normalizeRouteKey(route.split('/').filter(Boolean).at(-1) ?? 'home'));
      found.set(route, keys);
    }
  }
  return [...found].map(([route, keys]) => ({ route, keys: [...keys].filter((key) => key.length >= 4) }));
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
   * A look at open-pencil that never launches it: whether it is running, whether KAI's connection is accepted, and the
   * pages it holds. Optional so a test that never asks for the status can leave it out.
   */
  openPencilStatus?(): Promise<{ state: 'running'; pages: Array<{ id: string; name: string }> } | { state: 'not-running' | 'not-configured' | 'token-mismatch' | 'unreachable' }>;
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
  /**
   * One screenshot of whatever open-pencil's editor is showing at this endpoint, for the Design tab's per-page
   * preview. Optional for the same reason as `ensureOpenPencilRunning`: a build without it simply cannot offer a
   * preview, rather than failing to construct.
   */
  screenshotDesignPage?(endpoint: string): Promise<string>;
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

  /** Adds cards to the board, leaving existing ones as they are. */
  addCards(projectId: string, cards: readonly BoardCard[]): Promise<{ board: StudioBoard; added: string[] }> {
    return this.ports.board.append(projectId, cards);
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

  /**
   * Generates the chosen artifacts only, in dependency order, and reports what it could not write instead of
   * throwing on the first failure. This is what "just the design" is: style guide, tokens and pages, without the
   * PRD and stories the person did not ask for.
   */
  async generateSelected(projectId: string, kinds: readonly ArtifactKind[]): Promise<StudioArtifactsGenerationResult> {
    const readiness = await this.ports.interview.readiness();
    if (!readiness.ready) throw new Error(readiness.reason ?? 'The Project Studio is not ready.');
    const selected = new Set(kinds);
    const order = ARTIFACT_KINDS.filter((kind) => selected.has(kind) && MODEL_ARTIFACTS.includes(kind));
    if (order.length === 0) throw new Error('Choose at least one artifact that a model writes.');
    const failed = new Map<ArtifactKind, string>();
    const wrote: ArtifactKind[] = [];
    for (const kind of order) {
      // A chosen artifact whose chosen input failed is reported as blocked rather than attempted on an empty input.
      const blockedBy = directDependencies(kind).find((dependency) => selected.has(dependency) && failed.has(dependency));
      if (blockedBy) {
        failed.set(kind, `it is built from ${blockedBy}, which could not be written`);
        continue;
      }
      try {
        await this.generate(projectId, kind);
        wrote.push(kind);
      } catch (error) {
        failed.set(kind, error instanceof Error ? error.message : String(error));
      }
    }
    await this.refreshHandoff(projectId);
    return {
      artifacts: await this.ports.artifacts.read(projectId),
      wrote,
      failed: [...failed].map(([kind, reason]) => ({ kind, reason })),
    };
  }

  /** Generates one artifact from the artifacts it reads, then updates the catalog. */
  async generate(projectId: string, kind: ArtifactKind): Promise<StudioArtifacts> {
    const settings = await this.ports.settings();
    const root = await this.ports.projectRoot(projectId);
    const inputs: Record<string, string> = {};
    // Design-only plans have no stories or stack. The pages and the style guide can still be written from the
    // brief, so those two treat the missing input as absent rather than as a reason to refuse. Everything else
    // keeps the strict rule: it is built from its inputs, not from a guess.
    const fallbackDependencies = new Set<string>(kind === 'pages' ? ['stories', 'flows'] : kind === 'style-guide' ? ['stack'] : []);
    const brief = fallbackDependencies.size > 0 ? (await this.ports.artifacts.readText(projectId, 'brief')) ?? '' : '';
    for (const dependency of directDependencies(kind)) {
      const text = (await this.ports.artifacts.readText(projectId, dependency)) ?? '';
      if (!text.trim() && fallbackDependencies.has(dependency) && brief.trim()) {
        inputs[dependency] = `(${dependency} has not been written. Build this from the brief alone, which follows.)\n\n${brief}`;
      } else inputs[dependency] = text;
    }
    const missing = Object.entries(inputs).filter(([, text]) => !text.trim()).map(([name]) => name);
    if (missing.length > 0) throw new Error(`Write ${missing.join(', ')} first: ${kind} is built from it.`);
    if (kind === 'pages') {
      // Regenerating the inventory must not drop a screen that was added by hand, or one already drawn under a name
      // the model would not invent. Both are given as inputs and named in the prompt as things to keep.
      const existing = await this.ports.artifacts.readText(projectId, 'pages');
      if (existing?.trim()) {
        inputs['the current pages inventory (keep every screen it has and add anything missing)'] = existing;
      }
      const design = await this.ports.board.design(projectId);
      const drawn = design.components.filter((component) => component.screen).map((component) => `- ${component.name}`);
      if (drawn.length > 0) {
        inputs['screens already drawn in open-pencil (keep these names in the inventory)'] = drawn.join('\n');
      }
    }
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

  async markCardNotAScreen(projectId: string, cardId: string): Promise<BoardCard> {
    return this.ports.board.markNotAScreen(projectId, cardId);
  }

  /** Suggests missing routes by reconciling the pages artifact, pulled design metadata and implementation snapshot. */
  async suggestRouteRepairs(projectId: string): Promise<StudioRouteRepairResult> {
    const board = await this.ports.board.read(projectId);
    const missing = board.cards.filter(lacksRoute);
    if (missing.length === 0) return { suggestions: [], unresolved: [] };
    const [pages, root] = await Promise.all([
      this.ports.artifacts.readText(projectId, 'pages'), this.ports.projectRoot(projectId),
    ]);
    const design = await this.ports.board.design(projectId);
    const reconciled = await this.ports.board.applyDesign(projectId, design.components, [], pages ?? '');
    const refreshedMissing = reconciled.cards.filter(lacksRoute);
    const indexed = withRoutesFromPages(refreshedMissing, pages ?? '');
    const suggestions = indexed.filter((card) => card.route.trim()).map((card) => ({
      cardId: card.id, route: card.route, confidence: 'high' as const,
      reason: `Matched “${card.title}” to its route in the pages inventory.`,
    }));
    const remaining = refreshedMissing.filter((card) => !suggestions.some((item) => item.cardId === card.id));
    if (remaining.length === 0) return { suggestions, unresolved: [] };
    const namedRoutes = remaining.flatMap((card) => {
      const route = routeFromScreenName(card.title);
      return route ? [{ cardId: card.id, route, confidence: 'high' as const, reason: `Read the explicit route in the OpenPencil screen name “${card.title}”.` }] : [];
    });
    const stillMissing = remaining.filter((card) => !namedRoutes.some((item) => item.cardId === card.id));
    if (stillMissing.length === 0) return { suggestions: [...suggestions, ...namedRoutes], unresolved: [] };
    const settings = await this.ports.settings();
    const context = await loadProjectContext(root, undefined, GENERATE_CONTEXT_CHARS).catch(() => null);
    const sourceRoutes = routesInSource(context ?? '');
    const sourceMatches = stillMissing.flatMap((card) => {
      const title = normalizeRouteKey(card.title);
      const matches = sourceRoutes.filter((entry) => entry.keys.some((key) => key === title || key.includes(title) || title.includes(key)));
      const match = matches.length === 1 ? matches[0] : undefined;
      return match ? [{ cardId: card.id, route: match.route, confidence: 'high' as const, reason: `Matched “${card.title}” to the route and screen component in the project source.` }] : [];
    });
    const covered = new Set([...suggestions, ...namedRoutes, ...sourceMatches].map((entry) => entry.cardId));
    const unresolvedBySource = stillMissing.filter((card) => !covered.has(card.id));
    if (unresolvedBySource.length === 0) {
      return { suggestions: [...suggestions, ...namedRoutes, ...sourceMatches], unresolved: [] };
    }
    const schema = { type: 'object', additionalProperties: false, required: ['routes'], properties: { routes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['cardId', 'route', 'reason'], properties: { cardId: { type: 'string' }, route: { type: 'string' }, reason: { type: 'string' } } } } } } as const;
    let valid: ReturnType<typeof parseRouteSuggestions> = [];
    try {
      valid = await this.ports.requester.structuredRequest(settings.promptGuide, NAMES, {
        system: 'Suggest routes for unresolved page cards. Use only supplied evidence. Routes start with /. Return only JSON. Leave uncertain cards out.',
        user: [
          `UNRESOLVED CARDS:\n${unresolvedBySource.map((card) => `${card.id}: ${card.title}\n${card.story.slice(0, 500)}`).join('\n\n')}`,
          `PAGES INVENTORY:\n${(pages ?? '').slice(0, 4_000)}`,
          `PULLED DESIGN PAGES:\n${design.components.filter((item) => item.screen).map((item) => item.name).join('\n') || '(none recorded)'}`,
          context ? `PROJECT SOURCE ROUTES:\n${context.slice(0, 4_000)}` : '',
        ].filter(Boolean).join('\n\n'),
      }, 'kai_studio_route_repair', schema, (raw) => parseRouteSuggestions(raw, unresolvedBySource), { maxOutputTokens: 1_200 });
    } catch (error) {
      // Reasoning models can spend the entire output budget before returning JSON. Keep source and inventory matches
      // and report the remaining cards instead of surfacing an unrelated generic tutor error.
      if (!(error instanceof ReplyShapeError) && !/no tutor content|finish_reason:?\s*length|output budget|reasoning.*whole/i.test(error instanceof Error ? error.message : String(error))) throw error;
    }
    const all = [...suggestions, ...namedRoutes, ...sourceMatches, ...valid];
    const ids = new Set(all.map((item) => item.cardId));
    return { suggestions: all, unresolved: remaining.filter((card) => !ids.has(card.id)).map((card) => card.id) };
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
      visual: result.outcomes.some((item) => item.status === 'failed' || (item.status === undefined && !item.passed))
        ? 'failed'
        : result.passed ? 'passed' : 'unknown',
      screenshots: result.screenshots,
      // `setCheck` replaces the whole record, so leaving this out dropped the evidence the build check had just
      // recorded for every criterion. The board then refused to close each page whose screen check passed ("lacks
      // passing evidence: It matches the design node it was drawn from"), and Autopilot spent three attempts a card
      // on work that was already done before parking it.
      ...(card.check?.acceptanceEvidence ? { acceptanceEvidence: card.check.acceptanceEvidence } : {}),
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

  async reviewBoardCard(projectId: string, cardId: string, verdict: 'accept' | 'reject'): Promise<BoardCard> {
    const card = await this.ports.board.reviewCard(projectId, cardId, verdict);
    await this.refreshHandoff(projectId);
    return card;
  }

  async setBoardAcceptanceRequired(projectId: string, required: boolean): Promise<StudioBoard> {
    const board = await this.ports.board.setAcceptanceRequired(projectId, required);
    await this.refreshHandoff(projectId);
    return board;
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

  /**
   * Whether open-pencil can be read, and whether it still holds the pages the last pull recorded. The Design tab shows
   * it and pulls on its own when the editor changes, so a design redrawn in open-pencil is noticed without a button.
   */
  /** A look at open-pencil that never launches it and never switches its page: its state and the pages it holds. */
  async openPencilLook(): Promise<NonNullable<Awaited<ReturnType<NonNullable<StudioPorts['openPencilStatus']>>>>> {
    return (await this.ports.openPencilStatus?.()) ?? { state: 'not-configured' };
  }

  /** Opens open-pencil when it is not already open, and reconnects to it. */
  async openPencilEnsure(): Promise<void> {
    await this.ports.ensureOpenPencilRunning?.();
  }

  /** One design prompt as a real agent turn with open-pencil's tools, through the provider the user configured. */
  async designAgentTurn(prompt: string, projectRoot: string, conversationId: string): Promise<{ status: 'completed' | 'failed'; output: string; error?: string; costUsd?: number }> {
    if (!this.ports.runDesignAgent) return { status: 'failed', output: '', error: 'No design agent is set up. Choose a provider under Settings, Design tools.' };
    return this.ports.runDesignAgent(prompt, projectRoot, conversationId);
  }

  async designStatus(projectId: string): Promise<StudioDesignStatus> {
    const stored = await this.ports.board.design(projectId);
    const pulledAt = stored.components.length > 0 ? stored.pulledAt : null;
    const seen = await this.ports.openPencilStatus?.() ?? { state: 'not-configured' as const };
    const words: Record<string, string> = {
      'not-running': 'open-pencil is not running. Start it, or press Pull the design and KAI will launch it.',
      'not-configured': 'open-pencil is not set up. Add it under Settings, Design tools.',
      'token-mismatch': 'open-pencil refused the token KAI holds. It was restarted; press Pull the design to reconnect.',
      unreachable: 'open-pencil is open but is not answering.',
    };
    if (seen.state !== 'running') return { state: seen.state, message: words[seen.state]!, livePages: null, inSync: null, pulledAt };
    const live = new Set(seen.pages.map((page) => `${page.id}|${page.name}`));
    const recorded = new Set(stored.components.filter((component) => component.screen).map((component) => `${component.id}|${component.name}`));
    const inSync = recorded.size === live.size && [...live].every((entry) => recorded.has(entry));
    return {
      state: 'running',
      message: inSync ? 'open-pencil is running and matches the last pull.' : 'open-pencil holds different pages from the last pull.',
      livePages: seen.pages.length,
      inSync,
      pulledAt,
    };
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
  async pullDesign(projectId: string, options: { adopt?: boolean } = {}): Promise<{ design: StudioDesign; board: StudioBoard; changed: string[]; tokensChanged: boolean; tokenCount: number; tokensPreserved: boolean; differentDocument: boolean }> {
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
    // `adopt` is the person saying the editor's document is the one they mean now — a design restarted from scratch has
    // new ids and often new names, and without a way to accept it every pull was refused for good.
    if (!options.adopt && previousPages.size > 0 && currentPages.length > 0 && !idsOverlap && !sameByName) {
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
    const adopting = Boolean(options.adopt) && previousPages.size > 0 && !idsOverlap;
    const changed = sameByName || adopting ? [] : changedNodes(previous.hashes, read.hashes);
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
    const board = await this.ports.board.applyDesign(projectId, read.components, changed, pages ?? '', adopting);
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
    const stored = await this.ports.board.design(projectId);
    const key = screenTitleKey(currentName);
    const findPage = (design: StudioDesign) => findScreen(design.components.filter((component) => component.screen), (component) => component.name, currentName);
    // A page drawn since the last pull is only in the editor. Falling back to a live read is what lets the Studio
    // chat link the page the person just drew, without making them pull first.
    const page = findPage(stored) ?? findPage(await this.currentDesignSoon(projectId));
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
    const stored = await this.ports.board.design(projectId);
    const findPage = (design: StudioDesign) => design.components.find((component) => component.screen && component.id === pageId);
    const page = findPage(stored) ?? findPage(await this.currentDesignSoon(projectId));
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
   * A screenshot of one page exactly as open-pencil currently shows it, for the Design tab's per-page preview.
   * Switches the editor to the page first — open-pencil has no per-page screenshot tool of its own, so what the
   * shared browser captures is only the right page because the editor was put on it immediately beforehand.
   */
  async capturePageScreenshot(projectId: string, pageId: string): Promise<{ dataUrl: string }> {
    const ports = await this.ports.openPencil?.();
    if (!ports) throw new Error('open-pencil is not connected. Set it up under Settings, Design tools, then try again.');
    if (!this.ports.screenshotDesignPage) throw new Error('Screenshots are not available in this build.');
    try {
      await switchToPage(ports, pageId);
    } catch (error) {
      throw new Error(designErrorMessage(error));
    }
    const base64 = await this.ports.screenshotDesignPage(ports.endpoint());
    return { dataUrl: `data:image/png;base64,${base64}` };
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

  /**
   * Runs a conversational design correction with project, board and Open Pencil context attached.
   *
   * `pageName` scopes the whole turn to one screen: when given, the prompt carries only that page's board card and
   * drawn component instead of the full project dump, and the model is told in so many words not to touch anything
   * else. A correction to one page used to arrive with the entire page inventory, every board card and every drawn
   * screen beside it — context the model did not need and, worse, an invitation to "fix" something nobody asked
   * about. Left out (the default), this behaves exactly as the whole-project chat always has.
   */
  async chatDesign(projectId: string, message: string, imageDataUrl: string | undefined, stepId: string,
    onEvent?: (event: PersistedEvent) => void, pageName?: string): Promise<{ status: 'completed' | 'failed'; output: string; error?: string; costUsd?: number }> {
    if (!this.ports.ensureOpenPencilRunning || !this.ports.runDesignAgent) throw new Error('The design chat is not available in this build.');
    await this.ports.ensureOpenPencilRunning();
    const [root, pages, board, design] = await Promise.all([
      this.ports.projectRoot(projectId), this.ports.artifacts.readText(projectId, 'pages'),
      this.ports.board.read(projectId), this.ports.board.design(projectId),
    ]);
    const context = await loadProjectContext(root, undefined, 10_000).catch(() => null);
    const pageCards = board.cards.filter((card) => card.kind === 'page');
    const screens = design.components.filter((item) => item.screen);
    const scope = pageName ? findScreen(pageCards, (card) => card.title, pageName) : undefined;
    const scopedScreen = pageName ? findScreen(screens, (item) => item.name, pageName) : undefined;
    const prompt = [
      pageName
        ? `You are the Design assistant inside this Project Studio, scoped to ONE page: "${pageName}". Treat this as a continuing conversation about that page only and act on the user's correction there. Do not redraw, rename or delete any other page, and do not touch the project plan or other screens even if they look related. Inspect Open Pencil before claiming the page is missing. If it already exists, identify it by name/node id and report that you found it; do not redraw it unless asked. Never claim success unless the Open Pencil tools confirm the change.`
        : 'You are the Design assistant inside this Project Studio. Treat this as a continuing conversation and act on the user’s correction. Inspect Open Pencil before claiming a page is missing. If the page already exists, identify it by name/node id and report that you found it; do not redraw or delete it unless asked. Never claim success unless the Open Pencil tools confirm the change.',
      `USER MESSAGE:\n${message}`,
      pageName
        ? `THE PAGE IN SCOPE:\n${scope ? `${scope.id}: ${scope.title} | route=${scope.route || '(missing)'} | designRef=${scope.designRef ?? '(none)'}` : `"${pageName}" is not on the board yet.`}`
        : `PROJECT PAGE INVENTORY:\n${pages ?? '(none)'}`,
      pageName
        ? `THIS PAGE AS LAST PULLED FROM OPEN PENCIL:\n${scopedScreen ? `${scopedScreen.name} | node=${scopedScreen.id}` : '(not recorded; inspect live Open Pencil)'}`
        : `BOARD SCREENS:\n${pageCards.map((card) => `${card.id}: ${card.title} | route=${card.route || '(missing)'} | designRef=${card.designRef ?? '(none)'}`).join('\n') || '(none)'}\n\nLAST PULLED OPEN PENCIL PAGES:\n${screens.map((item) => `${item.name} | node=${item.id}`).join('\n') || '(none recorded; inspect live Open Pencil)'}`,
      context ? `PROJECT SOURCE CONTEXT:\n${context}` : '',
      imageDataUrl ? `SCREENSHOT ATTACHED (inspect it as visual evidence): ${imageDataUrl.slice(0, 80)}…` : '',
      'After any Open Pencil change, report exactly what changed and remind the user to pull the design so the board and project record reconcile.',
    ].filter(Boolean).join('\n\n');
    const contextChips: import('@kai/contracts').ContextChip[] | undefined = imageDataUrl ? [{ type: 'image', path: 'studio-screenshot', name: 'Design screenshot', dataUrl: imageDataUrl }] : undefined;
    return this.ports.runDesignAgent(prompt, root, stepId, onEvent, contextChips);
  }

  /**
   * The Studio chat: the person says what a drawn page is, or what is missing from the plan, and the model answers
   * with a change set instead of writing anything. Approving the set is a separate call, so nothing is rewritten on
   * the strength of a sentence the person did not mean.
   */
  async planChat(
    projectId: string,
    message: string,
    intent: StudioPlanIntent = 'feature',
    onStage?: (stage: StudioPlanStage) => void,
  ): Promise<StudioPlanChatResult> {
    onStage?.('reading-plan');
    try {
      const readiness = await this.ports.interview.readiness();
      if (!readiness.ready) throw new Error(readiness.reason ?? 'The Project Studio is not ready.');
      const settings = await this.ports.settings();
      const root = await this.ports.projectRoot(projectId);
      const [pages, board, context, brief, stack, architecture, decisions] = await Promise.all([
        this.ports.artifacts.readText(projectId, 'pages'),
        this.ports.board.read(projectId),
        loadProjectContext(root, undefined, 8_000).catch(() => null),
        this.ports.artifacts.readText(projectId, 'brief'),
        this.ports.artifacts.readText(projectId, 'stack'),
        this.ports.artifacts.readText(projectId, 'architecture'),
        this.ports.artifacts.readText(projectId, 'decisions'),
      ]);
      // The product intent and the technical choices are part of the plan. Without them the chat can wire a feature
      // that contradicts the brief or the stack it has already committed to.
      const documents = [
        brief ? `BRIEF:\n${brief.slice(0, 3_000)}` : '',
        stack ? `STACK:\n${stack.slice(0, 2_000)}` : '',
        architecture ? `ARCHITECTURE:\n${architecture.slice(0, 2_000)}` : '',
        decisions ? `DECISIONS:\n${decisions.slice(0, 2_000)}` : '',
      ].filter(Boolean).join('\n\n');
      // A page drawn a minute ago is what the chat is usually about, and the stored pull may predate it. A live read
      // that stalls must not stall the turn: `currentDesignSoon` falls back to the stored design after ten seconds.
      onStage?.('reading-design');
      const source = await this.currentDesignSource(projectId);
      const design = source.design;
      // A model that works from the last pull must not look as if it read the editor: it would call a page missing
      // that is on screen, or link to one that is gone. Said in the reply so the person reads it with the change set.
      const staleNote = source.live ? '' : ' Note: open-pencil could not be read just now, so this used the design from the last pull. Open open-pencil and pull the design first if you drew or changed anything.';
      onStage?.('asking-model');
      const first = await this.ports.requester.structuredRequest(
        settings.promptGuide,
        NAMES,
        planChatPrompt(message, pages ?? '', board, design, context, intent, documents),
        'kai_studio_plan_chat',
        PLAN_CHAT_SCHEMA,
        parsePlanChatReply,
        // A feature set is a dozen actions with stories and acceptance criteria, and a reasoning model spends part
        // of the budget thinking first. The same budget the artifacts use gives a long feature room to finish.
        { maxOutputTokens: STUDIO_MAX_OUTPUT_TOKENS },
      );
      // Ask is allowed to answer without touching the plan. A screen correction or a feature is not: the model
      // sometimes describes the change in the reply and returns an empty list, so its own description is handed back
      // in a second, narrower call that asks only for the actions.
      if (first.actions.length > 0 || intent === 'ask') {
        onStage?.('done');
        return { ...first, reply: `${first.reply}${staleNote}`.slice(0, 8_000) };
      }
      onStage?.('extracting-actions');
      try {
        const extracted = await this.ports.requester.structuredRequest(
          settings.promptGuide,
          NAMES,
          planActionsPrompt(message, first.reply, pages ?? '', board, design, context, intent, documents),
          'kai_studio_plan_actions',
          PLAN_CHAT_SCHEMA,
          parsePlanChatReply,
          { maxOutputTokens: STUDIO_MAX_OUTPUT_TOKENS },
        );
        onStage?.('done');
        return extracted.actions.length > 0
          ? { reply: `${first.reply}${staleNote}`.slice(0, 8_000), actions: extracted.actions, dropped: extracted.dropped }
          : { ...first, reply: `${first.reply}${staleNote}`.slice(0, 8_000), dropped: first.dropped + extracted.dropped };
      } catch {
        // A failed second call keeps the first answer, which is still useful reading even without a change set.
        onStage?.('done');
        return { ...first, reply: `${first.reply}${staleNote}`.slice(0, 8_000) };
      }
    } catch (error) {
      onStage?.('failed');
      throw error;
    }
  }

  /**
   * The design as the editor holds it now, when open-pencil is reachable, and the stored pull when it is not.
   *
   * The Studio chat exists for the page that was drawn a moment ago, which the last pull cannot know about. Reading
   * live is also why "that page is the sign-up screen" works without pulling first. A read that fails, or sees an
   * empty document, leaves the stored design in place rather than replacing something trustworthy with nothing.
   */
  private async currentDesign(projectId: string, stored?: StudioDesign): Promise<{ design: StudioDesign; live: boolean }> {
    const previous = stored ?? await this.ports.board.design(projectId);
    if (!this.ports.openPencil) return { design: previous, live: false };
    try {
      const ports = await this.ports.openPencil();
      if (!ports) return { design: previous, live: false };
      const read = await readDesign(ports);
      const components = read.components.map((component) => designComponentSchema.parse(component));
      return components.length > 0 ? { design: { ...previous, components }, live: true } : { design: previous, live: false };
    } catch {
      return { design: previous, live: false };
    }
  }

  /**
   * The live design only when open-pencil answers promptly, and the stored pull otherwise.
   *
   * The Studio chat runs before the model call, and an editor whose MCP has stopped answering used to hold the
   * whole turn open with no timeout and no error: the button spun forever. Ten seconds is enough for a live read
   * on a working editor and short enough that a stale one falls back to the design the project already has.
   */
  private async currentDesignSoon(projectId: string): Promise<StudioDesign> {
    return (await this.currentDesignSource(projectId)).design;
  }

  /** The same read, saying whether it came from the editor now or is the last pull standing in for it. */
  private async currentDesignSource(projectId: string): Promise<{ design: StudioDesign; live: boolean }> {
    const stored = await this.ports.board.design(projectId);
    try {
      return await withTimeout(this.currentDesign(projectId, stored), 10_000, 'open-pencil did not answer in time.');
    } catch {
      return { design: stored, live: false };
    }
  }

  /**
   * Applies an approved change set. Each action is independent: one that fails is reported and the rest still run,
   * because a person who ticked five changes should not lose four of them to one stale name.
   *
   * The writes reuse the paths the rest of the Studio already trusts: `saveArtifact` for the pages inventory, the
   * board's own writer for cards, and `renameDesignPage` for linking a drawn page to a planned screen. That is also
   * why a link goes through the editor at all: renaming the page is what makes the checklist and the board agree.
   */
  async applyPlanActions(projectId: string, actions: readonly StudioPlanAction[]): Promise<StudioPlanApplyResult> {
    let pages = (await this.ports.artifacts.readText(projectId, 'pages')) ?? '';
    const applied: string[] = [];
    const failed: Array<{ summary: string; reason: string }> = [];
    // A feature's cards are proposed by title, and some of them are created in the same change set. Dependencies are
    // resolved after every action has run, so a card may name one that appears later in the set.
    const pendingDependencies: Array<{ cardId: string; dependsOn: string[] }> = [];
    for (const action of actions) {
      try {
        switch (action.kind) {
          case 'link': {
            const design = await this.currentDesignSoon(projectId);
            const page = findScreen(design.components.filter((component) => component.screen), (component) => component.name, action.designName);
            if (!page) throw new Error(`No drawn OpenPencil page is called "${action.designName}". Pull the design, then try again.`);
            const target = pageEntry(pages, action.screenName);
            if (!target) throw new Error(`The plan has no screen called "${action.screenName}".`);
            await this.renameDesignPage(projectId, page.name, target.name);
            pages = (await this.ports.artifacts.readText(projectId, 'pages')) ?? pages;
            break;
          }
          case 'add': {
            const cardKind = action.cardKind;
            const route = action.route.trim().startsWith('/') ? action.route.trim() : '';
            // A page owns an inventory section; a component, endpoint, flow or chore card only owns a board card.
            // Idempotent on purpose: a set can contain "regenerate pages" alongside "add this screen", and the
            // regenerated inventory may already carry it. The screen and its card are each created only if absent.
            if (cardKind === 'page' && !pageEntry(pages, action.title)) {
              pages = appendPageSection(pages, action.title, route, action.purpose);
              await this.saveArtifact(projectId, 'pages', pages);
            }
            const board = await this.ports.board.read(projectId);
            const key = screenTitleKey(action.title);
            let cardId = findScreen(board.cards, (card) => card.title, action.title)?.id ?? null;
            if (!cardId) {
              const catalog = await this.ports.artifacts.read(projectId);
              const now = this.ports.now();
              cardId = uniqueCardId(board.cards, `${cardKind}-${slugFor(action.title)}`);
              const acceptance = action.acceptance.length > 0
                ? action.acceptance
                : cardKind === 'page'
                  ? ['It is reachable at its route.', 'It matches the design drawn for it.']
                  : ['It passes the check for this card.'];
              const card = boardCardSchema.parse({
                id: cardId,
                title: action.title,
                kind: cardKind,
                story: action.story || action.purpose || `Added from the Studio chat: ${action.title}.`,
                acceptance,
                route,
                needsArtifacts: defaultNeeds(cardKind),
                status: 'backlog',
                createdAt: now,
                updatedAt: now,
              });
              await this.ports.board.replace(projectId, [...board.cards, card], catalog.artifacts);
            }
            if (action.dependsOn.length > 0) pendingDependencies.push({ cardId, dependsOn: action.dependsOn });
            if (action.designName && cardKind === 'page') {
              const design = await this.currentDesignSoon(projectId);
              const drawn = findScreen(design.components.filter((component) => component.screen), (component) => component.name, action.designName!);
              if (!drawn) throw new Error(`The screen was added, but no drawn OpenPencil page is called "${action.designName}".`);
              await this.renameDesignPage(projectId, drawn.name, newPageHeading(action.title, route));
              pages = (await this.ports.artifacts.readText(projectId, 'pages')) ?? pages;
            }
            break;
          }
          case 'story': {
            const stories = (await this.ports.artifacts.readText(projectId, 'stories')) ?? '';
            const appended = appendStorySection(stories, action.title, action.body, action.acceptance);
            // Already there is a success, not a duplicate section: a feature set may re-send its story.
            if (appended.added) await this.saveArtifact(projectId, 'stories', appended.markdown);
            break;
          }
          case 'remove': {
            const key = screenTitleKey(pageEntry(pages, action.screenName)?.name ?? action.screenName);
            const removed = removePageSection(pages, key);
            const board = await this.ports.board.read(projectId);
            const doomed = findScreen(board.cards.filter((card) => card.kind === 'page'), (card) => card.title, action.screenName);
            const remaining = board.cards.filter((card) => card !== doomed);
            if (!removed.removed && remaining.length === board.cards.length) {
              throw new Error(`No screen called "${action.screenName}" is in the plan or on the board.`);
            }
            if (removed.removed) {
              pages = removed.markdown.trim() ? removed.markdown : `# Pages\n\nNo screens are planned yet.\n`;
              await this.saveArtifact(projectId, 'pages', pages);
            }
            if (remaining.length !== board.cards.length) {
              const catalog = await this.ports.artifacts.read(projectId);
              await this.ports.board.replace(projectId, remaining, catalog.artifacts);
            }
            if (action.deletePage) {
              const design = await this.currentDesignSoon(projectId);
              const drawn = findScreen(design.components.filter((component) => component.screen), (component) => component.name, action.screenName);
              if (!drawn) throw new Error(`The screen was removed, but no drawn OpenPencil page is called "${action.screenName}".`);
              await this.deleteDesignPage(projectId, drawn.id);
            }
            break;
          }
          case 'route': {
            const key = screenTitleKey(pageEntry(pages, action.screenName)?.name ?? action.screenName);
            const board = await this.ports.board.read(projectId);
            const card = findScreen(board.cards.filter((item) => item.kind === 'page'), (item) => item.title, action.screenName);
            const routed = setPageRoute(pages, key, action.route);
            if (!card && !routed.changed) throw new Error(`No screen called "${action.screenName}" is in the plan or on the board.`);
            if (card) await this.ports.board.setRoute(projectId, card.id, action.route);
            if (routed.changed) {
              pages = routed.markdown;
              await this.saveArtifact(projectId, 'pages', pages);
            }
            break;
          }
          case 'generate': {
            const written = await this.generateSelected(projectId, action.artifacts);
            if (written.failed.length > 0) {
              throw new Error(`Could not write ${written.failed.map((entry) => `${entry.kind} (${entry.reason})`).join(', ')}.`);
            }
            pages = (await this.ports.artifacts.readText(projectId, 'pages')) ?? pages;
            break;
          }
        }
        applied.push(action.summary);
      } catch (error) {
        failed.push({ summary: action.summary, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    // Resolve the feature's dependencies once every card exists. Titles are matched the way the rest of the Studio
    // matches screens, and an id is accepted as-is. Unknown names are left out rather than making an action fail:
    // the card the person asked for is still useful, and the next pass can wire what was missing.
    if (pendingDependencies.length > 0) {
      const board = await this.ports.board.read(projectId);
      const ids = new Set(board.cards.map((card) => card.id));
      const byTitle = new Map<string, string>();
      for (const card of board.cards) {
        const key = screenTitleKey(card.title);
        if (key && !byTitle.has(key)) byTitle.set(key, card.id);
      }
      let changed = false;
      let cards = board.cards.map((card) => {
        const pending = pendingDependencies.filter((entry) => entry.cardId === card.id);
        if (pending.length === 0) return card;
        const wanted = [...card.dependsOn];
        for (const entry of pending) {
          for (const name of entry.dependsOn) {
            const id = ids.has(name) ? name : byTitle.get(screenTitleKey(name));
            if (id && id !== card.id && !wanted.includes(id)) wanted.push(id);
          }
        }
        if (wanted.length === card.dependsOn.length) return card;
        changed = true;
        return { ...card, dependsOn: wanted, updatedAt: this.ports.now() };
      });
      // The cards were written before their dependencies were known, and `replace` promoted them because they had
      // none at the time. Demote any ready card whose dependencies are still unfinished, to a fixed point, so a
      // feature that waits on another feature's endpoint is not shown as workable.
      for (let pass = 0; pass < cards.length; pass += 1) {
        const current = new Map(cards.map((card) => [card.id, card]));
        let moved = false;
        cards = cards.map((card) => {
          if (card.status !== 'ready') return card;
          if (!card.dependsOn.some((id) => dependencyBlocks(id, current))) return card;
          moved = true;
          changed = true;
          return { ...card, status: 'backlog' as const, updatedAt: this.ports.now() };
        });
        if (!moved) break;
      }
      if (changed) {
        const catalog = await this.ports.artifacts.read(projectId);
        await this.ports.board.replace(projectId, cards, catalog.artifacts);
        // `replace` keeps the status a card already had, so a demotion has to go through `move` as well. Read the
        // board back and settle any ready card with unfinished dependencies, repeating until nothing moves: moving
        // one card can briefly re-promote another while its own dependency is still being put back.
        for (let pass = 0; pass < board.cards.length; pass += 1) {
          const current = await this.ports.board.read(projectId);
          const byId = new Map(current.cards.map((card) => [card.id, card]));
          const wrong = current.cards.filter((card) => card.status === 'ready' && card.dependsOn.some((id) => dependencyBlocks(id, byId)));
          if (wrong.length === 0) break;
          for (const card of wrong) {
            await this.ports.board.move(projectId, card.id, 'backlog', 'Wired into a feature change set; it waits on unfinished work.', 'agent');
          }
        }
      }
    }
    // The plan may have changed under the cards (a route set, a screen added, a feature written), so the cards are
    // brought into line with it now rather than at the next pull: a screen the plan gives a route to takes it, and a
    // page the plan gives none becomes a component. Without this the chat updated `pages.md` and left the board behind.
    const before = await this.ports.board.read(projectId);
    const aligned = withPlanRoutes(before.cards, pages);
    if (aligned.some((card, index) => card !== before.cards[index])) {
      const catalog = await this.ports.artifacts.read(projectId);
      await this.ports.board.replace(projectId, aligned, catalog.artifacts);
    }
    await this.refreshHandoff(projectId);
    const [board, artifacts, design] = await Promise.all([
      this.ports.board.read(projectId),
      this.ports.artifacts.read(projectId),
      this.ports.board.design(projectId),
    ]);
    return { board, artifacts, design, pages, applied, failed };
  }

  /** Stops the turn one design-build step is running. Answers false when it had already finished. */
  cancelDesignStep(stepId: string): boolean {
    return this.ports.cancelDesignAgent?.(stepId) ?? false;
  }
}

/** The pages-inventory entry whose name reduces to the same key, or null when the plan does not carry it. */
function pageEntry(pages: string, name: string): { name: string } | null {
  return findScreen(parsePages(pages), (page) => page.name, name) ?? null;
}

/** A card id no card on this board already uses. */
function uniqueCardId(cards: readonly BoardCard[], base: string): string {
  const taken = new Set(cards.map((card) => card.id));
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function slugFor(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return slug || 'screen';
}

/** A promise with a deadline. The loser is still settled by the race, so a late rejection is not unhandled. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * A model's list field, whether it sent strings, objects with a name field, or one string of lines or comma
 * separated items. Dependencies and acceptance criteria are commonly objects rather than plain strings.
 */
function stringList(value: unknown): string[] {
  const one = (item: unknown): string | null => {
    if (typeof item === 'string') return item.trim() || null;
    if (item && typeof item === 'object') {
      const object = item as Record<string, unknown>;
      const name = object.title ?? object.name ?? object.id ?? object.kind ?? object.screenName ?? object.screen
        ?? object.criterion ?? object.text ?? object.description;
      return typeof name === 'string' && name.trim() ? name.trim() : null;
    }
    return null;
  };
  if (Array.isArray(value)) return value.map(one).filter((item): item is string => item !== null);
  if (typeof value === 'string') return value.split(/\r?\n|,/).map(one).filter((item): item is string => item !== null);
  return [];
}

/** The JSON shape the plan chat is asked for. Per-kind required fields are checked by the zod parser below. */
const PLAN_ACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'summary'],
  properties: {
    kind: { type: 'string', enum: ['link', 'add', 'story', 'remove', 'route', 'generate'] },
    summary: { type: 'string' },
    designName: { type: 'string' },
    screenName: { type: 'string' },
    cardKind: { type: 'string', enum: CARD_KINDS },
    title: { type: 'string' },
    route: { type: 'string' },
    purpose: { type: 'string' },
    story: { type: 'string' },
    body: { type: 'string' },
    acceptance: { type: 'array', items: { type: 'string' } },
    dependsOn: { type: 'array', items: { type: 'string' } },
    deletePage: { type: 'boolean' },
    artifacts: { type: 'array', items: { type: 'string', enum: ARTIFACT_KINDS } },
  },
} as const;

const PLAN_CHAT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'actions'],
  properties: {
    reply: { type: 'string' },
    actions: { type: 'array', items: PLAN_ACTION_SCHEMA },
  },
} as const;

const ACTION_KIND_ALIASES: Record<string, string> = {
  create: 'add',
  new: 'add',
  add_card: 'add',
  add_screen: 'add',
  add_page: 'add',
  screen: 'add',
  page: 'add',
  card: 'add',
  add_story: 'story',
  user_story: 'story',
  update_route: 'route',
  set_route: 'route',
  reroute: 'route',
  delete: 'remove',
  remove_screen: 'remove',
  delete_screen: 'remove',
  drop: 'remove',
  link_page: 'link',
  link_screen: 'link',
  connect: 'link',
  regenerate: 'generate',
  update_artifacts: 'generate',
  write: 'generate',
};

/**
 * The action list under any of the names a model reaches for, including one nested object deep.
 */
function actionList(parsed: Record<string, unknown>): unknown[] {
  const combined: unknown[] = [];
  // A story written as its own top-level object, beside the card list, is part of the set too.
  const story = parsed.story;
  if (typeof story === 'string' && story.trim()) combined.push({ kind: 'story', title: story.trim(), summary: story.trim() });
  else if (story && typeof story === 'object' && !Array.isArray(story)) combined.push({ kind: 'story', ...(story as Record<string, unknown>) });

  const keys = [
    'actions', 'changes', 'steps', 'screens', 'pages', 'cards', 'stories', 'items',
    'proposedChanges', 'proposed_changes', 'actionList', 'action_list', 'plan',
    'features', 'newCards', 'new_cards', 'work', 'tasks', 'backlog',
  ];
  for (const key of keys) {
    const value = parsed[key];
    if (Array.isArray(value)) {
      const named = value.map((item) => {
        if (typeof item !== 'string' || !item.trim()) return item;
        // A bare name in a stories, screens or pages list is still an actionable change.
        if (key === 'stories') return { kind: 'story', title: item.trim(), summary: `Add the story "${item.trim()}"` };
        if (key === 'screens' || key === 'pages') return { kind: 'add', cardKind: 'page', title: item.trim(), summary: `Add the page "${item.trim()}"` };
        return item;
      });
      return [...combined, ...named];
    }
    if (value && typeof value === 'object') {
      const nested = actionList(value as Record<string, unknown>);
      if (nested.length > 0) return [...combined, ...nested];
    }
    if (typeof value === 'string' && value.trim().startsWith('[')) {
      try {
        const decoded = JSON.parse(value);
        if (Array.isArray(decoded)) return [...combined, ...decoded];
      } catch {
        // Not JSON; the action-level parse will report it as dropped.
      }
    }
  }
  const single = parsed.action ?? parsed.change ?? parsed.operation;
  if (single && typeof single === 'object' && !Array.isArray(single)) combined.push(single);
  return combined;
}

/**
 * One proposed change, normalized from the common ways a model writes it: a nested action object, an aliased kind,
 * and field names such as name, path or dependencies.
 */
function actionRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = { ...(value as Record<string, unknown>) };
  for (const key of ['action', 'operation', 'change']) {
    const nested = source[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      return actionRecord({ ...(nested as Record<string, unknown>), summary: source.summary ?? (nested as Record<string, unknown>).summary });
    }
  }
  const rawKind = String(source.kind ?? source.type ?? source.action ?? source.op ?? source.operation ?? source.changeType ?? '').toLowerCase().trim();
  const aliased = ACTION_KIND_ALIASES[rawKind] ?? rawKind;
  if (['link', 'add', 'story', 'remove', 'route', 'generate'].includes(aliased)) source.kind = aliased;
  else if ((CARD_KINDS as readonly string[]).includes(rawKind)) {
    source.kind = 'add';
    source.cardKind ??= rawKind;
  } else if (rawKind) {
    const found = ['story', 'link', 'remove', 'route', 'generate', 'add'].find((kind) => rawKind.includes(kind));
    if (found) source.kind = found;
  }
  // An unrecognised kind that still carries a route or a screen is a route or a card, not a lost change.
  if (!['link', 'add', 'story', 'remove', 'route', 'generate'].includes(String(source.kind))) {
    if (typeof source.route === 'string' && typeof source.screenName === 'string') source.kind = 'route';
    else if (typeof source.title === 'string' || typeof source.name === 'string') source.kind = 'add';
  }
  source.summary ??= source.title ?? source.name ?? source.screenName ?? source.screen ?? source.description ?? source.reason;
  source.screenName ??= source.screen ?? source.pageName ?? source.page ?? source.name;
  source.designName ??= source.designPage ?? source.design_page ?? source.drawnPage ?? source.drawing;
  source.cardKind ??= source.cardType ?? source.card_type ?? source.type ?? source.card;
  source.title ??= source.name ?? source.screenName;
  source.route ??= source.path ?? source.url ?? source.href;
  source.dependsOn ??= source.dependsOnTitles ?? source.depends_on ?? source.dependencies ?? source.blockedBy;
  source.acceptance ??= source.acceptanceCriteria ?? source.acceptance_criteria ?? source.checks ?? source.criteria;
  source.artifacts ??= source.documents ?? source.docs ?? source.files ?? source.artefacts;
  if (typeof source.summary !== 'string' || !source.summary.trim()) source.summary = `${source.kind ?? 'plan'} change`;
  return source;
}

/**
 * A model sometimes answers with one "feature" object that contains the story, screens, cards and flows, rather
 * than with the actions themselves. Flatten it, so the set inside is not lost as one unreadable change.
 */
function expandFeatures(items: unknown[]): unknown[] {
  const cardKindFor: Record<string, string> = {
    screens: 'page',
    pages: 'page',
    cards: 'page',
    components: 'component',
    endpoints: 'backend',
    flows: 'flow',
    chores: 'chore',
  };
  return items.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [item];
    const object = item as Record<string, unknown>;
    const kind = String(object.kind ?? object.type ?? '').toLowerCase();
    if (!['feature', 'plan', 'group', 'phase', 'workstream'].includes(kind)) return [item];
    const parts: unknown[] = [];
    if (object.story) {
      parts.push({
        kind: 'story',
        ...(typeof object.story === 'object' && !Array.isArray(object.story)
          ? object.story as Record<string, unknown>
          : { title: String(object.story) }),
      });
    }
    for (const [key, cardKind] of Object.entries(cardKindFor)) {
      const list = object[key];
      if (!Array.isArray(list)) continue;
      for (const part of list) {
        if (typeof part === 'string') parts.push({ kind: 'add', cardKind, title: part });
        else if (part && typeof part === 'object' && !Array.isArray(part)) parts.push({ kind: 'add', cardKind, ...(part as Record<string, unknown>) });
        else parts.push(part);
      }
    }
    for (const key of ['actions', 'changes', 'steps']) {
      const list = object[key];
      if (Array.isArray(list)) parts.push(...list);
    }
    return parts.length > 0 ? parts : [item];
  });
}

/** Reads a plan-chat reply, dropping actions that do not validate rather than losing the whole answer. */
export function parsePlanChatReply(raw: string): StudioPlanChatResult {
  const parsed = (parseJsonResponse(raw, 'Project Studio') ?? {}) as Record<string, unknown>;
  const reply = typeof parsed.reply === 'string' ? parsed.reply.trim().slice(0, 8_000) : '';
  // Models reach for a few different names for the list. Accept them all rather than showing an empty change set
  // for a reply that clearly described one.
  const candidate = expandFeatures(actionList(parsed));
  // A reply with neither words nor actions is unusable. A reply that only carries actions is fine: the second
  // extraction pass is told not to repeat the description, and older models sometimes leave the sentence out.
  if (!reply && candidate.length === 0) throw new Error('The Studio chat reply had nothing to say.');
  const actions: StudioPlanAction[] = [];
  let dropped = 0;
  if (candidate.length > 0) {
    for (const value of candidate) {
      const raw = actionRecord(value);
      if (!raw) { dropped += 1; continue; }
      if (raw.kind === 'add' && raw.story === undefined && typeof raw.storyText === 'string') raw.story = raw.storyText;
      const fields: Record<string, readonly string[]> = {
        link: ['kind', 'summary', 'designName', 'screenName'],
        add: ['kind', 'summary', 'cardKind', 'title', 'route', 'purpose', 'story', 'acceptance', 'dependsOn', 'designName'],
        story: ['kind', 'summary', 'title', 'body', 'acceptance'],
        remove: ['kind', 'summary', 'screenName', 'deletePage'],
        route: ['kind', 'summary', 'screenName', 'route'],
        generate: ['kind', 'summary', 'artifacts'],
      };
      const allowed = fields[String(raw.kind)];
      if (!allowed) { dropped += 1; continue; }
      const item: Record<string, unknown> = Object.fromEntries(allowed.filter((key) => key in raw).map((key) => [key, raw[key]]));
      if (item.kind === 'add') {
        const aliases: Record<string, string> = { screen: 'page', ui: 'component', endpoint: 'backend', api: 'backend', setup: 'chore', infra: 'chore' };
        const named = typeof item.cardKind === 'string' ? item.cardKind.toLowerCase() : '';
        item.cardKind = (CARD_KINDS as readonly string[]).includes(named) ? named : aliases[named] ?? 'page';
        if (typeof item.route !== 'string') item.route = '';
        if (typeof item.purpose !== 'string') item.purpose = '';
        if (typeof item.story !== 'string') item.story = '';
        if (typeof item.designName !== 'string') item.designName = null;
        item.acceptance = stringList(item.acceptance);
        item.dependsOn = stringList(item.dependsOn);
      }
      if (item.kind === 'story') {
        if (typeof item.body !== 'string') item.body = '';
        item.acceptance = stringList(item.acceptance);
      }
      if (item.kind === 'remove' && typeof item.deletePage !== 'boolean') item.deletePage = false;
      if (item.kind === 'generate') {
        if (typeof item.artifacts === 'string') item.artifacts = item.artifacts.split(/[\s,]+/).filter(Boolean);
        if (Array.isArray(item.artifacts)) item.artifacts = item.artifacts.filter((kind) => typeof kind === 'string');
      }
      // Keep a long field from failing the whole action. The limits are the schema's own.
      const clip = (value: unknown, max: number): unknown => (typeof value === 'string' ? value.slice(0, max) : value);
      // Only clip fields that exist. Assigning undefined would add a key the strict action schema rejects.
      const clipField = (key: string, max: number): void => { if (key in item) item[key] = clip(item[key], max); };
      clipField('summary', 300);
      clipField('title', 120);
      clipField('screenName', 300);
      clipField('designName', 300);
      clipField('route', 300);
      clipField('purpose', 2_000);
      clipField('story', 4_000);
      clipField('body', 4_000);
      if (Array.isArray(item.acceptance)) {
        item.acceptance = item.acceptance.map((value) => (typeof value === 'string' ? value.slice(0, 400) : value)).slice(0, 20);
      }
      if (Array.isArray(item.dependsOn)) {
        item.dependsOn = item.dependsOn.map((value) => (typeof value === 'string' ? value.slice(0, 200) : value)).slice(0, 20);
      }
      if (item.kind === 'generate' && Array.isArray(item.artifacts)) {
        const artifactAliases: Record<string, string[]> = {
          design: ['style-guide', 'tokens'],
          ui: ['style-guide', 'tokens'],
          docs: ['decisions', 'architecture', 'conventions'],
          documentation: ['decisions', 'architecture', 'conventions'],
          db: ['stack'],
          database: ['stack'],
          routes: ['pages', 'flows'],
          tests: ['acceptance'],
          api: ['stack', 'architecture'],
        };
        item.artifacts = [...new Set((item.artifacts as unknown[]).flatMap((value) => {
          if (typeof value !== 'string') return [];
          const name = value.toLowerCase();
          return (ARTIFACT_KINDS as readonly string[]).includes(name) ? [name] : artifactAliases[name] ?? [];
        }))];
      }
      const action = studioPlanActionSchema.safeParse(item);
      if (action.success) actions.push(action.data);
      else dropped += 1;
    }
  }
  const kept = actions.slice(0, 24);
  return { reply: reply || 'Here is the change set.', actions: kept, dropped: dropped + (actions.length - kept.length) };
}

/** The chat's prompt: the plan as it stands, the drawn screens, and the rule that it proposes rather than writes. */
export function planChatPrompt(
  message: string,
  pages: string,
  board: StudioBoard,
  design: StudioDesign,
  context: string | null,
  intent: StudioPlanIntent = 'feature',
  documents = '',
): { system: string; user: string } {
  const intentRules: Record<StudioPlanIntent, string> = {
    ask: 'The person chose Ask. A conversational answer is allowed; return actions only when they clearly asked for a change.',
    screen: 'The person chose Change a screen. Return the smallest set that corrects that screen, and an empty list with a reason when nothing needs changing.',
    feature: 'The person chose Add a feature. You must return at least one action. Build the complete feature set described below.',
  };
  const system = [
    'You are the Studio assistant inside KAI. The person is telling you what a page drawn in open-pencil is, what is missing from the plan, or what new feature the project needs. You answer with a complete change set for them to approve. You have written nothing yet.',
    intentRules[intent],
    'Return only JSON matching the schema.',
    '',
    'What each action means:',
    '- "story": add the user story for the feature, with its acceptance criteria. One story per feature, not one per screen.',
    '- "add": create one piece of work. cardKind is "page" for a screen, "component" for reusable UI, "backend" for an endpoint or data work, "flow" for tying screens together, and "chore" for setup. For a page, give a short title, its route and, when the person just drew it, designName. For any card, give the story it implements and its acceptance criteria. dependsOn names other cards by title or id, including cards created earlier in this same set. Something Windows draws, not the app (an OS toast, the system tray, the notification centre, the taskbar, a native dialog or file picker) is not a screen: give it cardKind "backend", no route, and a title that says what it is, such as "OS toast: reminder due" or "System tray menu", so it is built with Electron\'s own API and is not checked against a screenshot.',
    '- "link": a page already drawn in open-pencil is the same screen as one the plan already carries, under a different name. designName is the drawn page name; screenName is the planned screen.',
    '- "remove": a screen should leave the plan. Set deletePage only when the person explicitly asked to delete the drawing too.',
    '- "route": a screen has no route or the wrong one. route starts with "/".',
    '- "generate": artifacts that genuinely change. Never include brief. The person will untick anything they do not want.',
    '',
    'When the message describes a new feature:',
    '- Propose a complete feature set, not one edit. Include one "story" action, then one "add" action for every screen, shared component, endpoint and flow the feature needs, then "generate" only for documents that truly change (usually pages and stories; PRD, architecture, acceptance or risks when the feature changes them).',
    '- Wire the work into the board. A page depends on the endpoints and shared components it uses; a flow depends on the pages it joins. Name dependencies with the titles shown in BOARD CARDS, or with the title of a card in this same set.',
    '- Do not propose a card for work the board already has. Use "link" or "route" to fix an existing screen instead.',
    '- Keep the set readable: at most 12 actions. Order it story first, then backend and component cards, then pages and flows, then generate.',
    '- A story action writes stories.md itself, so never also list stories in generate. An add page writes its own inventory section, so list pages in generate only when the rest of the inventory needs rewriting.',
    '- The reply says what will change and what the person does next: draw the new screens, apply, then start Autopilot or open Code.',
    '',
    'Example of the required shape (use your own content, not this text):',
    '{"reply":"Adding the parent portal. Apply the set, then draw the new page and start Autopilot.","actions":[{"kind":"story","summary":"Add the parent portal story","title":"Parent portal","body":"A parent signs in and sees each child.","acceptance":["The parent sees a report for every child."]},{"kind":"add","summary":"Add the Parent portal page","cardKind":"page","title":"Parent portal","route":"/parent","dependsOn":["Auth endpoint"],"acceptance":["The page lists each child."]}]}',
    '',
    'Rules:',
    '- Only propose changes the person asked for. Never invent a screen, route or integration they did not mention.',
    '- If the message is a question or a request to inspect, return an empty actions list.',
    '- "summary" is one short line the person reads before ticking the action.',
    '- "reply" is two to four plain sentences: what you understood, what the set changes, and the next step. Do not use em dashes or en dashes.',
    '- Match names the way a person would: case, punctuation and a leading route do not matter.',
    '- Respect the brief and the technical documents supplied. If the feature changes a documented decision, say so in the reply.',
  ].join('\n');
  const drawn = design.components.filter((component) => component.screen);
  const user = [
    `INTENT: ${intent}`,
    `USER MESSAGE:\n${message}`,
    `PAGES INVENTORY:\n${pages.trim() || '(none written)'}`,
    `BOARD CARDS:\n${board.cards.map((card) => `${card.id} | ${card.kind} | ${card.title} | status=${card.status} | route=${card.route || '(missing)'} | dependsOn=${card.dependsOn.length > 0 ? card.dependsOn.join(', ') : '(none)'}`).join('\n') || '(none)'}`,
    `DRAWN OPEN-PENCIL PAGES:\n${drawn.map((component) => `${component.name} | node=${component.id}`).join('\n') || '(none recorded)'}`,
    documents ? `PLAN DOCUMENTS:\n${documents}` : '',
    context ? `PROJECT SNAPSHOT:\n${context}` : '',
  ].filter(Boolean).join('\n\n');
  return { system, user };
}

/**
 * The second pass. It runs only when the first answer described a change but returned no usable actions, so the
 * person's request and the model's own description are handed back with one instruction: turn this into actions.
 */
export function planActionsPrompt(
  message: string,
  reply: string,
  pages: string,
  board: StudioBoard,
  design: StudioDesign,
  context: string | null,
  intent: StudioPlanIntent,
  documents = '',
): { system: string; user: string } {
  const system = [
    'You turn a described plan change into concrete Studio actions. A previous answer described the change but returned no actions; this call exists only to produce them.',
    'Return only JSON matching the schema. At least one action is required.',
    '',
    'Action fields:',
    '- "story": title, body, acceptance. The feature story.',
    '- "add": cardKind (page, component, backend, flow, chore), title, route for a page or routed component, purpose, story, acceptance, dependsOn (titles or ids). A page is also added to pages.md.',
    '- "link": designName, screenName.',
    '- "remove": screenName, deletePage.',
    '- "route": screenName, route.',
    '- "generate": artifacts.',
    '',
    'Example of the required shape (use your own content, not this text):',
    '{"reply":"Adding the feature.","actions":[{"kind":"story","summary":"Add the Zuri goal story","title":"Zuri unified assistant","body":"A person uses Zuri on the web and on Windows.","acceptance":["The same account works on both."]},{"kind":"add","summary":"Add the sync flow card","cardKind":"flow","title":"Sync flow","dependsOn":["Chat workspace"],"acceptance":["Changes appear on both clients."]}]}',
    '',
    `Intent: ${intent}.`,
    'Use titles from BOARD CARDS for dependencies, and titles from this set for new cards.',
    'Do not invent screens, routes or integrations the request does not imply.',
    'Respect the brief and the technical documents supplied.',
    'The reply field is one short sentence; the description was already given in the previous answer.',
  ].join('\n');
  const drawn = design.components.filter((component) => component.screen);
  const user = [
    `THE PERSON ASKED:\n${message}`,
    `THE DESCRIPTION ALREADY GIVEN:\n${reply}`,
    `PAGES INVENTORY:\n${pages.trim() || '(none written)'}`,
    `BOARD CARDS:\n${board.cards.map((card) => `${card.id} | ${card.kind} | ${card.title} | status=${card.status} | route=${card.route || '(missing)'}`).join('\n') || '(none)'}`,
    `DRAWN OPEN-PENCIL PAGES:\n${drawn.map((component) => `${component.name} | node=${component.id}`).join('\n') || '(none recorded)'}`,
    documents ? `PLAN DOCUMENTS:\n${documents}` : '',
    context ? `PROJECT SNAPSHOT:\n${context}` : '',
  ].filter(Boolean).join('\n\n');
  return { system, user };
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
    '- Cards that do not need one another are worked at the same time, so list a dependency only where a card truly cannot be built without the other: it imports it, calls it, or needs its data. Do not chain cards just to give them an order, and do not make every card depend on the setup card when only a few use what it creates. Name the files a card will create or change in its prompt, so two cards that edit the same file are not worked together.',
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
    '- Cards that do not need one another are worked at the same time. Keep "dependsOn" to real needs (it imports it, calls it, or needs its data) and drop any that only expresses an order, so more cards can run side by side.',
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
