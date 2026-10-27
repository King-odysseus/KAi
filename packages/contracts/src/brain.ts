import { z } from 'zod';

export const brainEntryTypeSchema = z.enum(['bugs', 'decisions', 'gotchas', 'patterns']);
export const brainSearchModeSchema = z.enum(['lexical', 'semantic']);
export const brainPresenceSchema = z.enum(['active', 'idle', 'offline']);
export const brainHungerLevelSchema = z.enum(['satisfied', 'peckish', 'hungry', 'starving']);

export const cognitive1Operations = [
  'status',
  'metrics',
  'self-review',
  'brain-learn',
  'brain-auto-learn',
  'brain-prune',
  'brain-ping',
  'brain-export',
  'brain-drafts',
  'brain-draft-status',
  'brain-draft-approve',
  'brain-draft-approve-all',
  'brain-draft-reject',
  'brain-draft-type',
  'brain-recall-feedback',
  'active-claim',
  'active-release',
  'active-release-all',
  'handoffs',
  'handoff-claim',
  'handoff-suggest',
  'urgent-list',
  'urgent-set',
  'urgent-clear',
  'todo-projects',
  'todo-project-create',
  'task-create',
  'tasks',
  'task-claim',
  'task-complete',
  'reviews',
  'regressions',
  'costs',
  'cost-log',
  'cost-clear',
  'recap-check',
  'recap-check-log',
  'graph',
  'skills',
  'skill-content',
  'skill-save',
  'overwatch-status',
  'overwatch-config',
  'overwatch-insights',
  'overwatch-run',
  'overwatch-audit',
  'overwatch-resolve-preview',
  'overwatch-resolve',
  'overwatch-triage-recovery',
  'overwatch-release-stale',
  'overwatch-release-one',
  'overwatch-semantic-dupes',
  'overwatch-auto-fix',
  'overwatch-cross-ref-bugs',
  'overwatch-heuristic-clean',
  'overwatch-distill-kernels',
  'overwatch-push-to-memory',
  'overwatch-link',
  'integration-status',
  'deploy-c1',
  'project-update',
  'git-status',
  'checkpoint',
  'recover',
  'suggest',
  'theme',
  'theme-save',
] as const;

export const cognitive1OperationSchema = z.enum(cognitive1Operations);

export const cognitive1OperationInputSchema = z
  .object({
    operation: cognitive1OperationSchema,
    payload: z.record(z.string(), z.unknown()).optional().default({}),
  })
  .strict();

export const cognitive1OperationResultSchema = z.unknown();

export const cognitive1McpTools = [
  'active_claim',
  'active_list',
  'active_release',
  'brain_export',
  'brain_handoff',
  'brain_learn',
  'brain_ping',
  'brain_prune',
  'brain_recall',
  'brain_recall_feedback',
  'brain_review_suggestions',
  'brain_stats',
  'brain_status',
  'checkpoint',
  'compaction_check',
  'compliance_audit',
  'config_get',
  'config_set',
  'conflict_check',
  'context_pack',
  'cost_log',
  'cost_report',
  'crossref_bugs',
  'decision_log',
  'doctor',
  'git_status',
  'handoff_claim',
  'notify',
  'project_init',
  'recall',
  'recap_check',
  'recover',
  'regression_log',
  'regression_report',
  'review_list',
  'review_request',
  'session_end',
  'session_start',
  'style_guide_extract',
  'suggest',
  'task_claim',
  'task_complete',
  'task_create',
  'task_list',
  'task_route',
  'todo_project_create',
  'todo_project_list',
  'urgent_clear',
  'urgent_list',
  'urgent_set',
  'wiki_status',
] as const;

export const cognitive1McpToolSchema = z.enum(cognitive1McpTools);

export const cognitive1McpToolInputSchema = z
  .object({
    tool: cognitive1McpToolSchema,
    arguments: z.record(z.string(), z.unknown()).optional().default({}),
  })
  .strict();

export const cognitive1McpToolResultSchema = z.unknown();

export const brainEntrySchema = z
  .object({
    date: z.string().min(1),
    title: z.string().min(1),
    agent: z.string(),
    type: brainEntryTypeSchema,
    tags: z.string(),
    project: z.string(),
    fields: z.record(z.string()),
    status: z.string().nullable(),
  })
  .strict();

export const brainOverviewSchema = z
  .object({
    totalEntries: z.number().int().nonnegative(),
    typeCounts: z.record(brainEntryTypeSchema, z.number().int().nonnegative()),
    activeAgents: z.number().int().nonnegative(),
    projectCount: z.number().int().nonnegative(),
    hunger: z
      .object({
        daysSinceLearn: z.number().int().nonnegative(),
        level: brainHungerLevelSchema,
        lastEntryDate: z.string().nullable(),
      })
      .strict(),
    recentEntries: z.array(brainEntrySchema),
    quality: z
      .object({
        totalEntries: z.number().int().nonnegative(),
        noiseScore: z.number().int().min(0).max(100),
        signalRatio: z.number().int().min(0).max(100),
        duplicateCount: z.number().int().nonnegative(),
        untaggedTotal: z.number().int().nonnegative(),
        deadWeightCount: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const brainSearchInputSchema = z
  .object({
    query: z.string().trim().max(500).optional().default(''),
    tag: z.string().trim().max(100).optional().default(''),
    type: brainEntryTypeSchema.optional(),
    project: z.string().trim().max(200).optional().default(''),
    global: z.boolean().optional().default(false),
    mode: brainSearchModeSchema.optional().default('lexical'),
    maxResults: z.number().int().min(1).max(100).optional().default(25),
  })
  .strict();

export const brainFieldUpdateInputSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    field: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z][A-Za-z0-9 _-]*$/),
    value: z.string().max(20_000),
  })
  .strict();

export const brainFieldUpdateResultSchema = z
  .object({
    title: z.string().min(1),
    field: z.string().min(1),
    value: z.string(),
  })
  .strict();

export const brainImportResultSchema = z
  .object({
    sourcePath: z.string().min(1),
    targetPath: z.string().min(1),
    imported: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  })
  .strict();

export const brainGitStatusSchema = z
  .object({
    repository: z.boolean(),
    branch: z.string().nullable(),
    remote: z.string().nullable(),
    clean: z.boolean(),
    changedFiles: z.number().int().nonnegative(),
    ahead: z.number().int().nonnegative(),
    behind: z.number().int().nonnegative(),
    path: z.string().min(1),
    error: z.string().nullable(),
  })
  .strict();

export const brainGitSyncActionSchema = z.enum(['init', 'commit', 'pull', 'push']);

export const brainGitSyncResultSchema = z
  .object({
    action: brainGitSyncActionSchema,
    success: z.boolean(),
    message: z.string(),
    status: brainGitStatusSchema,
  })
  .strict();

export type BrainEntry = z.infer<typeof brainEntrySchema>;
export type BrainEntryType = z.infer<typeof brainEntryTypeSchema>;
export type BrainHungerLevel = z.infer<typeof brainHungerLevelSchema>;
export type BrainOverview = z.infer<typeof brainOverviewSchema>;
export type BrainSearchInput = z.input<typeof brainSearchInputSchema>;
export type BrainSearchQuery = z.output<typeof brainSearchInputSchema>;
export type BrainFieldUpdateInput = z.input<typeof brainFieldUpdateInputSchema>;
export type BrainFieldUpdate = z.output<typeof brainFieldUpdateInputSchema>;
export type BrainFieldUpdateResult = z.infer<typeof brainFieldUpdateResultSchema>;
export type BrainImportResult = z.infer<typeof brainImportResultSchema>;
export type BrainGitStatus = z.infer<typeof brainGitStatusSchema>;
export type BrainGitSyncAction = z.infer<typeof brainGitSyncActionSchema>;
export type BrainGitSyncResult = z.infer<typeof brainGitSyncResultSchema>;
export type Cognitive1Operation = z.infer<typeof cognitive1OperationSchema>;
export type Cognitive1OperationInput = z.input<typeof cognitive1OperationInputSchema>;
export type NormalizedCognitive1OperationInput = z.output<typeof cognitive1OperationInputSchema>;
export type Cognitive1OperationResult = z.infer<typeof cognitive1OperationResultSchema>;
export type Cognitive1McpTool = z.infer<typeof cognitive1McpToolSchema>;
export type Cognitive1McpToolInput = z.input<typeof cognitive1McpToolInputSchema>;
export type NormalizedCognitive1McpToolInput = z.output<typeof cognitive1McpToolInputSchema>;
export type Cognitive1McpToolResult = z.infer<typeof cognitive1McpToolResultSchema>;
