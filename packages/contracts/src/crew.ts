import { z } from 'zod';
import { apiConnectionSchema } from './architect';
import { agentIdSchema, autonomyModeSchema, executionModeSchema, routeModeSchema, timestampSchema } from './primitives';

/**
 * Crew: a self-managing team that builds a whole project from a board of tasks. A Lead plans the tasks and checks
 * each result against its acceptance criteria, workers build them, and a send-back goes to the worker that wrote the
 * code until the Lead accepts it. The plan, not anyone's prose, decides when the project is done.
 */

export const CREW_ROLE_KINDS = ['lead', 'planner', 'builder', 'reviewer', 'security', 'tester', 'auditor', 'license', 'compliance', 'designer', 'operator', 'custom'] as const;
export const crewRoleKindSchema = z.enum(CREW_ROLE_KINDS);
export type CrewRoleKind = z.infer<typeof crewRoleKindSchema>;

/** What a kind of role is for, and whether it may change files. Reviewers, planners and the Lead only read. */
export const CREW_ROLE_INFO: Record<Exclude<CrewRoleKind, 'custom'>, { label: string; does: string; access: 'read' | 'edit' }> = {
  lead: { label: 'Lead', does: 'Writes the plan as tasks, checks each result against it, sends problems back, and decides when the project is done.', access: 'read' },
  planner: { label: 'Planner', does: 'Reads the project and breaks the goal into small tasks with acceptance criteria.', access: 'read' },
  builder: { label: 'Builder', does: 'Claims a task, writes the code, runs the checks and submits it for review.', access: 'edit' },
  reviewer: { label: 'Reviewer', does: 'Reads finished work for correctness and gives a ship or no-ship verdict.', access: 'read' },
  security: { label: 'Security', does: 'Reviews finished tasks for secrets, permissions and unsafe input. A block stops the run and asks you.', access: 'read' },
  tester: { label: 'Tester', does: 'Runs the project\'s real checks against finished work and reports what is broken, without fixing it.', access: 'read' },
  auditor: { label: 'Auditor', does: 'Reviews finished work for one named risk area — accessibility, performance, privacy, reliability — and reports evidence, not opinions.', access: 'read' },
  license: { label: 'Licence checker', does: 'Checks finished work for dependencies, assets, models and copied code used without a licence or without the attribution it requires.', access: 'read' },
  compliance: { label: 'Compliance', does: 'Checks finished work against the laws and data rules of the countries the app is distributed in, and reports the gaps.', access: 'read' },
  designer: { label: 'Designer', does: 'Draws pages in Open Pencil and keeps built pages matching the design.', access: 'edit' },
  operator: { label: 'Operator', does: 'Prepares releases, preflights deploys and handles incidents. Asks before anything outward or irreversible.', access: 'edit' },
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
    // The provider (DeepSeek, OpenAI, a local server...) when `execution` is `api`. Left out, Settings' direct API is used.
    api: apiConnectionSchema.optional(),
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
    // How to run and install what was built, so a finished crew can offer Run and Install buttons. Both are optional.
    runCommand: z.string().trim().max(300).default(''),
    installCommand: z.string().trim().max(300).default(''),
    // Whether builders commit their own work. Off, they leave changes uncommitted for the person to review and commit
    // when a phase ends, which is also how a commit hook that rejects a message can never stall a build.
    commitWork: z.boolean().default(false),
    // The spend, in dollars, at which a phase asks whether to carry on. Zero never asks. It only asks; it never stops anything.
    phaseBudgetUsd: z.number().min(0).max(100_000).default(0),
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
    // The part of the plan this task belongs to ("Phase 1: Shell"), when the plan is split into parts.
    phase: z.string().max(200).nullable().default(null),
    // The project as it was before this task first started, so the work can be undone. Absent for work done in a copy.
    checkpoint: z.object({ ref: z.string().min(1).max(300), untracked: z.array(z.string().min(1).max(500)).max(2_000).default([]), createdAt: z.string().min(1) }).strict().nullable().default(null),
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
    reason: z.enum(['spend', 'time', 'sendBacks', 'sameFailure', 'securityBlock', 'designApproval', 'noProgress', 'approval', 'phaseSpend', 'taskSpend']),
    message: z.string().max(1_400),
    taskId: z.string().max(60).optional(),
    // The phase a phase-spend question is about, so answering it can be remembered for that phase.
    phase: z.string().max(200).optional(),
    // Ways forward the Lead worked out for a stuck task. Picking one is the answer; each is a full instruction.
    options: z.array(z.string().min(1).max(400)).max(3).optional(),
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

/**
 * Something the plan or the project's rules say needs the person's OK before building, such as a new package. It is
 * shown as a Yes/No card with a plain explanation, and the answer is recorded by the button, never by a typed sentence.
 */
export const crewApprovalSchema = z
  .object({
    id: z.string().min(1).max(60),
    // What would be added or done, in a few words ("zod").
    what: z.string().min(1).max(120),
    // Why it is wanted and what it is, for someone who is not very technical.
    why: z.string().max(600).default(''),
    status: z.enum(['pending', 'approved', 'declined']).default('pending'),
  })
  .strict();
export type CrewApproval = z.infer<typeof crewApprovalSchema>;

/** Something a reviewer noticed that is not a reason to stop the task, kept for the person to read. */
export const crewNoteSchema = z
  .object({
    id: z.string().min(1).max(60),
    at: z.string().min(1),
    role: z.string().max(60),
    taskId: z.string().max(60),
    text: z.string().min(1).max(600),
  })
  .strict();
export type CrewNote = z.infer<typeof crewNoteSchema>;

/** One message in the crew's own conversation with the person: what they said, and what the Lead said back. */
export const crewChatEntrySchema = z
  .object({
    id: z.string().min(1),
    at: z.string().min(1),
    from: z.enum(['you', 'lead']),
    // ask: a question the Lead answers without changing anything. steer: a change of direction while it works.
    // work: more to build. note: something the crew says on its own.
    kind: z.enum(['ask', 'steer', 'work', 'answer', 'note']),
    text: z.string().max(6_000),
  })
  .strict();
export type CrewChatEntry = z.infer<typeof crewChatEntrySchema>;

/**
 * What the Lead may decide alone while the person is away. The defaults allow what can be undone and forbid what costs
 * money, adds to the project, touches security or loses work; "other" is the person's own rule in their words.
 */
export const crewAwayPolicySchema = z
  .object({
    retry: z.boolean().default(true),
    skip: z.boolean().default(true),
    reversible: z.boolean().default(true),
    recheck: z.boolean().default(true),
    costly: z.boolean().default(true),
    // 0 means no limit: a costly task carries on while the person is away, and each round is still listed.
    costlyMaxUsd: z.number().min(0).max(1_000).default(10),
    // Off turns the costly-task stop off altogether, away or not. Kept with these rules because they are saved live.
    costCheck: z.boolean().default(true),
    dependencies: z.boolean().default(false),
    paid: z.boolean().default(false),
    security: z.boolean().default(false),
    deleteWork: z.boolean().default(false),
    other: z.string().max(600).default(''),
  })
  .strict();
export type CrewAwayPolicy = z.infer<typeof crewAwayPolicySchema>;
export const DEFAULT_AWAY_POLICY: CrewAwayPolicy = crewAwayPolicySchema.parse({});

/** The person's standing permission for the Lead to settle a stuck task alone while they are away from the computer. */
export const crewAwaySchema = z
  .object({
    enabled: z.boolean().default(false),
    // How long to wait for the person first. 0 means the Lead acts as soon as it has options.
    minutes: z.number().int().min(0).max(240).default(15),
    // The task of every automatic choice made so far, so each task and the whole run have a ceiling.
    picked: z.array(z.string().max(60)).max(40).default([]),
    // What the Lead decided in the person's place, and what it says they should check on return. The report lists these.
    decisions: z.array(z.object({
      at: z.string(),
      taskId: z.string().max(60),
      task: z.string().max(300),
      question: z.string().max(1_200),
      choice: z.string().max(1_200),
      check: z.string().max(800).default(''),
    }).strict()).max(40).default([]),
    // When away mode was last turned on, so turning it off can say what happened in between.
    since: z.string().nullable().default(null),
    policy: crewAwayPolicySchema.default(DEFAULT_AWAY_POLICY),
  })
  .strict();
export type CrewAway = z.infer<typeof crewAwaySchema>;

export const crewRunSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    projectId: z.string().min(1),
    goal: z.string().trim().min(1).max(4_000),
    // The brief as the user handed it to this run, used to detect later Studio edits.
    briefSnapshot: z.string().max(200_000).nullable().default(null),
    status: crewRunStatusSchema,
    config: crewConfigSchema,
    tasks: z.array(crewTaskSchema).max(300),
    feed: z.array(crewFeedEntrySchema).max(400),
    ask: crewAskSchema.nullable().default(null),
    // A request made after the run finished, kept until the Lead has turned it into tasks, so an interrupted
    // follow-up plans again on resume instead of quietly doing nothing.
    followUp: z.string().max(2_000).nullable().default(null),
    // The person's standing instruction to carry on through every phase of the plan without waiting to be told.
    keepGoing: z.boolean().default(false),
    // Phases the person has accepted, by key, so the plan's wait for acceptance is a recorded yes and not a typed sentence.
    acceptedPhases: z.array(z.string().max(200)).max(40).default([]),
    // Phases the person wants the crew to stop after, even with keep going on.
    pauseAfter: z.array(z.string().max(200)).max(40).default([]),
    // Phases whose spend question the person has already answered, so it is asked once.
    phaseSpendOk: z.array(z.string().max(200)).max(40).default([]),
    // What reviewers noticed that was not worth stopping a task for.
    notes: z.array(crewNoteSchema).max(60).default([]),
    // Blockers the crew has already worked out a way past (a commit hook rejecting a word, say), so the same one is
    // not met again as if it were new and its workaround is not repeated.
    knownBlockers: z.array(z.string().max(120)).max(20).default([]),
    // Whether the Lead writes for someone who is not very technical: no jargon, terms explained the first time.
    explainSimply: z.boolean().default(true),
    // Away mode: the Lead takes one of its own safe options for a stuck task instead of waiting for the person.
    away: crewAwaySchema.default({ enabled: false, minutes: 15, picked: [], decisions: [], since: null, policy: DEFAULT_AWAY_POLICY }),
    // Questions about other tasks that came up while one was already waiting on the person; each comes up in turn.
    queuedAsks: z.array(crewAskSchema).max(20).default([]),
    // Each time a task was stopped for costing far more than a usual task, so the next stop for it comes later.
    spendAsked: z.array(z.string().max(60)).max(200).default([]),
    // Things waiting for, or already given, the person's yes or no.
    approvals: z.array(crewApprovalSchema).max(30).default([]),
    // What the Lead found still undone when the board finished, so "done" says what is and is not.
    remaining: z.array(z.string().max(300)).max(20).default([]),
    // The conversation the crew works in, so the person can open the full transcript of what it did.
    conversationId: z.string().min(1).nullable().default(null),
    // A conversation for questions asked while the crew is working, so a question never shares the one its agents are in.
    askConversationId: z.string().min(1).nullable().default(null),
    // The thread between the person and the Lead.
    chat: z.array(crewChatEntrySchema).max(200).default([]),
    // The design as it was when the Lead planned, so the plan and the pages it names stay comparable.
    design: crewDesignSchema.nullable().default(null),
    // The conversations the crew's agents are running in right now, so the screen can show what they are doing.
    liveConversations: z.array(z.string().min(1)).max(60).optional(),
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
  // Tester, auditor, licence, compliance and operator are offered when someone adds a role; they are not on a new crew by default,
  // because each reviewer adds a model call to every finished task.
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
    // What the start interview settled, when it was used: carry on through every phase, and write simply.
    keepGoing: z.boolean().optional(),
    explainSimply: z.boolean().optional(),
  })
  .strict();
export type CrewStartInput = z.infer<typeof crewStartInputSchema>;

export const crewAcceptPhaseInputSchema = z.object({ runId: z.string().min(1), phase: z.string().min(1).max(200) }).strict();
export const crewPauseAfterInputSchema = z.object({ runId: z.string().min(1), phase: z.string().min(1).max(200), on: z.boolean() }).strict();
/** What a task changed, file by file, as a unified diff against the project as it was before the task started. */
export interface CrewTaskDiff {
  files: Array<{ path: string; diff: string }>;
  /** Files the task changed that are not shown, because the list is capped. */
  more: number;
}
export const crewRevertInputSchema = z.object({ runId: z.string().min(1), taskId: z.string().min(1) }).strict();
/** What undoing a task would change, listed before the person is asked to agree. */
export interface CrewRevertPreview {
  files: Array<{ path: string; added: number; removed: number }>;
  /** The tasks that would be built again: the chosen one and every task that started after it. */
  tasks: string[];
}

export const crewControlInputSchema = z.object({ runId: z.string().min(1) }).strict();

/** A message to the Lead from the Chat tab. */
export const crewMessageInputSchema = z
  .object({ runId: z.string().min(1), kind: z.enum(['ask', 'steer', 'work']), text: z.string().trim().min(1).max(2_000) })
  .strict();
export type CrewMessageInput = z.infer<typeof crewMessageInputSchema>;

export const crewDecideInputSchema = z.object({ runId: z.string().min(1), approvalId: z.string().min(1), approve: z.boolean() }).strict();
export type CrewDecideInput = z.infer<typeof crewDecideInputSchema>;
export const crewExplainSimplyInputSchema = z.object({ runId: z.string().min(1), explainSimply: z.boolean() }).strict();

export const crewAwayInputSchema = z.object({ runId: z.string().min(1), enabled: z.boolean(), minutes: z.number().int().min(0).max(240), policy: crewAwayPolicySchema.optional() }).strict();
export const crewKeepGoingInputSchema = z.object({ runId: z.string().min(1), keepGoing: z.boolean() }).strict();

/**
 * The short interview before a crew plans: what the Lead understood, and the few things it could not tell from the
 * goal. Nothing is assumed: what it leaves out is listed with the reason, and the person can ask for it back.
 */
export const CREW_INTERVIEW_TOPICS = {
  scope: 'How much to do',
  done: 'What counts as finished',
  run: 'How to run or install it',
  autonomy: 'How far to go without checking in',
} as const;
export type CrewInterviewTopic = keyof typeof CREW_INTERVIEW_TOPICS;
export const crewInterviewTopicSchema = z.enum(['scope', 'done', 'run', 'autonomy']);

export const crewInterviewItemSchema = z
  .object({
    id: z.string().min(1).max(40),
    topic: crewInterviewTopicSchema,
    question: z.string().min(1).max(400),
    // Why it is being asked, in plain words.
    why: z.string().max(400).default(''),
    options: z.array(z.string().min(1).max(160)).max(6).default([]),
  })
  .strict();
export type CrewInterviewItem = z.infer<typeof crewInterviewItemSchema>;

export const crewInterviewSchema = z
  .object({
    // What the Lead understood the goal to be, in plain words.
    summary: z.string().max(1_200).default(''),
    // The parts the goal or its plan is split into, when it is split (for example the plan's phases).
    phases: z.array(z.string().min(1).max(200)).max(20).default([]),
    items: z.array(crewInterviewItemSchema).max(6).default([]),
    // Topics it chose not to ask about, each with the reason, so nothing is skipped without being said.
    left: z.array(z.object({ topic: crewInterviewTopicSchema, reason: z.string().max(300).default('') }).strict()).max(6).default([]),
    // Files it read to understand the goal.
    usedFiles: z.array(z.string().max(400)).max(6).default([]),
    // Why there are no questions, when the interview could not run (the model is off, or it did not answer).
    note: z.string().max(400).default(''),
  })
  .strict();
export type CrewInterview = z.infer<typeof crewInterviewSchema>;

/** The question for a topic the Lead left out, for when the person asks for it back. Worded here, not by the model. */
export const CREW_INTERVIEW_TEMPLATES: Record<CrewInterviewTopic, { question: string; why: string; options: string[] }> = {
  scope: { question: 'How much should the crew do now?', why: 'A big goal is easier to check in pieces.', options: ['Just the first part', 'The first few parts', 'All of it'] },
  done: { question: 'What counts as finished?', why: 'It tells the crew when to stop and the reviewers what to check.', options: ['The tests pass', 'I will review it myself', 'Both'] },
  run: { question: 'How do you run or install it?', why: 'So the crew can try it and tell you how to use it.', options: ['It runs from the project folder', 'It needs installing', 'Not sure, you decide'] },
  autonomy: { question: 'How far should the crew go before it checks in with you?', why: 'You can have it stop after each phase, or carry on.', options: ['Stop after each phase and ask me', 'Keep going through every phase'] },
};

export const crewInterviewInputSchema = z.object({ projectId: z.string().min(1), goal: z.string().trim().min(1).max(4_000) }).strict();
export type CrewInterviewInput = z.infer<typeof crewInterviewInputSchema>;

/** New roles, agents, models or limits for a crew that already exists, applied from its next task on. */
export const crewUpdateConfigInputSchema = z.object({ runId: z.string().min(1), config: crewConfigSchema }).strict();
export type CrewUpdateConfigInput = z.infer<typeof crewUpdateConfigInputSchema>;

/** More work for a crew that has finished: the Lead plans it onto the same board, with the same roles and context. */
export const crewFollowUpInputSchema = z.object({ runId: z.string().min(1), prompt: z.string().trim().min(1).max(2_000) }).strict();
export type CrewFollowUpInput = z.infer<typeof crewFollowUpInputSchema>;

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
const READ_ONLY_KINDS: ReadonlySet<CrewRoleKind> = new Set(['lead', 'planner', 'reviewer', 'security', 'tester', 'auditor', 'license', 'compliance']);

export function roleAccess(role: Pick<CrewRole, 'kind' | 'access'>): 'read' | 'edit' {
  return READ_ONLY_KINDS.has(role.kind) ? 'read' : role.access;
}

export interface CrewReport {
  headline: string;
  built: string[];
  verified: string[];
  verdicts: Array<{ role: string; verdict: 'ship' | 'noShip'; note: string }>;
  openRisks: string[];
  /** Decisions the Lead took while the person was away, each with what to check. */
  awayDecisions: string[];
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
    awayDecisions: awayDecisionLines(run),
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

/** One line per decision the Lead took for the person while they were away: the question, the choice, and what to check. */
export function awayDecisionLines(run: Pick<CrewRun, 'away'>, taskIds?: ReadonlySet<string>): string[] {
  return (run.away?.decisions ?? [])
    .filter((item) => !taskIds || taskIds.has(item.taskId))
    .map((item) => `"${item.task}": asked ${item.question} Chose: ${item.choice}${item.check ? ` Check: ${item.check}` : ''}`);
}

/** The same phase under different wordings ("Phase 1: Shell" and "Phase 1 - Shell, gating") reads as one. */
export function phaseKey(name: string): string {
  const numbered = /phase\s*(\d+)/i.exec(name);
  if (numbered) return `phase ${numbered[1]}`;
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 40);
}

export interface CrewRoadmapPhase {
  key: string;
  name: string;
  /** notStarted has no tasks yet; done has every task accepted but not yet accepted by the person. */
  status: 'notStarted' | 'waiting' | 'building' | 'done' | 'accepted';
  tasks: number;
  finished: number;
  costUsd: number;
  /** A rough cost for a phase not started, from the phases already finished; null when none has finished. */
  estimateUsd: number | null;
}

/**
 * The plan as a list of phases with where each one stands, instead of one flat board. A phase is known from the tasks
 * planned for it and from what the Lead found still undone, so phases not started yet are on the list too.
 */
export function buildRoadmap(run: Pick<CrewRun, 'tasks' | 'remaining' | 'acceptedPhases'>): CrewRoadmapPhase[] {
  const order: string[] = [];
  const names = new Map<string, string>();
  const byPhase = new Map<string, CrewTask[]>();
  for (const task of run.tasks) {
    if (task.proposed || !task.phase) continue;
    const key = phaseKey(task.phase);
    if (!byPhase.has(key)) { byPhase.set(key, []); order.push(key); names.set(key, task.phase); }
    byPhase.get(key)!.push(task);
  }
  for (const text of run.remaining) {
    const key = phaseKey(text);
    if (!names.has(key)) { names.set(key, text); order.push(key); }
  }
  const rows: CrewRoadmapPhase[] = order.map((key) => {
    const tasks = byPhase.get(key) ?? [];
    const finished = tasks.filter((task) => task.status === 'accepted' || task.status === 'skipped').length;
    const status: CrewRoadmapPhase['status'] = tasks.length === 0
      ? 'notStarted'
      : finished === tasks.length
        ? (run.acceptedPhases.includes(key) ? 'accepted' : 'done')
        : tasks.some((task) => task.status !== 'backlog') ? 'building' : 'waiting';
    return { key, name: names.get(key) ?? key, status, tasks: tasks.length, finished, costUsd: Math.round(tasks.reduce((sum, task) => sum + task.costUsd, 0) * 100) / 100, estimateUsd: null };
  });
  const paid = rows.filter((row) => (row.status === 'done' || row.status === 'accepted') && row.costUsd > 0);
  const average = paid.length > 0 ? Math.round((paid.reduce((sum, row) => sum + row.costUsd, 0) / paid.length) * 100) / 100 : null;
  return rows.map((row) => (row.status === 'notStarted' ? { ...row, estimateUsd: average } : row));
}

export interface CrewStatusLine {
  tone: 'working' | 'waiting' | 'paused' | 'done' | 'problem';
  text: string;
}

/**
 * One line, in plain words, of what the crew is doing and whether anything is in its way, so nobody has to read the
 * feed to find out. Anything waiting on the person comes first.
 */
export function crewStatusLine(run: CrewRun): CrewStatusLine {
  const board = run.tasks.filter((task) => !task.proposed);
  const count = (statuses: Array<CrewTask['status']>): number => board.filter((task) => statuses.includes(task.status)).length;
  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  const spent = `$${run.spentUsd.toFixed(2)} so far`;
  const open = board.filter((task) => task.status !== 'accepted' && task.status !== 'skipped').length;
  // A parked question leaves the run working on the other tasks, and the line says so.
  if (run.ask) return { tone: 'waiting', text: `${run.status === 'running' ? 'Working on other tasks; one waits on you' : 'Waiting on you'}: ${run.ask.message.slice(0, 180)}` };
  switch (run.status) {
    case 'planning':
      return { tone: 'working', text: 'The Lead is reading the project and planning the tasks.' };
    case 'awaitingApproval':
      return { tone: 'waiting', text: 'Waiting on you: the plan is ready for your OK.' };
    case 'needsYou':
      return { tone: 'waiting', text: `Waiting on you: ${plural(count(['needsYou']), 'task needs', 'tasks need')} a decision.` };
    case 'paused':
      return { tone: 'paused', text: `Paused. ${plural(open, 'task', 'tasks')} unfinished. ${spent}.` };
    case 'stopped':
      return { tone: 'paused', text: `Stopped with ${plural(open, 'task', 'tasks')} unfinished. ${spent}.` };
    case 'completed':
      return { tone: 'done', text: `Finished: ${count(['accepted'])} of ${board.length} tasks accepted${run.remaining.length > 0 ? `. Not finished: ${run.remaining[0]}` : ''}. ${spent}.` };
    default: {
      const building = count(['building']);
      const checking = count(['review']);
      const doing = building > 0 ? `Building ${plural(building, 'task', 'tasks')}` : checking > 0 ? `Checking ${plural(checking, 'task', 'tasks')}` : 'Choosing the next task';
      const stuck = count(['needsYou']);
      return { tone: stuck > 0 ? 'problem' : 'working', text: `${doing}, ${stuck > 0 ? `${stuck} blocked` : 'nothing blocked'}, ${count(['backlog', 'sentBack'])} waiting. ${spent}.` };
    }
  }
}

/**
 * The report for one phase: what was built, how it was checked, the files, what reviewers noticed, and the cost. It is
 * written when the person accepts the phase, so there is a record to read and keep.
 */
export function phaseReportMarkdown(run: CrewRun, phase: string, at: string): string {
  const key = phaseKey(phase);
  const row = buildRoadmap(run).find((item) => item.key === key);
  const tasks = run.tasks.filter((task) => !task.proposed && task.phase !== null && phaseKey(task.phase) === key);
  const files = [...new Set(tasks.flatMap((task) => task.files))];
  const roleLabel = (id: string): string => run.config.roles.find((role) => role.id === id)?.label ?? id;
  const notes = run.notes.filter((note) => tasks.some((task) => task.id === note.taskId));
  const line = (task: CrewTask): string => {
    const sentBack = task.reviews.filter((review) => review.verdict === 'sendBack').length;
    return `- ${task.title}: ${task.status}${task.round > 1 ? `, ${task.round} rounds` : ''}${sentBack > 0 ? `, sent back ${sentBack} ${sentBack === 1 ? 'time' : 'times'}` : ''}${task.costUsd > 0 ? `, $${task.costUsd.toFixed(2)}` : ''}`;
  };
  return [
    `# ${row?.name ?? phase}`,
    `_Report written by the KAI Crew on ${at.slice(0, 10)}._`,
    '## What was built',
    tasks.length > 0 ? tasks.map(line).join('\n') : '- Nothing recorded.',
    '## How it was checked',
    tasks.flatMap((task) => task.reviews.filter((review) => review.verdict === 'accept').map((review) => `- ${task.title}: ${roleLabel(review.reviewer)} accepted it in round ${review.round}.`)).join('\n') || '- No reviews recorded.',
    `## Files changed (${files.length})`,
    files.length > 0 ? files.slice(0, 80).map((file) => `- \`${file}\``).join('\n') + (files.length > 80 ? `\n- and ${files.length - 80} more` : '') : '- None recorded.',
    '## Notes from the reviewers',
    notes.length > 0 ? notes.map((note) => `- ${roleLabel(note.role)}: ${note.text}`).join('\n') : '- None.',
    ...((): string[] => {
      const decided = awayDecisionLines(run, new Set(tasks.map((task) => task.id)));
      return decided.length > 0 ? ['## Decided while you were away: check these', decided.map((item) => `- ${item}`).join('\n')] : [];
    })(),
    '## Cost',
    `$${(row?.costUsd ?? 0).toFixed(2)} across ${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}.`,
  ].join('\n\n') + '\n';
}

export interface CrewDecision {
  at: string;
  text: string;
  kind: 'you' | 'learned';
}

/** What was decided on this crew, in order: the person's own approvals, steers, acceptances and requests, and what the crew learned. */
export function buildDecisions(run: Pick<CrewRun, 'chat' | 'feed'>): CrewDecision[] {
  const fromYou: CrewDecision[] = run.chat
    .filter((entry) => entry.from === 'you' && entry.kind !== 'ask')
    .map((entry) => ({ at: entry.at, kind: 'you' as const, text: entry.kind === 'steer' ? `Told the crew: ${entry.text}` : entry.kind === 'work' ? `Asked for more: ${entry.text}` : entry.text }));
  const learned: CrewDecision[] = run.feed
    .filter((entry) => entry.who === 'crew' && entry.text.includes('has been told'))
    .map((entry) => ({ at: entry.at, kind: 'learned' as const, text: entry.text }));
  return [...fromYou, ...learned].sort((a, b) => a.at.localeCompare(b.at));
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
