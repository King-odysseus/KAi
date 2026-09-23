import { z } from 'zod';
import { agentIdSchema, autonomyModeSchema, routeModeSchema, schemaVersionSchema, timestampSchema } from './primitives';

const eventBaseSchema = z.object({
  schemaVersion: schemaVersionSchema,
  id: z.string().min(1),
  taskId: z.string().min(1),
  timestamp: timestampSchema,
  agent: agentIdSchema.optional(),
});

export const textDeltaEventSchema = eventBaseSchema.extend({
  type: z.literal('text.delta'),
  text: z.string(),
  channel: z.enum(['assistant', 'summary', 'raw']),
});

export const toolCallEventSchema = eventBaseSchema.extend({
  type: z.literal('tool.call'),
  name: z.string().min(1),
  status: z.enum(['started', 'updated', 'completed', 'failed']),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
});

export const approvalRequestEventSchema = eventBaseSchema.extend({
  type: z.literal('approval.request'),
  requestId: z.string().min(1).optional(),
  tool: z.string().min(1).optional(),
  title: z.string().min(1),
  detail: z.string(),
  risk: z.enum(['low', 'medium', 'high']),
});

export const diffProposalEventSchema = eventBaseSchema.extend({
  type: z.literal('diff.proposal'),
  filePath: z.string().min(1),
  summary: z.string(),
  diff: z.string().optional(),
});

export const fileEditAppliedEventSchema = eventBaseSchema.extend({
  type: z.literal('file.edit.applied'),
  filePath: z.string().min(1),
  summary: z.string(),
});

export const fileChangeEventSchema = eventBaseSchema.extend({
  type: z.literal('file.change'),
  path: z.string().min(1),
  action: z.enum(['edited', 'created', 'deleted']),
  added: z.number().int().nonnegative().optional(),
  removed: z.number().int().nonnegative().optional(),
});

export const autonomyChangedEventSchema = eventBaseSchema.extend({
  type: z.literal('autonomy.changed'),
  from: autonomyModeSchema,
  to: autonomyModeSchema,
});

export const permissionEscalationEventSchema = eventBaseSchema.extend({
  type: z.literal('permission.escalation'),
  permission: z.string().min(1),
  reason: z.string(),
});

export const errorEventSchema = eventBaseSchema.extend({
  type: z.literal('error'),
  message: z.string().min(1),
  recoverable: z.boolean(),
});

export const costUpdateEventSchema = eventBaseSchema.extend({
  type: z.literal('cost.update'),
  amountUsd: z.number().nonnegative().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  sessionId: z.string().optional(),
  estimateProvenance: z.enum(['measured', 'estimated', 'unknown']).optional(),
});

export const memoryEventSchema = eventBaseSchema.extend({
  type: z.literal('memory.event'),
  action: z.enum(['session_start', 'recall', 'handoff', 'learn', 'session_end']),
  summary: z.string(),
});

export const routeChangedEventSchema = eventBaseSchema.extend({
  type: z.literal('route.changed'),
  from: routeModeSchema,
  to: routeModeSchema,
});

export const agentLifecycleEventSchema = eventBaseSchema.extend({
  type: z.literal('agent.lifecycle'),
  status: z.enum(['starting', 'running', 'paused', 'completed', 'failed', 'cancelled', 'interrupted']),
  detail: z.string().optional(),
});

export const rawFallbackEventSchema = eventBaseSchema.extend({
  type: z.literal('raw.fallback'),
  sourceType: z.string().min(1),
  payload: z.unknown(),
});

export const planUpdateEventSchema = eventBaseSchema.extend({
  type: z.literal('plan.update'),
  plan: z.record(z.unknown()),
});

export const turnChangesEventSchema = eventBaseSchema.extend({
  type: z.literal('turn.changes'),
  files: z.array(
    z.object({
      path: z.string().min(1),
      added: z.number().int().nonnegative(),
      removed: z.number().int().nonnegative(),
    }),
  ),
  hasCheckpoint: z.boolean(),
});

export const sessionLifecycleEventSchema = eventBaseSchema.extend({
  type: z.literal('session.lifecycle'),
  lifecycleType: z.enum(['session_start', 'session_end', 'handoff', 'agent_switch', 'interrupted']),
  description: z.string(),
  previousAgent: agentIdSchema.optional(),
});

export const persistedEventV1Schema = z.discriminatedUnion('type', [
  textDeltaEventSchema,
  toolCallEventSchema,
  approvalRequestEventSchema,
  diffProposalEventSchema,
  fileEditAppliedEventSchema,
  fileChangeEventSchema,
  autonomyChangedEventSchema,
  permissionEscalationEventSchema,
  errorEventSchema,
  costUpdateEventSchema,
  memoryEventSchema,
  routeChangedEventSchema,
  agentLifecycleEventSchema,
  rawFallbackEventSchema,
  planUpdateEventSchema,
  turnChangesEventSchema,
  sessionLifecycleEventSchema,
]);

export const persistedEventSchema = persistedEventV1Schema;

export type PersistedEvent = z.infer<typeof persistedEventV1Schema>;
export type EventType = PersistedEvent['type'];

export function parsePersistedEvent(input: unknown): PersistedEvent {
  return persistedEventV1Schema.parse(input);
}

export function safeParsePersistedEvent(input: unknown): z.SafeParseReturnType<unknown, PersistedEvent> {
  return persistedEventV1Schema.safeParse(input);
}
