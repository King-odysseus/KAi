import { z } from 'zod';
import { agentIdSchema, timestampSchema } from './primitives';

/**
 * Autopilot works a Project Studio board from the first ready card to the last, on its own: one agent per card, a
 * check after each, a retry with the failure when the check fails, a rest when a provider says it has had enough, and
 * a dev proof at the end that the app actually runs. These are the settings it starts from and the status it reports;
 * the loop itself lives in the main process.
 */

export const AUTOPILOT_PHASES = ['idle', 'working', 'checking', 'cooling', 'finished', 'stopped', 'failed'] as const;
export type AutopilotPhase = (typeof AUTOPILOT_PHASES)[number];

export const autopilotStartInputSchema = z
  .object({
    projectId: z.string().min(1),
    /** `api` runs through Direct API (DeepSeek and the rest); `cli` through one of the installed agents. */
    execution: z.enum(['cli', 'api']).default('api'),
    agent: agentIdSchema.optional(),
    model: z.string().min(1).max(100).optional(),
    /** The command that decides whether a card's work builds and passes. Blank uses the one KAI detects for the project. */
    checkCommand: z.string().trim().max(1_000).default(''),
    /** Stops after this many cards in one run, so a runaway board still ends. */
    maxCards: z.number().int().min(1).max(500).default(100),
    /** Tries a card gets, the first one included, before it is parked as blocked and Autopilot moves on. */
    attemptsPerCard: z.number().int().min(1).max(5).default(3),
    /** Stops once the run's estimated spend passes this many USD; zero means no limit. */
    maxCostUsd: z.number().min(0).max(10_000).default(0),
    /** Stops after this many hours, resting time included; zero means no limit. */
    maxHours: z.number().min(0).max(168).default(12),
    /** The least seconds between two API requests; the pace widens by itself when the provider pushes back. */
    minGapSeconds: z.number().min(0).max(120).default(0),
    /** How unattended runs use decisions recorded in the project decision log when a card is blocked. */
    blockerPolicy: z.enum(['continue-and-report', 'continue-and-use-decisions']).default('continue-and-report'),
  })
  .strict();
export type AutopilotStartInput = z.infer<typeof autopilotStartInputSchema>;

export const autopilotProjectInputSchema = z.object({ projectId: z.string().min(1) }).strict();
export type AutopilotProjectInput = z.infer<typeof autopilotProjectInputSchema>;

export const autopilotLogEntrySchema = z
  .object({
    at: z.string().min(1),
    kind: z.enum(['info', 'card', 'check', 'rest', 'warn']),
    text: z.string().max(500),
  })
  .strict();
export type AutopilotLogEntry = z.infer<typeof autopilotLogEntrySchema>;

/** Durable copy of a run log entry. Unlike live status, this survives a completed or interrupted run. */
export const autopilotAuditEntrySchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1).max(120),
  projectId: z.string().min(1),
  at: timestampSchema,
  kind: z.enum(['info', 'card', 'check', 'rest', 'warn']),
  text: z.string().max(500),
  cardId: z.string().max(120).nullable(),
}).strict();
export type AutopilotAuditEntry = z.infer<typeof autopilotAuditEntrySchema>;

/** One route the run's dev proof loaded, and what the page showed. */
export const devRouteResultSchema = z
  .object({
    route: z.string().max(300),
    ok: z.boolean(),
    /** Empty when `ok`; otherwise one line saying what the page did wrong. */
    problem: z.string().max(600),
  })
  .strict();
export type DevRouteResult = z.infer<typeof devRouteResultSchema>;

/**
 * The run's proof that the app actually runs, taken on the local dev server once the board is finished.
 *
 * Every other check answers "does the code hold up". This answers the question the person asks when they walk away
 * and come back — is there an app on dev I can open — and it is the only place in Autopilot that claims as much. A
 * failure here is not a failed run: the cards really are done, and this is what the result turned out to be.
 */
export const devCheckResultSchema = z
  .object({
    passed: z.boolean(),
    /** One line naming the outcome, for the run log and the panel. */
    summary: z.string().max(600),
    /** Where the app is serving, so the person can open it; null when it never started. */
    url: z.string().max(500).nullable(),
    routes: z.array(devRouteResultSchema).max(100),
  })
  .strict();
export type DevCheckResult = z.infer<typeof devCheckResultSchema>;

export const autopilotStatusSchema = z
  .object({
    projectId: z.string().min(1),
    phase: z.enum(AUTOPILOT_PHASES),
    /** One plain sentence on what it is doing or why it stopped. */
    message: z.string().max(600),
    /**
     * The last dev proof this run took, or null while it has not reached one. Kept on the status rather than in the
     * log so the screen can name the URL, and so a person who comes back to a finished run has something to open.
     */
    devCheck: devCheckResultSchema.nullable().default(null),
    cardId: z.string().nullable(),
    cardTitle: z.string().nullable(),
    /** The conversation the agent is working in right now, so the composer can show it. */
    conversationId: z.string().nullable().default(null),
    attempt: z.number().int().min(0),
    /** Set while resting: when work picks up again. */
    resumeAt: z.string().nullable(),
    restReason: z.string().max(400).nullable(),
    /** Rests taken in a row without a card finishing between them; it drives how long the next one is. */
    restStreak: z.number().int().min(0),
    restsTotal: z.number().int().min(0),
    cardsDone: z.number().int().min(0),
    cardsBlocked: z.number().int().min(0),
    cardsTotal: z.number().int().min(0),
    /** Cards this run has taken on, counted against `maxCards`. */
    cardsWorked: z.number().int().min(0),
    costUsd: z.number().min(0),
    startedAt: z.string().nullable(),
    updatedAt: z.string().min(1),
    log: z.array(autopilotLogEntrySchema).max(60),
  })
  .strict();
export type AutopilotStatus = z.infer<typeof autopilotStatusSchema>;

export const autopilotStatusResponseSchema = autopilotStatusSchema.nullable();

/**
 * One run, written to disk for the whole time it is going and removed when it settles — so a file still there at
 * startup is a run the app was closed in the middle of.
 *
 * The status above lives in memory and dies with the process, which left the person nothing to go on and the board
 * holding a card claimed by an Autopilot that no longer existed. This is the small amount of state needed to say
 * which card was in flight and to start it again: the loop already prefers the card it still holds, and the figures
 * either side of this file are read back off the board.
 */
export const autopilotRunRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** The Studio plan's own id, which is what Autopilot statuses are keyed by. */
    studioProjectId: z.string().min(1),
    cardId: z.string().min(1),
    cardTitle: z.string(),
    startedAt: timestampSchema,
    updatedAt: timestampSchema,
    /** The last thing the run said, so the report of an interrupted run is about the card it was on. */
    lastMessage: z.string().max(600),
    /** Everything needed to start the same run again unchanged, including the limits it was given. */
    start: autopilotStartInputSchema,
  })
  .strict();
export type AutopilotRunRecord = z.infer<typeof autopilotRunRecordSchema>;

export const autopilotInterruptedInputSchema = z.object({ studioProjectId: z.string().min(1) }).strict();
export type AutopilotInterruptedInput = z.infer<typeof autopilotInterruptedInputSchema>;

export const autopilotAuditInputSchema = z.object({ projectId: z.string().min(1) }).strict();
export type AutopilotAuditInput = z.infer<typeof autopilotAuditInputSchema>;

