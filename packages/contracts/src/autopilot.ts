import { z } from 'zod';
import { agentIdSchema } from './primitives';

/**
 * Autopilot works a Project Studio board from the first ready card to the last, on its own: one agent per card, a
 * check after each, a retry with the failure when the check fails, and a rest when a provider says it has had enough.
 * These are the settings it starts from and the status it reports; the loop itself lives in the main process.
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

export const autopilotStatusSchema = z
  .object({
    projectId: z.string().min(1),
    phase: z.enum(AUTOPILOT_PHASES),
    /** One plain sentence on what it is doing or why it stopped. */
    message: z.string().max(600),
    cardId: z.string().nullable(),
    cardTitle: z.string().nullable(),
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
