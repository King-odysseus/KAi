import { z } from 'zod';
import { agentIdSchema } from './primitives';

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

/** Asks one agent to review a project's memory in C1: check it against the code, correct what is wrong, add what is missing. */
export const brainMemoryReviewInputSchema = z
  .object({
    projectId: z.string().min(1).max(200),
    agent: agentIdSchema,
    /** `api` runs the review on the connection set up in Settings (a local model, DeepSeek and the like) instead of a signed-in CLI. */
    execution: z.enum(['cli', 'api']).default('cli'),
  })
  .strict();
export type BrainMemoryReviewInput = z.infer<typeof brainMemoryReviewInputSchema>;

export const brainMemoryReviewResultSchema = z
  .object({
    conversationId: z.string().min(1),
    status: z.enum(['completed', 'failed']),
    output: z.string(),
    error: z.string().optional(),
  })
  .strict();
export type BrainMemoryReviewResult = z.infer<typeof brainMemoryReviewResultSchema>;

/**
 * The instruction for a memory review. The agent is a bigger model teaching the smaller ones that will work on this
 * project later, so the entries it files are written for them: specific, with paths, one fact each. `current` is what
 * the brain holds now, as short lines, so the agent can check each against the code without asking for it first.
 */
export function brainMemoryReviewPrompt(input: { projectName: string; current: readonly string[] }): string {
  return [
    `Review the project memory for "${input.projectName}" and make it better.`,
    'The project memory (C1, the brain) is what every agent that works on this project reads first, including small local models that cannot work things out for themselves. Wrong or vague entries mislead them; missing ones leave them guessing. Your job is to make it accurate and complete.',
    input.current.length
      ? `What the brain holds for this project now:\n${input.current.map((line) => `- ${line}`).join('\n')}`
      : 'The brain holds nothing for this project yet, so most of the work is adding what is missing.',
    [
      'Do this, in order:',
      '1. Read the entries above, and look up more by topic with your memory tools (brain_recall or recall).',
      '2. Check each against the real project: open the files it names, read the package scripts, run read-only commands. Do not trust an entry because it is there.',
      '3. For an entry that is wrong or out of date, file a corrected entry (brain_learn or brain_remember) whose title begins "Correction:" and says which entry it replaces and what was wrong. Remove a stale entry only with a tool meant for that.',
      '4. Add what is missing, one fact per entry, specific and with file paths: how the project is laid out and what each main part does; the decisions made and why; how to build, test and run it; rules the code must follow; traps that cost time. Prefer decisions, patterns and gotchas a newcomer could not read from the code.',
      '5. Never record secrets, and do not restate what a file plainly says. The brain turns vague entries away: make them concrete and try again.',
      '6. Keep to the twenty most useful additions; quality over volume.',
    ].join('\n'),
    'Finish with a short report: what you checked, what you corrected, what you added, and what you could not verify.',
  ].join('\n\n');
}
