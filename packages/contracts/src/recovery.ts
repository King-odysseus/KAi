import { z } from 'zod';
import { agentIdSchema, autonomyModeSchema, executionModeSchema, routeModeSchema, timestampSchema } from './primitives';
import { checkpointRecordSchema } from './workbench';

export const recoveryRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    conversationId: z.string().min(1),
    projectId: z.string().nullable(),
    title: z.string(),
    agent: agentIdSchema,
    execution: executionModeSchema,
    route: routeModeSchema,
    autonomy: autonomyModeSchema,
    prompt: z.string(),
    goal: z.string().nullable(),
    startedAt: timestampSchema,
    updatedAt: timestampSchema,
    eventCount: z.number().int().nonnegative(),
    lastActivity: z.string(),
    checkpoint: checkpointRecordSchema.nullable(),
  })
  .strict();

export const recoveryRecapSchema = z
  .object({
    conversationId: z.string().min(1),
    recap: z.string(),
    // Recap held by the managed Cognitive1 service, when it is running and has one.
    brainRecap: z.string().nullable(),
  })
  .strict();

export const recoveryResumeSchema = z
  .object({
    conversationId: z.string().min(1),
    prompt: z.string().min(1),
    agent: agentIdSchema,
    execution: executionModeSchema,
    route: routeModeSchema,
    autonomy: autonomyModeSchema,
  })
  .strict();

/**
 * What a "stop everything" pass achieved. Both counts are reported rather than a bare success, because the two
 * halves answer different questions: how many live runs were asked to stop, and how many records left behind by
 * runs that already died were cleared.
 */
export const stopAllRunsResultSchema = z
  .object({
    stoppedRuns: z.number().int().nonnegative(),
    clearedRuns: z.number().int().nonnegative(),
  })
  .strict();

/**
 * What is on disk for recovery: the runs that can still be acted on, and the ones whose record cannot be read.
 *
 * The second list is carried rather than dropped because an unreadable record is still an interrupted run. A
 * count that quietly leaves it out tells the person fewer runs are stranded than really are, which is exactly
 * the wrong thing for the one screen they open when something has gone wrong.
 */
export const recoveryListingSchema = z
  .object({
    records: z.array(recoveryRecordSchema),
    unreadable: z.array(z.string().min(1)),
  })
  .strict();

export type RecoveryRecord = z.infer<typeof recoveryRecordSchema>;
export type RecoveryRecap = z.infer<typeof recoveryRecapSchema>;
export type RecoveryResume = z.infer<typeof recoveryResumeSchema>;
export type RecoveryListing = z.infer<typeof recoveryListingSchema>;
export type StopAllRunsResult = z.infer<typeof stopAllRunsResultSchema>;

/** Rough token estimate (4 characters per token) for the part of a conversation still sent to the model. */
export function estimateConversationTokens(conversation: {
  turns: ReadonlyArray<{ text: string }>;
  compaction?: { throughTurnIndex: number; summary: string };
}): number {
  const live = conversation.compaction
    ? conversation.turns.slice(conversation.compaction.throughTurnIndex + 1)
    : conversation.turns;
  const characters = live.reduce((total, turn) => total + turn.text.length, 0) + (conversation.compaction?.summary.length ?? 0);
  return Math.ceil(characters / 4);
}

/** Warn well before typical context windows fill, so compaction is a choice rather than a failure. */
export const COMPACTION_WARNING_TOKENS = 60_000;
