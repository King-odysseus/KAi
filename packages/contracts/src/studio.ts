import { z } from 'zod';
import { agentIdSchema } from './primitives';

/**
 * The Project Studio's second and third layers. The interview writes one brief; this turns the brief into a set of
 * artifacts under `.kai/spec` that depend on each other, and a board of cards built from those artifacts and from
 * the design.
 *
 * Two rules from the plan live in these types rather than in a prompt:
 * - An artifact that reads another artifact goes **stale** when the one it reads is regenerated.
 * - A card may only reach `done` through a passing check whose recorded file hashes still match the working tree.
 *   `check` carries the run that was recorded; the main process enforces the rest.
 */

/** The artifacts the studio writes. Each is one plain file, so Git versions it and an agent reads it without MCP. */
export const ARTIFACT_KINDS = ['brief', 'prd', 'stories', 'stack', 'flows', 'style-guide', 'tokens'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export const artifactKindSchema = z.enum(ARTIFACT_KINDS);

/** Where each artifact lives, relative to the project root. The interview owns `brief`; the rest are generated. */
export const ARTIFACT_PATHS: Record<ArtifactKind, string> = {
  brief: '.kai/spec/brief.md',
  prd: '.kai/spec/prd.md',
  stories: '.kai/spec/stories.md',
  stack: '.kai/spec/stack.md',
  flows: '.kai/spec/flows.md',
  'style-guide': '.kai/spec/design/style-guide.md',
  tokens: '.kai/spec/design/tokens.json',
};

/**
 * The same files relative to the spec root, which is what `SpecStore` takes: it prepends `.kai/spec` itself, so
 * handing it the path above would write to `.kai/spec/.kai/spec/brief.md`.
 */
export const ARTIFACT_SPEC_PATHS: Record<ArtifactKind, string> = {
  brief: 'brief.md',
  prd: 'prd.md',
  stories: 'stories.md',
  stack: 'stack.md',
  flows: 'flows.md',
  'style-guide': 'design/style-guide.md',
  tokens: 'design/tokens.json',
};

/** The catalog's own artifact. Written by code, never by a model, so it is always readable. */
export const STUDIO_ARTIFACTS_PATH = 'artifacts.json';

/** What KAI read from open-pencil, kept so a redesign can be told from an unchanged design without asking again. */
export const STUDIO_DESIGN_PATH = 'design/design.json';

/**
 * What each artifact reads. Staleness is a walk of this table, so it is decided in one place instead of in prompts.
 * `brief` is the root: everything below it drifts when it changes.
 */
export const ARTIFACT_DEPENDENCIES: Record<ArtifactKind, readonly ArtifactKind[]> = {
  brief: [],
  prd: ['brief'],
  stories: ['prd'],
  stack: ['brief'],
  flows: ['stories'],
  'style-guide': ['stack'],
  tokens: ['style-guide'],
};

export const artifactEntrySchema = z
  .object({
    kind: artifactKindSchema,
    /** Project-relative, forward slashes. */
    path: z.string().min(1).max(300),
    /** 0 before the file exists; the version each write reports, so history keeps the copy it replaced. */
    version: z.number().int().min(0),
    updatedAt: z.string().min(1),
    /** The model that wrote it, or `code` while it is a seed, or `user` after a hand edit. */
    generatedBy: z.string().min(1).max(120),
    dependsOn: z.array(artifactKindSchema),
    /** True when something it reads has been regenerated since this copy was written. */
    stale: z.boolean(),
    staleReason: z.string().max(300).nullable(),
  })
  .strict();
export type ArtifactEntry = z.infer<typeof artifactEntrySchema>;

export const studioArtifactsSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifacts: z.array(artifactEntrySchema),
  })
  .strict();
export type StudioArtifacts = z.infer<typeof studioArtifactsSchema>;

export function createStudioArtifacts(): StudioArtifacts {
  return { schemaVersion: 1, artifacts: [] };
}

/** Every artifact that (directly or through others) reads `kind`, so a write can mark them all stale. */
export function dependentsOf(kind: ArtifactKind): ArtifactKind[] {
  const found: ArtifactKind[] = [];
  const walk = (target: ArtifactKind): void => {
    for (const candidate of ARTIFACT_KINDS) {
      if (!ARTIFACT_DEPENDENCIES[candidate].includes(target) || found.includes(candidate)) continue;
      found.push(candidate);
      walk(candidate);
    }
  };
  walk(kind);
  return found;
}

/** The artifacts that read `kind`. */
export function directDependencies(kind: ArtifactKind): ArtifactKind[] {
  return [...ARTIFACT_DEPENDENCIES[kind]];
}

// --- The design --------------------------------------------------------------------------------------------

/**
 * One thing in the design the board makes a card of: a component, or a page the editor marked as a screen. `id` is
 * the open-pencil node id, so a card always points back at the node it was drawn from.
 */
export const designComponentSchema = z
  .object({
    id: z.string().min(1).max(300),
    name: z.string().min(1).max(300),
    page: z.string().max(300).default(''),
    /** True for a page (a screen) and false for a component. */
    screen: z.boolean().default(false),
  })
  .strict();
export type DesignComponent = z.infer<typeof designComponentSchema>;

/** What the last pull from open-pencil saw. `hashes` is one hash per node id, which is how a redesign is detected. */
export const studioDesignSchema = z
  .object({
    schemaVersion: z.literal(1),
    endpoint: z.string().max(300),
    pulledAt: z.string().min(1),
    treeHash: z.string().max(120),
    hashes: z.record(z.string(), z.string()),
    components: z.array(designComponentSchema),
  })
  .strict();
export type StudioDesign = z.infer<typeof studioDesignSchema>;

export function createStudioDesign(endpoint = ''): StudioDesign {
  return { schemaVersion: 1, endpoint, pulledAt: new Date(0).toISOString(), treeHash: '', hashes: {}, components: [] };
}

/** The node ids whose hash moved between two pulls. */
export function redesignedNodes(before: StudioDesign, after: StudioDesign): string[] {
  return Object.keys(after.hashes).filter((id) => before.hashes[id] !== after.hashes[id]);
}


// --- The board ---------------------------------------------------------------------------------------------
export const BOARD_STATUSES = ['backlog', 'ready', 'inProgress', 'review', 'done', 'blocked'] as const;
export type BoardStatus = (typeof BOARD_STATUSES)[number];
export const boardStatusSchema = z.enum(BOARD_STATUSES);

export const CARD_KINDS = ['backend', 'component', 'page', 'flow', 'chore'] as const;
export type CardKind = (typeof CARD_KINDS)[number];
export const cardKindSchema = z.enum(CARD_KINDS);

/** The run and check a card was closed on. Kept so `done` can be re-checked, not just trusted. */
export const cardCheckSchema = z
  .object({
    /** The `VerificationRun` id whose hashes must still match the working tree. */
    runId: z.string().min(1),
    at: z.string().min(1),
    /** The visual check's pass, for `component` and `page` cards; null for the rest. */
    visual: z.enum(['passed', 'failed', 'skipped']).nullable(),
    screenshots: z.array(z.string()).default([]),
  })
  .strict();
export type CardCheck = z.infer<typeof cardCheckSchema>;

export const cardRunSchema = z
  .object({
    agent: z.string().min(1).max(120),
    model: z.string().max(120).nullable().default(null),
    at: z.string().min(1),
    /** Files the run changed, project-relative, so a reviewer can see the card's footprint. */
    files: z.array(z.string()).default([]),
  })
  .strict();
export type CardRun = z.infer<typeof cardRunSchema>;

export const boardCardSchema = z
  .object({
    id: z.string().min(1).max(120),
    title: z.string().trim().min(1).max(200),
    kind: cardKindSchema,
    /** The story this card implements, from `stories.md`. */
    story: z.string().max(4_000).default(''),
    acceptance: z.array(z.string().max(400)).max(20).default([]),
    /** The prompt the agent works from; seeded from the story and refined before the card is claimed. */
    prompt: z.string().max(20_000).default(''),
    /** The open-pencil node id when the design produced this card, else null. */
    designRef: z.string().max(300).nullable().default(null),
    /** The path this card is reached at, so the visual check knows which screen to open. */
    route: z.string().max(300).default(''),
    /** Card ids that must be `done` before this card is `ready`. */
    dependsOn: z.array(z.string()).max(50).default([]),
    /** Artifacts this card reads. When one goes stale, so does the card. */
    needsArtifacts: z.array(artifactKindSchema).default([]),
    status: boardStatusSchema.default('backlog'),
    /** Free-form check labels the card must satisfy, shown to the agent and the reviewer. */
    checks: z.array(z.string().max(200)).max(20).default([]),
    check: cardCheckSchema.nullable().default(null),
    runs: z.array(cardRunSchema).max(50).default([]),
    notes: z.string().max(4_000).default(''),
    stale: z.boolean().default(false),
    staleReason: z.string().max(300).nullable().default(null),
    /** Set while an agent holds the card, so two agents never take the same one. */
    claimedBy: z.string().max(120).nullable().default(null),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type BoardCard = z.infer<typeof boardCardSchema>;

export const studioBoardSchema = z
  .object({
    schemaVersion: z.literal(1),
    cards: z.array(boardCardSchema),
  })
  .strict();
export type StudioBoard = z.infer<typeof studioBoardSchema>;

export function createStudioBoard(): StudioBoard {
  return { schemaVersion: 1, cards: [] };
}

/** The cards an agent could pick up right now: `ready`, unclaimed, and every dependency already `done`. */
export function readyCards(board: StudioBoard): BoardCard[] {
  const byId = new Map(board.cards.map((card) => [card.id, card]));
  return board.cards.filter((card) => {
    if (card.status !== 'ready' || card.claimedBy) return false;
    return card.dependsOn.every((id) => byId.get(id)?.status === 'done');
  });
}

/** UI cards are the ones a screenshot can judge: components, pages and the flows that join pages. */
export function isUiCard(card: Pick<BoardCard, 'kind'>): boolean {
  return card.kind === 'component' || card.kind === 'page';
}

/** The artifacts a card of each kind reads, so a generated card is wired into the dependency graph by default. */
export function defaultNeeds(kind: CardKind): ArtifactKind[] {
  if (kind === 'component' || kind === 'page' || kind === 'flow') return ['tokens'];
  if (kind === 'backend') return ['stack'];
  return ['stories'];
}

/**
 * What the model returns when the studio turns the stories into a board. Keys are local refs so dependencies between
 * cards can be expressed before ids exist; `cardsFromDraft` resolves them.
 */
export const studioCardDraftSchema = z
  .object({
    key: z.string().trim().min(1).max(60),
    title: z.string().trim().min(1).max(200),
    kind: cardKindSchema,
    story: z.string().max(4_000).default(''),
    acceptance: z.array(z.string().max(400)).max(20).default([]),
    route: z.string().max(300).default(''),
    dependsOnKeys: z.array(z.string().max(60)).max(50).default([]),
  })
  .strict();
export type StudioCardDraft = z.infer<typeof studioCardDraftSchema>;

export const studioBoardDraftSchema = z.object({ cards: z.array(studioCardDraftSchema).max(200) }).strict();
export type StudioBoardDraft = z.infer<typeof studioBoardDraftSchema>;

// --- The visual check --------------------------------------------------------------------------------------

/** The widths a UI card is captured at: a phone, and a desktop. A layout that only holds at one is not done. */
export const UI_CHECK_VIEWPORTS = [
  { name: 'phone', width: 390 },
  { name: 'desktop', width: 1280 },
] as const;
export type UiCheckViewport = (typeof UI_CHECK_VIEWPORTS)[number];
export const UI_CHECK_THEMES = ['light', 'dark'] as const;
export type UiCheckTheme = (typeof UI_CHECK_THEMES)[number];

/** The states a card must be able to show, since a screen that has none of them is not finished. */
export const UI_REQUIRED_STATES = ['empty', 'loading', 'error', 'disabled'] as const;
export type UiRequiredState = (typeof UI_REQUIRED_STATES)[number];

/** Where a card's screenshots live, relative to `.kai/spec`: one folder per card, one per run. */
export function uiCheckDir(cardId: string, stamp: string): string {
  const safeCard = cardId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80) || 'card';
  const safeStamp = stamp.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 40);
  return `board/${safeCard}/${safeStamp}`;
}

/** One line of the visual report. `id` is stable so the UI can group by it across runs. */
export const uiCheckOutcomeSchema = z
  .object({
    id: z.string().min(1).max(60),
    label: z.string().min(1).max(200),
    passed: z.boolean(),
    detail: z.string().max(600).default(''),
  })
  .strict();
export type UiCheckOutcome = z.infer<typeof uiCheckOutcomeSchema>;

/** What one run of the visual check concluded, and the screenshots it judged. */
export const uiCheckResultSchema = z
  .object({
    cardId: z.string().min(1).max(120),
    at: z.string().min(1),
    passed: z.boolean(),
    route: z.string().max(500).default(''),
    outcomes: z.array(uiCheckOutcomeSchema),
    /** Paths relative to the project root, so a reviewer can open them without guessing. */
    screenshots: z.array(z.string()).default([]),
  })
  .strict();
export type UiCheckResult = z.infer<typeof uiCheckResultSchema>;

// --- IPC inputs --------------------------------------------------------------------------------------------

export const studioProjectInputSchema = z.object({ projectId: z.string().min(1) }).strict();
export type StudioProjectInput = z.infer<typeof studioProjectInputSchema>;

export const studioArtifactInputSchema = z
  .object({ projectId: z.string().min(1), kind: artifactKindSchema })
  .strict();
export type StudioArtifactInput = z.infer<typeof studioArtifactInputSchema>;

export const studioBoardCardInputSchema = z
  .object({ projectId: z.string().min(1), cardId: z.string().min(1).max(120) })
  .strict();
export type StudioBoardCardInput = z.infer<typeof studioBoardCardInputSchema>;

export const studioBoardMoveInputSchema = z
  .object({
    projectId: z.string().min(1),
    cardId: z.string().min(1).max(120),
    status: boardStatusSchema,
    note: z.string().max(4_000).default(''),
  })
  .strict();
export type StudioBoardMoveInput = z.infer<typeof studioBoardMoveInputSchema>;

export const studioBoardClaimInputSchema = z
  .object({ projectId: z.string().min(1), cardId: z.string().min(1).max(120), agent: z.string().min(1).max(120) })
  .strict();
export type StudioBoardClaimInput = z.infer<typeof studioBoardClaimInputSchema>;

/** How many cards one "work the board" click runs, and with which agent and model. */
export const studioBoardWorkInputSchema = z
  .object({
    projectId: z.string().min(1),
    maxCards: z.number().int().min(1).max(12).default(1),
    agent: agentIdSchema.optional(),
    model: z.string().min(1).max(100).optional(),
  })
  .strict();
export type StudioBoardWorkInput = z.infer<typeof studioBoardWorkInputSchema>;

/** What one visual-check run answers with: the card as it now stands, and the report it was judged on. */
export const studioUiCheckResultSchema = z
  .object({
    card: boardCardSchema,
    result: uiCheckResultSchema,
  })
  .strict();
export type StudioUiCheckResult = z.infer<typeof studioUiCheckResultSchema>;

/** What one pull from open-pencil answers with: the design it read, the board it produced, and what moved. */
export const studioDesignPullSchema = z
  .object({
    design: studioDesignSchema,
    board: studioBoardSchema,
    /** The node ids the design changed since the last pull. */
    changed: z.array(z.string()),
    /** False when the token file was already identical, so the artifact's version did not move. */
    tokensChanged: z.boolean(),
    /** How many design tokens the pull read. The style guide itself is written by a model, from these. */
    tokenCount: z.number(),
  })
  .strict();
export type StudioDesignPull = z.infer<typeof studioDesignPullSchema>;

/** A stable, readable card id from the draft's key, so a regenerated board keeps the same ids and their work. */
export function cardIdFromKey(key: string): string {
  const slug = key.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return slug || 'card';
}

/** Resolves the draft's key-based dependencies into card ids and fills in the artifact needs. */
export function cardsFromDraft(draft: StudioBoardDraft, at: string): BoardCard[] {
  const idByKey = new Map(draft.cards.map((item) => [item.key, cardIdFromKey(item.key)]));
  const seen = new Set<string>();
  return draft.cards.flatMap((item) => {
    let id = idByKey.get(item.key) ?? cardIdFromKey(item.key);
    // Two drafts whose keys slug to the same id would otherwise collide; the second gets a suffix.
    let suffix = 2;
    while (seen.has(id)) id = `${cardIdFromKey(item.key)}-${suffix++}`;
    seen.add(id);
    return [
      boardCardSchema.parse({
        id,
        title: item.title,
        kind: item.kind,
        story: item.story,
        acceptance: item.acceptance,
        route: item.route,
        needsArtifacts: defaultNeeds(item.kind),
        dependsOn: item.dependsOnKeys.map((key) => idByKey.get(key) ?? cardIdFromKey(key)).filter((dependency) => dependency !== id),
        status: 'backlog',
        createdAt: at,
        updatedAt: at,
      }),
    ];
  });
}
