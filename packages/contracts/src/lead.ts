import { z } from 'zod';
import { roleTargetSchema } from './architect';

export const leadCycleSchema = z.object({ rootId: z.string(), depth: z.number().int().nonnegative(), repairs: z.number().int().nonnegative(), spentUsd: z.number().nonnegative(), failures: z.array(z.string()) }).strict();
export const leadCompletionSchema = z.object({
  resultTurnId: z.string(),
  state: z.enum(['review-needed', 'passed', 'needs-repair', 'not-checked', 'needs-you']),
  reason: z.string(),
  recordedAt: z.string(),
  checks: z.array(z.object({ command: z.string(), exitCode: z.number(), output: z.string(), timestamp: z.string() }).strict()),
  missingChecks: z.array(z.string()),
  criteria: z.array(z.string()),
  files: z.array(z.object({ path: z.string(), hash: z.string() }).strict()),
  reviewTurnId: z.string().optional(),
  reviewVerdict: z.enum(['pass', 'changes', 'needs-you']).optional(),
  reviewedBy: roleTargetSchema.optional(),
  notified: z.boolean().optional(),
  continuationNote: z.string().optional(),
}).strict();

export const leadDeliverySettingsSchema = z.object({
  reviewer: roleTargetSchema.nullable().default(null),
  autoReview: z.boolean().default(false),
  maxTasks: z.number().int().min(1).max(5).default(3),
  maxRepairs: z.number().int().min(0).max(2).default(2),
  maxUsd: z.number().positive().max(100).default(1),
}).strict();
export type LeadCompletion = z.infer<typeof leadCompletionSchema>;
export type LeadCycle = z.infer<typeof leadCycleSchema>;
export type LeadDeliverySettings = z.infer<typeof leadDeliverySettingsSchema>;
