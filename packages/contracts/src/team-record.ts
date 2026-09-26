import { z } from 'zod';
import { routeModeSchema, timestampSchema } from './primitives';
import { agentTeamSchema, teamPartRoleSchema, teamResolvedAssigneeSchema } from './team';

export const teamRecordEntrySchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  role: teamPartRoleSchema,
  custom: z.boolean(),
  assignee: teamResolvedAssigneeSchema,
  route: routeModeSchema,
  model: z.string().max(240).optional(),
  startedAt: timestampSchema,
  durationMs: z.number().nonnegative(),
  costUsd: z.number().nonnegative().optional(),
  outcome: z.enum(['completed', 'failed']),
  neededFix: z.boolean(),
  blockedByReview: z.boolean(),
  overridden: z.boolean(),
}).strict();

export const teamRecordStatsSchema = z.object({
  role: teamPartRoleSchema,
  assignee: teamResolvedAssigneeSchema,
  scope: z.enum(['project', 'all']),
  jobs: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  successRate: z.number().min(0).max(1),
  medianDurationMs: z.number().nonnegative(),
  totalCostUsd: z.number().nonnegative(),
}).strict();

export const teamRecordAdviceSchema = z.object({
  role: teamPartRoleSchema,
  current: teamResolvedAssigneeSchema,
  records: z.array(teamRecordStatsSchema),
  suggestion: z.object({
    assignee: teamResolvedAssigneeSchema,
    text: z.string(),
    fingerprint: z.string(),
  }).strict().optional(),
}).strict();

export const teamRecordQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  team: agentTeamSchema,
}).strict();

export type TeamRecordEntry = z.infer<typeof teamRecordEntrySchema>;
export type TeamRecordStats = z.infer<typeof teamRecordStatsSchema>;
export type TeamRecordAdvice = z.infer<typeof teamRecordAdviceSchema>;
export type TeamRecordQuery = z.infer<typeof teamRecordQuerySchema>;
