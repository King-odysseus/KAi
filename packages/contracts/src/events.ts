import { z } from 'zod';
import { agentIdSchema, autonomyModeSchema, routeModeSchema, schemaVersionSchema, timestampSchema } from './primitives';

const eventBaseSchema = z.object({
  schemaVersion: schemaVersionSchema,
  id: z.string().min(1),
  taskId: z.string().min(1),
  timestamp: timestampSchema,
  agent: agentIdSchema.optional(),
  /**
   * How much of the reply had been written when this happened, in characters. It is what lets the transcript put a
   * tool call between the sentences that came before and after it, instead of listing every call under all the prose.
   */
  textOffset: z.number().int().nonnegative().optional(),
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
  /** The CLI's own id for this call (e.g. a `tool_use` block's id), so a later completion can be matched to it. */
  callId: z.string().optional(),
});

export const approvalRequestEventSchema = eventBaseSchema.extend({
  type: z.literal('approval.request'),
  requestId: z.string().min(1).optional(),
  tool: z.string().min(1).optional(),
  title: z.string().min(1),
  detail: z.string(),
  risk: z.enum(['low', 'medium', 'high']),
  /**
   * Present when the run is asking about itself — "carry on, or stop and sum up?" — rather than a tool asking for
   * permission. Its two answers are named actions, not allow and deny, so a surface that shows this must use these
   * words: offering "Allow once" for a question about spending money reads as consent to spend, and the full-access
   * button next to it turns a limit prompt into a permanent grant.
   */
  runQuestion: z
    .object({
      continueLabel: z.string().min(1),
      finishLabel: z.string().min(1),
    })
    .optional(),
  /**
   * Present when the model asked a question through the `ask_user` tool rather than a tool asking for permission.
   * The person's chosen option (or free text, when the tool allowed it) travels back as `answer` on the response
   * and becomes the tool's output, so this is not an allow/deny decision — a surface rendering this must show these
   * as answer choices, not as permission buttons.
   */
  options: z.array(z.string().min(1).max(200)).min(2).max(4).optional(),
  allowFreeText: z.boolean().optional(),
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
  // Set for runs that cost money: a paid API run, or a CLI run through the Universal Proxy, which reaches a provider
  // the account pays for. A subscription CLI run carries none, which is what keeps it out of the usage budget.
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
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
  turnId: z.string().min(1).optional(),
  files: z.array(
    z.object({
      path: z.string().min(1),
      added: z.number().int().nonnegative(),
      removed: z.number().int().nonnegative(),
    }),
  ),
  hasCheckpoint: z.boolean(),
});

/**
 * A short, factual statement about the run that the person should see in the conversation itself, not buried in the
 * collapsible Activity list — standing rules having been applied this turn is the first use. Unlike `agent.lifecycle`
 * (which has no rendering of its own and exists only to feed the Activity summary), this is meant to be read.
 */
export const noticeEventSchema = eventBaseSchema.extend({
  type: z.literal('notice'),
  message: z.string().min(1),
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
  noticeEventSchema,
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
