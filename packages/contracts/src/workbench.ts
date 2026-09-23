import { z } from 'zod';
import {
  agentIdSchema,
  autonomyModeSchema,
  executionModeSchema,
  permissionKeySchema,
  routeModeSchema,
  timestampSchema,
} from './primitives';

export const goalInputSchema = z
  .object({
    outcome: z.string().trim().min(1).max(4_000),
    constraints: z.string().trim().max(8_000).optional().default(''),
    verification: z.string().trim().max(8_000).optional().default(''),
  })
  .strict();

export const workbenchGoalStatusSchema = z.enum(['running', 'paused', 'completed']);

export const workbenchGoalSchema = z
  .object({
    id: z.string().min(1),
    outcome: z.string().min(1),
    constraints: z.string(),
    verification: z.string(),
    status: workbenchGoalStatusSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    startedAt: timestampSchema,
    pausedAt: timestampSchema.optional(),
    completedAt: timestampSchema.optional(),
  })
  .strict();

export const skillSummarySchema = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    path: z.string().min(1),
    root: z.string().min(1),
    scope: z.enum(['repo', 'user']),
  })
  .strict();

export const workflowStepStatusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'skipped']);

export const workflowStepSchema = z
  .object({
    id: z.string().min(1),
    agent: agentIdSchema,
    prompt: z.string().trim().min(1).max(20_000),
    label: z.string().max(200).optional(),
    dependsOn: z.array(z.string().min(1)).optional(),
    status: workflowStepStatusSchema,
    error: z.string().optional(),
    output: z.string().optional(),
    startedAt: timestampSchema.optional(),
    completedAt: timestampSchema.optional(),
  })
  .strict();

export const workflowStatusSchema = z.enum(['ready', 'running', 'paused', 'completed', 'aborted']);

export const workflowSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().trim().min(1).max(200),
    steps: z.array(workflowStepSchema).min(1).max(50),
    route: routeModeSchema,
    autonomy: autonomyModeSchema,
    status: workflowStatusSchema,
    currentStepIndex: z.number().int().nonnegative(),
    createdAt: timestampSchema,
    completedAt: timestampSchema.optional(),
  })
  .strict();

export const workflowTemplateSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2_000).default(''),
    steps: z
      .array(
        z
          .object({
            agent: agentIdSchema,
            prompt: z.string().trim().min(1).max(20_000),
            label: z.string().max(200).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    route: routeModeSchema,
    autonomy: autonomyModeSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const workflowTemplateSaveInputSchema = workflowTemplateSchema.omit({
  createdAt: true,
  updatedAt: true,
}).extend({
  createdAt: timestampSchema.optional(),
  updatedAt: timestampSchema.optional(),
});

export const permissionKeyInfoSchema = z
  .object({
    key: permissionKeySchema,
    label: z.string().min(1),
    description: z.string().min(1),
  })
  .strict();

export const checkpointRecordSchema = z
  .object({
    ref: z.string().min(1),
    untracked: z.array(z.string().min(1)),
    createdAt: timestampSchema,
  })
  .strict();

export const turnFileChangeSchema = z
  .object({
    path: z.string().min(1),
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
  })
  .strict();

export const checkpointFileReviewSchema = turnFileChangeSchema
  .extend({
    before: z.string(),
    after: z.string(),
    binary: z.boolean(),
  })
  .strict();

export const checkpointReviewSchema = z
  .object({
    conversationId: z.string().min(1),
    turnId: z.string().min(1),
    gitAvailable: z.boolean(),
    files: z.array(checkpointFileReviewSchema),
  })
  .strict();

export const checkpointRestoreResultSchema = z
  .object({
    restored: z.array(z.string().min(1)),
    deleted: z.array(z.string().min(1)),
  })
  .strict();

export const checkpointTurnInputSchema = z
  .object({
    conversationId: z.string().min(1),
    turnId: z.string().min(1),
  })
  .strict();

export const checkpointRejectInputSchema = checkpointTurnInputSchema
  .extend({
    filePath: z.string().min(1).max(2_000),
  })
  .strict();

export const compareSideSchema = z
  .object({
    agent: agentIdSchema,
    output: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
    elapsedMs: z.number().int().nonnegative(),
    files: z.array(turnFileChangeSchema),
    worktreePath: z.string().min(1),
  })
  .strict();

export const compareRunSchema = z
  .object({
    id: z.string().min(1),
    prompt: z.string().min(1),
    left: compareSideSchema,
    right: compareSideSchema,
  })
  .strict();

export const compareStartInputSchema = z
  .object({
    projectId: z.string().min(1),
    prompt: z.string().trim().min(1).max(20_000),
    agent: agentIdSchema,
    targetAgent: agentIdSchema,
    execution: executionModeSchema,
    route: routeModeSchema,
    autonomy: autonomyModeSchema,
  })
  .strict();

export const comparePickInputSchema = z
  .object({
    id: z.string().min(1),
    side: z.enum(['left', 'right']),
  })
  .strict();

export const compareOpenInputSchema = comparePickInputSchema;

export const configBackupSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    path: z.string().min(1),
    createdAt: timestampSchema,
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();

export const configBackupCreateInputSchema = z
  .object({
    name: z.string().trim().max(120).optional(),
  })
  .strict();

export const configBackupRestoreInputSchema = z
  .object({
    id: z.string().min(1),
  })
  .strict();

export type GoalInput = z.input<typeof goalInputSchema>;
export type NormalizedGoalInput = z.output<typeof goalInputSchema>;
export type WorkbenchGoal = z.infer<typeof workbenchGoalSchema>;
export type WorkbenchGoalStatus = z.infer<typeof workbenchGoalStatusSchema>;
export type SkillSummary = z.infer<typeof skillSummarySchema>;
export type Workflow = z.infer<typeof workflowSchema>;
export type WorkflowStep = z.infer<typeof workflowStepSchema>;
export type WorkflowStepStatus = z.infer<typeof workflowStepStatusSchema>;
export type WorkflowTemplate = z.infer<typeof workflowTemplateSchema>;
export type WorkflowTemplateSaveInput = z.input<typeof workflowTemplateSaveInputSchema>;
export type PermissionKeyInfo = z.infer<typeof permissionKeyInfoSchema>;
export type CheckpointRecord = z.infer<typeof checkpointRecordSchema>;
export type TurnFileChange = z.infer<typeof turnFileChangeSchema>;
export type CheckpointFileReview = z.infer<typeof checkpointFileReviewSchema>;
export type CheckpointReview = z.infer<typeof checkpointReviewSchema>;
export type CheckpointRestoreResult = z.infer<typeof checkpointRestoreResultSchema>;
export type CompareSide = z.infer<typeof compareSideSchema>;
export type CompareRun = z.infer<typeof compareRunSchema>;
export type CompareStartInput = z.infer<typeof compareStartInputSchema>;
export type ComparePickInput = z.infer<typeof comparePickInputSchema>;
export type ConfigBackup = z.infer<typeof configBackupSchema>;
