import { z } from 'zod';
import { contextChipSchema } from './context';
import { agentIdSchema, autonomyModeSchema, executionModeSchema, routeModeSchema } from './primitives';
import { goalInputSchema } from './workbench';

export const queuedPromptSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  text: z.string(),
  options: z.object({
    goal: goalInputSchema.optional(),
    skills: z.array(z.string()).optional(),
    selectedPaths: z.array(z.string()).optional(),
    contextChips: z.array(contextChipSchema).optional(),
    agent: agentIdSchema.optional(),
    execution: executionModeSchema.optional(),
    route: routeModeSchema.optional(),
    autonomy: autonomyModeSchema.optional(),
    model: z.string().optional(),
  }).passthrough(),
  status: z.enum(['queued', 'sending', 'blocked']),
  error: z.string().optional(),
}).strict();

export const composerQueueSchema = z.record(z.string(), z.array(queuedPromptSchema));
export const composerQueueStoreSchema = z.object({ version: z.literal(1), queues: composerQueueSchema }).strict();
export const composerQueueAddInputSchema = z.object({ item: queuedPromptSchema, first: z.boolean().optional() }).strict();
export const composerQueueUpdateInputSchema = z.object({
  conversationId: z.string().min(1), id: z.string().min(1), action: z.enum(['remove', 'retry', 'promote', 'sending', 'accepted', 'block']), error: z.string().optional(),
}).strict();
export const composerQueueClaimInputSchema = z.object({ conversationId: z.string().min(1), id: z.string().min(1) }).strict();
export const composerQueueHoldInputSchema = z.object({ error: z.string().min(1) }).strict();
export const composerQueueConversationInputSchema = z.object({ conversationId: z.string().min(1) }).strict();
export type QueuedPrompt = z.infer<typeof queuedPromptSchema>;
export type ComposerQueue = z.infer<typeof composerQueueSchema>;
