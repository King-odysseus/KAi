import { z } from 'zod';
import { contextChipSchema } from './context';
import { cliModelNameSchema } from './domain';
import { agentIdSchema, autonomyModeSchema, executionModeSchema, routeModeSchema } from './primitives';
import { goalInputSchema } from './workbench';

/**
 * Auto mode works one composer task in one conversation, on its own, until the check command passes. It is not the
 * Studio's Autopilot: that walks a board of cards, this carries a single task across turns. The two share the
 * rate-limit vocabulary (and nothing else), because both have to survive a provider saying it has had enough.
 *
 * The one thing Auto adds is a decision the board loop never makes: when the CLI's usage window is spent it moves to
 * the API model and keeps working, then returns to the CLI when the window reopens. Playing a person's part here is
 * deliberate only when there is nothing left it can do - see AUTO_WAIT_REASONS.
 */

export const AUTO_PHASES = [
  'idle',
  'starting',
  'working',
  'checking',
  'switching-provider',
  'cooling',
  'waiting-for-you',
  'splitting',
  'finished',
  'stopped',
  'failed',
] as const;
export type AutoPhase = (typeof AUTO_PHASES)[number];

/**
 * The token a model prints to hand the rest of an oversized task to a fresh conversation. It is an exact marker and a
 * JSON payload, not a phrase to be guessed at: reading intent out of prose is how a loop ends up splitting on the
 * sentence "this might be too big" while it is doing fine.
 */
export const AUTO_SPLIT_SENTINEL = '<<KAI_SPLIT>>';

export const autoSplitDirectiveSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    briefing: z.string().trim().min(1).max(20_000),
  })
  .strict();
export type AutoSplitDirective = z.infer<typeof autoSplitDirectiveSchema>;

/** Why Auto stopped and is waiting for a person rather than pressing on. */
export const AUTO_WAIT_REASONS = [
  /** The run hit an approval prompt, or the access level makes it ask permission. */
  'approval',
  /** The same check failure, with no files changed, came back several turns in a row: the setup is wrong, not the code. */
  'repeated-failure',
  /** The CLI window is spent and there is no usable API provider to hand off to. */
  'no-fallback',
  'cost-cap',
  'time-cap',
  'turn-cap',
] as const;
export type AutoWaitReason = (typeof AUTO_WAIT_REASONS)[number];

export const autoStartInputSchema = z
  .object({
    /** Continue an open conversation; without it a new one is created for the task. */
    conversationId: z.string().min(1).optional(),
    projectId: z.string().min(1),
    /** The composer's own prompt, sent as the first turn. */
    prompt: z.string().trim().min(1).max(20_000),
    /** The provider the first turn runs on. Auto may move to the other one and back as limits demand. */
    execution: executionModeSchema.default('cli'),
    agent: agentIdSchema,
    model: cliModelNameSchema.optional(),
    route: routeModeSchema,
    autonomy: autonomyModeSchema,
    /** The command that decides the task is done. Auto refuses to start without one: it is the only honest "done". */
    checkCommand: z.string().trim().max(1_000).default(''),
    /** Stops after this many turns, so a task that never converges still ends. */
    maxTurns: z.number().int().min(1).max(500).default(40),
    /** Stops once the run's estimated spend passes this many USD; zero means no limit. */
    maxCostUsd: z.number().min(0).max(10_000).default(0),
    /** Stops after this many hours, cooling included; zero means no limit. */
    maxHours: z.number().min(0).max(168).default(12),
    /** Hands off to the Direct API provider when the CLI's usage window is spent, and back when it reopens. */
    apiFallback: z.boolean().default(true),
    /** The least seconds between two API requests; the pace widens by itself when the provider pushes back. */
    minGapSeconds: z.number().min(0).max(120).default(0),
    /** Identical check failures in a row before Auto stops and asks, rather than retrying the same wall. */
    maxRepeatedFailures: z.number().int().min(1).max(10).default(3),
    /** Turns already taken against `maxTurns`, when an earlier session is being picked back up. */
    turnsUsed: z.number().int().min(0).default(0),
    /** Split levels already spent, so a chain of new tabs cannot go on forever. */
    splitDepth: z.number().int().min(0).max(10).default(0),
    // The composer's context, carried through to every turn exactly as a normal send would.
    goal: goalInputSchema.optional(),
    skills: z.array(z.string().min(1).max(200)).max(50).optional(),
    selectedPaths: z.array(z.string().min(1).max(2_000)).max(50).optional(),
    contextChips: z.array(contextChipSchema).max(50).optional(),
  })
  .strict();
export type AutoStartInput = z.infer<typeof autoStartInputSchema>;
/**
 * What a caller sends. The schema fills every default in, so the panel can leave the tuning knobs it has no view of
 * (`turnsUsed`, `splitDepth`) out entirely.
 */
export type AutoStartRequest = z.input<typeof autoStartInputSchema>;

export const autoConversationInputSchema = z.object({ conversationId: z.string().min(1) }).strict();
export type AutoConversationInput = z.infer<typeof autoConversationInputSchema>;

export const autoLogEntrySchema = z
  .object({
    at: z.string().min(1),
    kind: z.enum(['info', 'turn', 'check', 'provider', 'rest', 'split', 'warn']),
    text: z.string().max(500),
  })
  .strict();
export type AutoLogEntry = z.infer<typeof autoLogEntrySchema>;

/** Which provider a turn is running on, and which one Auto would fall back to. */
export const autoProviderRefSchema = z
  .object({
    /** The API provider's display name, such as "DeepSeek". */
    name: z.string().min(1).max(120),
    model: z.string().max(120).nullable(),
  })
  .strict();
export type AutoProviderRef = z.infer<typeof autoProviderRefSchema>;

export const autoStatusSchema = z
  .object({
    conversationId: z.string().min(1),
    projectId: z.string().min(1),
    phase: z.enum(AUTO_PHASES),
    /** One plain sentence on what it is doing or why it stopped. */
    message: z.string().max(600),
    /** Turns run so far, and the cap they count against. */
    turnCount: z.number().int().min(0),
    maxTurns: z.number().int().min(1),
    checkCommand: z.string().max(1_000),
    checkStatus: z.enum(['unknown', 'passing', 'failing']),
    /** The provider the current (or next) turn runs on. */
    activeProvider: z.enum(['cli', 'api']),
    /** Set once Auto has moved off the CLI, so the panel can name what it moved to. */
    fallbackProvider: autoProviderRefSchema.nullable(),
    /** When the CLI's usage window reopens, while Auto is working on the API in the meantime. */
    cliResumeAt: z.string().nullable(),
    /** Set while cooling after a burst limit: when the same provider is tried again. */
    resumeAt: z.string().nullable(),
    restReason: z.string().max(400).nullable(),
    /** Set while waiting for a person, so the panel can say what it is waiting for. */
    waitReason: z.enum(AUTO_WAIT_REASONS).nullable(),
    waitDetail: z.string().max(600).nullable(),
    /** How many times this task has been handed to a new tab. */
    splitCount: z.number().int().min(0),
    costUsd: z.number().min(0),
    startedAt: z.string().nullable(),
    updatedAt: z.string().min(1),
    log: z.array(autoLogEntrySchema).max(60),
  })
  .strict();
export type AutoStatus = z.infer<typeof autoStatusSchema>;

export const autoStatusResponseSchema = autoStatusSchema.nullable();
