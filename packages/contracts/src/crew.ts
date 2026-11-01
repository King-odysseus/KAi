import { z } from 'zod';
import { agentIdSchema, autonomyModeSchema, executionModeSchema, routeModeSchema, timestampSchema } from './primitives';

/**
 * Crew: a self-managing team that builds a whole project from a board of tasks. A Lead plans the tasks and checks
 * each result against its acceptance criteria, workers build them, and a send-back goes to the worker that wrote the
 * code until the Lead accepts it. The plan, not anyone's prose, decides when the project is done.
 */

export const CREW_ROLE_KINDS = ['lead', 'planner', 'builder', 'reviewer', 'security', 'designer', 'custom'] as const;
export const crewRoleKindSchema = z.enum(CREW_ROLE_KINDS);
export type CrewRoleKind = z.infer<typeof crewRoleKindSchema>;

/** What a kind of role is for, and whether it may change files. Reviewers, planners and the Lead only read. */
export const CREW_ROLE_INFO: Record<Exclude<CrewRoleKind, 'custom'>, { label: string; does: string; access: 'read' | 'edit' }> = {
  lead: { label: 'Lead', does: 'Writes the plan as tasks, checks each result against it, sends problems back, and decides when the project is done.', access: 'read' },
  planner: { label: 'Planner', does: 'Reads the project and breaks the goal into small tasks with acceptance criteria.', access: 'read' },
  builder: { label: 'Builder', does: 'Claims a task, writes the code, runs the checks and submits it for review.', access: 'edit' },
  reviewer: { label: 'Reviewer', does: 'Reads finished work for correctness and gives a ship or no-ship verdict.', access: 'read' },
  security: { label: 'Security', does: 'Reviews finished tasks for secrets, permissions and unsafe input. A block stops the run and asks you.', access: 'read' },
  designer: { label: 'Designer', does: 'Draws pages in Open Pencil and keeps built pages matching the design.', access: 'edit' },
};

const modelNameSchema = z
  .string()
  .max(100)
  .regex(/^[A-Za-z0-9][\w.:/@[\]-]*$/, 'Use a model name such as gpt-5.6-sol or claude-sonnet-5.');

export const MAX_CREW_ROLES = 12;
export const MAX_SUB_AGENTS_PER_ROLE = 8;
export const MAX_SUB_AGENTS_TOTAL = 24;

/** Helpers a role may start for one task. They default to the role's own agent. */
export const crewSubAgentsSchema = z
  .object({
    max: z.number().int().min(0).max(MAX_SUB_AGENTS_PER_ROLE).default(0),
    // Left out, a helper uses the same agent, route and model as the role that started it.
    agent: agentIdSchema.optional(),
  })
  .strict();

export const crewRoleSchema = z
  .object({
    id: z.string().min(1).max(40).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'A role id looks like builder or custom-database.'),
    kind: crewRoleKindSchema,
    label: z.string().trim().min(1).max(60),
    agent: agentIdSchema,
    // CLI uses the subscription; API is KAI's own direct mode. The route is the proxy choice that goes with either.
    execution: executionModeSchema.default('cli'),
    route: routeModeSchema.default('direct'),
    model: modelNameSchema.optional(),
    access: z.enum(['read', 'edit']),
    subAgents: crewSubAgentsSchema.default({ max: 0 }),
    instructions: z.string().max(2_000).default(''),
  })
  .strict();
export type CrewRole = z.infer<typeof crewRoleSchema>;

/** A limit asks (Continue or Finish); it never cuts work off halfway. Zero means no limit. */
export const crewLimitsSchema = z
  .object({
    maxUsd: z.number().min(0).max(10_000).default(0),
    maxMinutes: z.number().int().min(0).max(24 * 60).default(0),
    // How many times one task may be sent back before the run stops and asks the user.
    maxSendBacks: z.number().int().min(1).max(10).default(3),
    maxSubAgents: z.number().int().min(0).max(MAX_SUB_AGENTS_TOTAL).default(6),
    maxParallelTasks: z.number().int().min(1).max(8).default(2),
    onLimit: z.enum(['ask', 'finish']).default('ask'),
  })
  .strict();
export type CrewLimits = z.infer<typeof crewLimitsSchema>;

/** Ways the crew avoids spending that does not move the project forward. All on unless the user turns one off. */
export const crewSavingsSchema = z
  .object({
    // Each agent gets the task, its criteria and a board summary instead of the whole chat history.
    workFromBoard: z.boolean().default(true),
    // Strong models plan and review; routine builds may use a lighter one.
    lightModelForRoutine: z.boolean().default(true),
    // An accepted task is not reviewed again unless its files changed.
    skipUnchangedReview: z.boolean().default(true),
    // The run asks the user once the same task has failed for the same reason twice.
    stopOnRepeatedFailure: z.boolean().default(true),
  })
  .strict();
export type CrewSavings = z.infer<typeof crewSavingsSchema>;

export const crewConfigSchema = z
  .object({
    // The same levels the composer offers, applied to every role that can edit. Reviewers stay read-only regardless.
    autonomy: autonomyModeSchema.default('autoEdit'),
    // Plan first and wait for the user's approval, or start as soon as the Lead has written the tasks.
    approvePlan: z.boolean().default(true),
    roles: z.array(crewRoleSchema).min(1).max(MAX_CREW_ROLES),
    limits: crewLimitsSchema.default({}),
    savings: crewSavingsSchema.default({}),
    // A command that must pass (for example "npm test") before the Lead may call the project done.
    checkCommand: z.string().trim().max(1_000).default(''),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (!config.roles.some((role) => role.kind === 'lead')) {
      ctx.addIssue({ code: 'custom', message: 'A crew needs a Lead.', path: ['roles'] });
    }
    const ids = new Set<string>();
    config.roles.forEach((role, index) => {
      if (ids.has(role.id)) ctx.addIssue({ code: 'custom', message: `Two roles share the id ${role.id}.`, path: ['roles', index, 'id'] });
      ids.add(role.id);
    });
  });
export type CrewConfig = z.infer<typeof crewConfigSchema>;

export const CREW_TASK_STATUSES = ['backlog', 'building', 'review', 'sentBack', 'accepted', 'blocked', 'needsYou', 'skipped'] as const;
export const crewTaskStatusSchema = z.enum(CREW_TASK_STATUSES);
export type CrewTaskStatus = z.infer<typeof crewTaskStatusSchema>;

export const crewReviewSchema = z
  .object({
    round: z.number().int().min(1),
    verdict: z.enum(['accept', 'sendBack', 'needsYou']),
    // What the Lead found, in plain words, tied to a criterion where one applies.
    feedback: z.string().max(4_000).default(''),
    reviewer: z.string().min(1).max(40),
    at: timestampSchema,
  })
  .strict();
export type CrewReview = z.infer<typeof crewReviewSchema>;

export const crewTaskSchema = z
  .object({
    id: z.string().min(1).max(60),
    title: z.string().trim().min(1).max(200),
    description: z.string().max(6_000).default(''),
    // A task with no criteria cannot be accepted: there would be nothing to check it against.
    acceptance: z.array(z.string().trim().min(1).max(400)).max(20).default([]),
    role: z.string().min(1).max(40),
    dependsOn: z.array(z.string().min(1).max(60)).max(30).default([]),
    status: crewTaskStatusSchema.default('backlog'),
    // How many times the task has been built; the first build is round 1.
    round: z.number().int().min(0).default(0),
    reviews: z.array(crewReviewSchema).max(40).default([]),
    // The open-pencil page this task builds, when the design produced it.
    designRef: z.string().max(300).nullable().default(null),
    createdBy: z.enum(['lead', 'worker', 'user']).default('lead'),
    // A task a worker suggested waits here until the Lead or the user accepts it onto the board.
    proposed: z.boolean().default(false),
    assignedTo: z.string().max(40).nullable().default(null),
    // The files the builder reported changing, for the final report and for skipping an unchanged review.
    files: z.array(z.string().max(300)).max(200).default([]),
    costUsd: z.number().min(0).default(0),
    note: z.string().max(1_000).default(''),
    updatedAt: timestampSchema,
  })
  .strict();
export type CrewTask = z.infer<typeof crewTaskSchema>;

export const CREW_RUN_STATUSES = ['planning', 'awaitingApproval', 'running', 'paused', 'needsYou', 'completed', 'stopped'] as const;
export const crewRunStatusSchema = z.enum(CREW_RUN_STATUSES);
export type CrewRunStatus = z.infer<typeof crewRunStatusSchema>;

export const crewFeedEntrySchema = z
  .object({
    id: z.string().min(1),
    at: timestampSchema,
    // Which role did it, or "you"/"crew" for the user and the engine itself.
    who: z.string().min(1).max(60),
    kind: z.enum(['info', 'accepted', 'sentBack', 'needsYou', 'proposal', 'limit', 'done']),
    text: z.string().max(500),
    taskId: z.string().max(60).optional(),
  })
  .strict();
export type CrewFeedEntry = z.infer<typeof crewFeedEntrySchema>;

/** Why a run stopped to ask. The user answers Continue or Finish; nothing is killed. */
export const crewAskSchema = z
  .object({
    reason: z.enum(['spend', 'time', 'sendBacks', 'sameFailure', 'securityBlock', 'designApproval', 'noProgress']),
    message: z.string().max(500),
    taskId: z.string().max(60).optional(),
  })
  .strict();
export type CrewAsk = z.infer<typeof crewAskSchema>;

/** What Open Pencil holds right now, as the crew sees it. Pages are what the Designer draws and builders match. */
export const crewDesignSchema = z
  .object({
    state: z.enum(['running', 'not-running', 'not-configured', 'token-mismatch', 'unreachable']),
    pages: z.array(z.object({ id: z.string().min(1).max(300), name: z.string().min(1).max(200) }).strict()).max(300),
  })
  .strict();
export type CrewDesign = z.infer<typeof crewDesignSchema>;

export const crewDesignInputSchema = z
  .object({
    // Open the editor first when it is not running, instead of only looking.
    launch: z.boolean().default(false),
  })
  .strict();

export const crewRunSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    projectId: z.string().min(1),
    goal: z.string().trim().min(1).max(4_000),
    status: crewRunStatusSchema,
    config: crewConfigSchema,
    tasks: z.array(crewTaskSchema).max(300),
    feed: z.array(crewFeedEntrySchema).max(400),
    ask: crewAskSchema.nullable().default(null),
    // The design as it was when the Lead planned, so the plan and the pages it names stay comparable.
    design: crewDesignSchema.nullable().default(null),
    spentUsd: z.number().min(0).default(0),
    startedAt: timestampSchema,
    updatedAt: timestampSchema,
    completedAt: timestampSchema.nullable().default(null),
  })
  .strict();
export type CrewRun = z.infer<typeof crewRunSchema>;

/** The role set a new crew starts with: the Lead and the reviewers on the strongest agent, builders on the default. */
export function createDefaultCrewRoles(defaultAgent: z.infer<typeof agentIdSchema> = 'claude', builderAgent: z.infer<typeof agentIdSchema> = defaultAgent): CrewRole[] {
  const make = (id: string, kind: Exclude<CrewRoleKind, 'custom'>, agent: z.infer<typeof agentIdSchema>, subAgents = 0): CrewRole => ({
    id,
    kind,
    label: CREW_ROLE_INFO[kind].label,
    agent,
    execution: 'cli',
    route: 'direct',
    access: CREW_ROLE_INFO[kind].access,
    subAgents: { max: subAgents },
    instructions: '',
  });
  return [
    make('lead', 'lead', defaultAgent, 1),
    make('planner', 'planner', defaultAgent, 2),
    make('builder', 'builder', builderAgent, 1),
    make('security', 'security', defaultAgent),
  ];
}

export function createDefaultCrewConfig(defaultAgent: z.infer<typeof agentIdSchema> = 'claude', builderAgent: z.infer<typeof agentIdSchema> = defaultAgent): CrewConfig {
  return crewConfigSchema.parse({ roles: createDefaultCrewRoles(defaultAgent, builderAgent) });
}

export const crewStartInputSchema = z
  .object({
    projectId: z.string().min(1),
    goal: z.string().trim().min(1).max(4_000),
    // Left out, the crew starts with the default roles and limits.
    config: crewConfigSchema.optional(),
  })
  .strict();
export type CrewStartInput = z.infer<typeof crewStartInputSchema>;

export const crewControlInputSchema = z.object({ runId: z.string().min(1) }).strict();

export const crewAnswerInputSchema = z
  .object({
    runId: z.string().min(1),
    answer: z.enum(['continue', 'skip', 'finish']),
    // What the user tells the crew when continuing; it becomes the next feedback to the builder.
    guidance: z.string().max(2_000).default(''),
  })
  .strict();
export type CrewAnswerInput = z.infer<typeof crewAnswerInputSchema>;

/** Kinds of role that may never change files, whatever the autonomy level says. */
const READ_ONLY_KINDS: ReadonlySet<CrewRoleKind> = new Set(['lead', 'planner', 'reviewer', 'security']);

export function roleAccess(role: Pick<CrewRole, 'kind' | 'access'>): 'read' | 'edit' {
  return READ_ONLY_KINDS.has(role.kind) ? 'read' : role.access;
}

export interface CrewReport {
  headline: string;
  built: string[];
  verified: string[];
  verdicts: Array<{ role: string; verdict: 'ship' | 'noShip'; note: string }>;
  openRisks: string[];
  totals: { tasks: number; accepted: number; skipped: number; sentBackOnce: number; sentBackMore: number; files: number; costUsd: number; minutes: number };
}

/** The end-of-run report, written from the board's own records so nothing in it can be made up. */
export function buildReport(run: CrewRun, now: Date = new Date()): CrewReport {
  const board = run.tasks.filter((task) => !task.proposed);
  const accepted = board.filter((task) => task.status === 'accepted');
  const skipped = board.filter((task) => task.status === 'skipped');
  const open = board.filter((task) => task.status !== 'accepted' && task.status !== 'skipped');
  const sendBacks = (task: CrewTask): number => task.reviews.filter((item) => item.verdict === 'sendBack').length;
  const files = new Set(board.flatMap((task) => task.files));
  const end = run.completedAt ? new Date(run.completedAt) : now;
  const securityRoles = new Set(run.config.roles.filter((role) => role.kind === 'security' || role.kind === 'reviewer').map((role) => role.id));
  const verdicts = board.flatMap((task) => task.reviews.filter((review) => securityRoles.has(review.reviewer)).slice(-1).map((review) => ({
    role: review.reviewer,
    verdict: review.verdict === 'accept' ? ('ship' as const) : ('noShip' as const),
    note: review.feedback || `On "${task.title}".`,
  })));
  const done = open.length === 0 && board.length > 0;
  return {
    headline: done ? `All ${board.length} tasks accepted.` : `${accepted.length} of ${board.length} tasks accepted; ${open.length} not finished.`,
    built: accepted.map((task) => task.title),
    verified: [
      ...accepted.map((task) => `${task.title}: ${task.acceptance.length} ${task.acceptance.length === 1 ? 'criterion' : 'criteria'} checked by the Lead.`),
      ...(run.config.checkCommand ? [`Project check "${run.config.checkCommand}" is required before the run is done.`] : []),
    ],
    verdicts,
    openRisks: [
      ...open.map((task) => `"${task.title}" is ${task.status === 'needsYou' ? 'waiting on you' : 'not finished'}.`),
      ...skipped.map((task) => `"${task.title}" was skipped.`),
    ],
    totals: {
      tasks: board.length,
      accepted: accepted.length,
      skipped: skipped.length,
      sentBackOnce: board.filter((task) => sendBacks(task) === 1).length,
      sentBackMore: board.filter((task) => sendBacks(task) > 1).length,
      files: files.size,
      costUsd: Math.round(run.spentUsd * 100) / 100,
      minutes: Math.max(0, Math.round((end.getTime() - new Date(run.startedAt).getTime()) / 60_000)),
    },
  };
}

/** A saved starting point for new crews: one for every project, and optionally one for a single project. */
export const crewDefaultsInputSchema = z
  .object({
    // Left out, the defaults apply to every project that has none of its own.
    projectId: z.string().min(1).optional(),
    // Null removes the saved defaults, so new crews start from the built-in roles again.
    config: crewConfigSchema.nullable(),
  })
  .strict();
export type CrewDefaultsInput = z.infer<typeof crewDefaultsInputSchema>;
