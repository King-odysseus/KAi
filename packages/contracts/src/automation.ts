import { z } from 'zod';
import { agentIdSchema, routeModeSchema } from './primitives';

/**
 * Per-project automation. It lives with the user's project preferences (never in the repository), so a cloned
 * project cannot make KAI run commands the user did not set up.
 */
export const projectHookSchema = z
  .object({
    command: z.string().trim().min(1).max(2_000),
    timeoutSeconds: z.number().int().min(1).max(600).optional(),
  })
  .strict();
export type ProjectHook = z.infer<typeof projectHookSchema>;

export const PROJECT_HOOK_EVENTS = ['beforeRun', 'afterEdit', 'afterRun'] as const;
export type ProjectHookEvent = (typeof PROJECT_HOOK_EVENTS)[number];

export const MAX_AUTO_FIX_ROUNDS = 5;

export const projectAutomationSchema = z
  .object({
    /** After a run that changed files, run the project's checks and send failures back to the agent. */
    autoCheck: z
      .object({
        enabled: z.boolean(),
        /** Blank means the command KAI detects from the project (npm test, cargo test, and so on). */
        command: z.string().trim().max(2_000).optional(),
        maxRounds: z.number().int().min(1).max(MAX_AUTO_FIX_ROUNDS),
      })
      .strict()
      .optional(),
    hooks: z
      .object({
        /** A non-zero exit stops the run; anything printed is given to the agent as context. */
        beforeRun: z.array(projectHookSchema).max(5).optional(),
        /** After a run changed files, for example a formatter. Failures are reported, not fatal. */
        afterEdit: z.array(projectHookSchema).max(5).optional(),
        /** After everything else, for example a notification. Failures are reported, not fatal. */
        afterRun: z.array(projectHookSchema).max(5).optional(),
      })
      .strict()
      .optional(),
    /** A second model reads the change against the request before the run is called done. */
    review: z.object({ enabled: z.boolean() }).strict().optional(),
  })
  .strict();
export type ProjectAutomation = z.infer<typeof projectAutomationSchema>;

export function hasProjectAutomation(automation: ProjectAutomation | undefined): automation is ProjectAutomation {
  if (!automation) return false;
  const hooks = automation.hooks;
  return Boolean(
    automation.autoCheck?.enabled
      || automation.review?.enabled
      || hooks?.beforeRun?.length
      || hooks?.afterEdit?.length
      || hooks?.afterRun?.length,
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Scheduled goals

const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time such as 07:30.');

export const scheduleFrequencySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('interval'), everyMinutes: z.number().int().min(15).max(10_080) }).strict(),
  z.object({ kind: z.literal('daily'), at: timeOfDaySchema }).strict(),
]);
export type ScheduleFrequency = z.infer<typeof scheduleFrequencySchema>;

/** A scheduled run cannot answer questions, so it either only reads (plan) or is trusted to act (full). */
export const scheduleAutonomySchema = z.enum(['plan', 'full']);

export const scheduleInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    projectId: z.string().min(1),
    name: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(1).max(20_000),
    agent: agentIdSchema,
    execution: z.enum(['cli', 'api']),
    route: routeModeSchema,
    autonomy: scheduleAutonomySchema,
    frequency: scheduleFrequencySchema,
    enabled: z.boolean(),
  })
  .strict();
export type ScheduleInput = z.infer<typeof scheduleInputSchema>;

export const scheduleSchema = scheduleInputSchema
  .extend({
    id: z.string().min(1),
    createdAt: z.string().min(1),
    lastRunAt: z.string().optional(),
    lastStatus: z.enum(['completed', 'failed']).optional(),
    lastSummary: z.string().max(500).optional(),
    lastConversationId: z.string().optional(),
  })
  .strict();
export type Schedule = z.infer<typeof scheduleSchema>;

export const scheduleIdInputSchema = z.object({ id: z.string().min(1) }).strict();
export const scheduleListInputSchema = z.object({ projectId: z.string().min(1) }).strict();

// ---------------------------------------------------------------------------------------------------------------
// Evals: a saved task, replayed against any agent from the same starting point

export const evalCaseInputSchema = z
  .object({
    projectId: z.string().min(1),
    name: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(1).max(20_000),
    /** The command whose exit code decides pass or fail. */
    check: z.string().trim().min(1).max(2_000),
    /** The commit the task starts from. Blank means the project's current commit. */
    baseRef: z.string().trim().max(200).optional(),
  })
  .strict();
export type EvalCaseInput = z.infer<typeof evalCaseInputSchema>;

export const evalCaseSchema = evalCaseInputSchema
  .extend({ id: z.string().min(1), baseRef: z.string().min(1), createdAt: z.string().min(1) })
  .strict();
export type EvalCase = z.infer<typeof evalCaseSchema>;

export const evalRunInputSchema = z
  .object({
    caseId: z.string().min(1),
    projectId: z.string().min(1),
    agent: agentIdSchema,
    execution: z.enum(['cli', 'api']),
    route: routeModeSchema,
    model: z.string().trim().max(100).optional(),
  })
  .strict();
export type EvalRunInput = z.infer<typeof evalRunInputSchema>;

export const evalResultSchema = z
  .object({
    id: z.string().min(1),
    caseId: z.string().min(1),
    projectId: z.string().min(1),
    agent: agentIdSchema,
    execution: z.enum(['cli', 'api']),
    route: routeModeSchema,
    model: z.string().optional(),
    startedAt: z.string().min(1),
    durationMs: z.number().nonnegative(),
    /** Whether the agent finished without failing. */
    agentCompleted: z.boolean(),
    passed: z.boolean(),
    checkExitCode: z.number().int().nullable(),
    filesChanged: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative().optional(),
    error: z.string().max(2_000).optional(),
    outputTail: z.string().max(4_000),
  })
  .strict();
export type EvalResult = z.infer<typeof evalResultSchema>;

export const evalOverviewSchema = z
  .object({ cases: z.array(evalCaseSchema), results: z.array(evalResultSchema) })
  .strict();
export type EvalOverview = z.infer<typeof evalOverviewSchema>;

export const evalCaseDeleteInputSchema = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).strict();
export const evalListInputSchema = z.object({ projectId: z.string().min(1) }).strict();

// ---------------------------------------------------------------------------------------------------------------
// Scorecards: how each agent does on the runs the user actually gives it

export const runScoreSchema = z
  .object({
    at: z.string().min(1),
    projectId: z.string().min(1),
    agent: agentIdSchema,
    execution: z.enum(['cli', 'api']),
    model: z.string().optional(),
    level: z.enum(['light', 'standard', 'heavy']),
    completed: z.boolean(),
    /** Null when no check ran. */
    checkPassed: z.boolean().nullable(),
    /** How many automatic fix rounds the run needed. */
    fixRounds: z.number().int().nonnegative(),
    filesChanged: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
    costUsd: z.number().nonnegative().optional(),
  })
  .strict();
export type RunScore = z.infer<typeof runScoreSchema>;

export const agentScorecardSchema = z
  .object({
    agent: agentIdSchema,
    execution: z.enum(['cli', 'api']),
    level: z.enum(['light', 'standard', 'heavy']),
    runs: z.number().int().nonnegative(),
    /** Completed with no failing check and no fix rounds. */
    cleanRuns: z.number().int().nonnegative(),
    cleanRate: z.number().min(0).max(1),
    medianDurationMs: z.number().nonnegative(),
    totalCostUsd: z.number().nonnegative(),
    /** True when this agent has done poorly enough at this level that KAI now sends the work one level up. */
    escalated: z.boolean(),
  })
  .strict();
export type AgentScorecard = z.infer<typeof agentScorecardSchema>;
