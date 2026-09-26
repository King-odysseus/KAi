import { z } from 'zod';
import {
  agentIdSchema,
  autonomyModeSchema,
  executionModeSchema,
  permissionKeySchema,
  routeModeSchema,
  timestampSchema,
} from './primitives';
import { teamWorkerRoleIdSchema } from './team';

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

export const workflowLoopSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    maxRounds: z.number().int().min(1).max(20).default(3),
    maxCostUsd: z.number().min(0).max(10_000).default(0),
    maxDurationMinutes: z.number().int().min(1).max(1_440).default(30),
    checkCommand: z.string().trim().max(2_000).default(''),
  })
  .strict();

export const workflowLoopProgressSchema = z
  .object({
    round: z.number().int().min(1),
    maxRounds: z.number().int().min(1),
    startedAt: timestampSchema,
    elapsedMs: z.number().int().nonnegative().default(0),
    costUsd: z.number().nonnegative().default(0),
    lastCheckPassed: z.boolean().nullable().default(null),
    lastCheckOutput: z.string().default(''),
    stopReason: z.enum(['passed', 'max_rounds', 'cost_limit', 'time_limit', 'failed', 'stopped']).optional(),
  })
  .strict();

// Per-step settings a team plan uses. A plain workflow leaves them out, so every step follows the workflow's own.
const workflowStepOverrides = {
  role: teamWorkerRoleIdSchema.optional(),
  execution: executionModeSchema.optional(),
  route: routeModeSchema.optional(),
  autonomy: autonomyModeSchema.optional(),
  model: z.string().trim().max(240).optional(),
  // A gated step can stop the workflow and ask the user before the next step starts.
  gate: z.literal('security').optional(),
};

export const workflowStepVerdictSchema = z
  .object({
    result: z.enum(['pass', 'block']),
    reason: z.string().max(1_000).default(''),
    // Set once the user chose "Continue anyway", so the workflow does not ask again.
    acknowledged: z.boolean().default(false),
  })
  .strict();

export const workflowStepSchema = z
  .object({
    id: z.string().min(1),
    agent: agentIdSchema,
    prompt: z.string().trim().min(1).max(20_000),
    label: z.string().max(200).optional(),
    dependsOn: z.array(z.string().min(1)).optional(),
    ...workflowStepOverrides,
    verdict: workflowStepVerdictSchema.optional(),
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
    execution: executionModeSchema.default('cli'),
    route: routeModeSchema,
    model: z.string().trim().max(240).optional(),
    autonomy: autonomyModeSchema,
    loop: workflowLoopSettingsSchema.default({ enabled: false, maxRounds: 3, maxCostUsd: 0, maxDurationMinutes: 30, checkCommand: '' }),
    loopProgress: workflowLoopProgressSchema.optional(),
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
    execution: executionModeSchema.default('cli'),
    model: z.string().trim().max(240).optional(),
    autonomy: autonomyModeSchema,
    loop: workflowLoopSettingsSchema.default({ enabled: false, maxRounds: 3, maxCostUsd: 0, maxDurationMinutes: 30, checkCommand: '' }),
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

export const workflowStartStepSchema = z
  .object({
    id: z.string().min(1).max(160),
    agent: agentIdSchema,
    prompt: z.string().trim().min(1).max(20_000),
    label: z.string().max(200).optional(),
    dependsOn: z.array(z.string().min(1).max(160)).max(12).optional(),
    ...workflowStepOverrides,
  })
  .strict();

export const workflowStartInputSchema = z
  .object({
    projectId: z.string().min(1),
    title: z.string().trim().min(1).max(200),
    steps: z.array(workflowStartStepSchema).min(1).max(50),
    execution: executionModeSchema,
    route: routeModeSchema,
    model: z.string().trim().max(240).optional(),
    autonomy: autonomyModeSchema,
    loop: workflowLoopSettingsSchema.optional().default({ enabled: false, maxRounds: 3, maxCostUsd: 0, maxDurationMinutes: 30, checkCommand: '' }),
  })
  .strict();

export const workflowControlInputSchema = z
  .object({ workflowId: z.string().min(1) })
  .strict();

export const workflowRunSchema = z
  .object({
    conversationId: z.string().min(1),
    projectId: z.string().nullable(),
    workflow: workflowSchema,
  })
  .strict();

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
export type WorkflowLoopSettings = z.infer<typeof workflowLoopSettingsSchema>;
export type WorkflowLoopProgress = z.infer<typeof workflowLoopProgressSchema>;
export type WorkflowStep = z.infer<typeof workflowStepSchema>;
export type WorkflowStepVerdict = z.infer<typeof workflowStepVerdictSchema>;
export type WorkflowStepStatus = z.infer<typeof workflowStepStatusSchema>;
export type WorkflowTemplate = z.infer<typeof workflowTemplateSchema>;
export type WorkflowTemplateSaveInput = z.input<typeof workflowTemplateSaveInputSchema>;
export type WorkflowStartInput = z.infer<typeof workflowStartInputSchema>;
export type WorkflowControlInput = z.infer<typeof workflowControlInputSchema>;
export type WorkflowRun = z.infer<typeof workflowRunSchema>;
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
