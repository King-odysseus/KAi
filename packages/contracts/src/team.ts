import { z } from 'zod';
import { workLevelSchema } from './model-tiers';
import { agentIdSchema, autonomyModeSchema, routeModeSchema, timestampSchema } from './primitives';

/** The built-in team roles. The orchestrator plans the job; every other role does or reviews one part of it. */
export const TEAM_ROLE_IDS = [
  'orchestrator',
  'frontend',
  'backend',
  'tests',
  'securityReviewer',
  'codeReviewer',
  'docs',
] as const;

export const teamRoleIdSchema = z.enum(TEAM_ROLE_IDS);
/** Roles that can own a part of the plan (everything except the orchestrator). */
export const teamWorkerRoleIdSchema = z.enum(['frontend', 'backend', 'tests', 'securityReviewer', 'codeReviewer', 'docs']);

/**
 * A role the user defines. Its id is fixed when it is created, so renaming it never orphans a plan or a running job.
 */
export const customRoleIdSchema = z
  .string()
  .max(40)
  .regex(/^custom-[a-z0-9]+(?:-[a-z0-9]+)*$/, 'A custom role id looks like custom-database.');
/** The role of one part of a plan: a built-in worker role or a custom one. */
export const teamPartRoleSchema = z.union([teamWorkerRoleIdSchema, customRoleIdSchema]);

/** A specific CLI, KAI's own API mode, or "auto" to let KAI choose. */
export const teamAssigneeSchema = z.union([agentIdSchema, z.literal('api'), z.literal('auto')]);
/** A concrete choice once KAI has decided. */
export const teamResolvedAssigneeSchema = z.union([agentIdSchema, z.literal('api')]);
export const teamRouteChoiceSchema = z.union([routeModeSchema, z.literal('auto')]);
export const teamPresetSchema = z.enum(['quality', 'balanced', 'budget']);

// Same rule as cliModelNameSchema in domain.ts (a model name reaches a command line); repeated here so the
// settings schema can include the team without importing domain.ts back.
const teamModelNameSchema = z
  .string()
  .max(100)
  .regex(/^[A-Za-z0-9][\w.:/@[\]-]*$/, 'Use a model name such as gpt-5.6-sol or claude-sonnet-5.');

/** When KAI adds this role to a job on its own: every job, only when the job touches sensitive areas, or never. */
export const teamAutoAddSchema = z.enum(['always', 'sensitive', 'never']);

export const teamRoleConfigSchema = z
  .object({
    assignee: teamAssigneeSchema,
    route: teamRouteChoiceSchema,
    model: teamModelNameSchema.optional(),
    // Left out, the role follows DEFAULT_AUTO_ADD. "never" still lets the orchestrator plan the role itself.
    autoAdd: teamAutoAddSchema.optional(),
    // Extra guidance appended to this role's tasks, for example "check the OWASP Top 10".
    instructions: z.string().max(2_000).default(''),
  })
  .strict();

export const customRoleSchema = z
  .object({
    id: customRoleIdSchema,
    label: z.string().trim().min(1).max(60),
    description: z.string().trim().max(300).default(''),
    // Reviewers and auditors read; everything else edits. Fixed by the user, never guessed.
    access: z.enum(['read', 'edit']),
    assignee: teamAssigneeSchema,
    route: teamRouteChoiceSchema,
    model: teamModelNameSchema.optional(),
    instructions: z.string().max(2_000).default(''),
  })
  .strict();

export const MAX_CUSTOM_ROLES = 8;

export const agentTeamSchema = z
  .object({
    preset: teamPresetSchema,
    roles: z.record(teamRoleIdSchema, teamRoleConfigSchema),
    custom: z.array(customRoleSchema).max(MAX_CUSTOM_ROLES).default([]),
  })
  .strict();

export const teamPartSchema = z
  .object({
    id: z.string().min(1).max(40),
    title: z.string().trim().min(1).max(120),
    role: teamPartRoleSchema,
    prompt: z.string().trim().min(1).max(6_000),
    dependsOn: z.array(z.string().min(1).max(40)).max(12).default([]),
    // Folders or files this part may touch, as the orchestrator reported them.
    paths: z.array(z.string().min(1).max(300)).max(20).default([]),
    // How heavy the part is, as the orchestrator judged it; KAI picks the part's model from it.
    effort: workLevelSchema.optional(),
  })
  .strict();

export interface TeamRoleInfo {
  label: string;
  description: string;
  /** Reviewers and the orchestrator only read; the editing roles can change files. */
  access: 'read' | 'edit';
  /** Routine roles are where the Balanced and Budget presets save premium agents' limits. */
  routine: boolean;
}

export const TEAM_ROLE_INFO: Record<TeamRoleId, TeamRoleInfo> = {
  orchestrator: { label: 'Orchestrator', description: 'Reads the project and splits your goal into parts.', access: 'read', routine: false },
  frontend: { label: 'Frontend specialist', description: 'User interface, styling and client-side code.', access: 'edit', routine: false },
  backend: { label: 'Backend coder', description: 'Server, API, database and business logic.', access: 'edit', routine: false },
  tests: { label: 'Test writer', description: 'Writes and runs tests for the new code.', access: 'edit', routine: true },
  securityReviewer: { label: 'Security reviewer', description: 'Read-only review for auth, secrets, injection and unsafe input. Can stop the job.', access: 'read', routine: false },
  codeReviewer: { label: 'Code reviewer', description: 'Read-only review of correctness and quality across all parts.', access: 'read', routine: false },
  docs: { label: 'Docs writer', description: 'README, comments and user-facing documentation.', access: 'edit', routine: true },
};

export type TeamAutoAdd = z.infer<typeof teamAutoAddSchema>;

/** A code review of every job, and a security review when the job is sensitive; nothing else is added unasked. */
export const DEFAULT_AUTO_ADD: Record<TeamRoleId, TeamAutoAdd> = {
  orchestrator: 'never',
  frontend: 'never',
  backend: 'never',
  tests: 'never',
  securityReviewer: 'sensitive',
  codeReviewer: 'always',
  docs: 'never',
};

export function roleAutoAdd(config: { autoAdd?: TeamAutoAdd } | undefined, role: TeamRoleId): TeamAutoAdd {
  return config?.autoAdd ?? DEFAULT_AUTO_ADD[role];
}

export const teamPlanSchema = z
  .object({
    summary: z.string().trim().max(1_000).default(''),
    parts: z.array(teamPartSchema).min(1).max(12),
  })
  .strict();

// "local" is a model running on the user's own machine, which costs nothing per request.
export const teamBillingSchema = z.enum(['subscription', 'proxy', 'api', 'local']);

export const teamAssignmentSchema = z
  .object({
    partId: z.string().min(1).max(40),
    assignee: teamResolvedAssigneeSchema,
    suggestedAssignee: teamResolvedAssigneeSchema.optional(),
    route: routeModeSchema,
    model: teamModelNameSchema.optional(),
    // Why KAI picked this agent, in plain words, shown on the plan card.
    reason: z.string().max(500),
    // What a run of this part is billed against. Proxy and API parts can create per-token charges.
    billing: teamBillingSchema,
  })
  .strict();

export const teamPlanDraftSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    goal: z.string().min(1).max(4_000),
    summary: z.string().max(1_000),
    parts: z.array(teamPartSchema).min(1).max(12),
    assignments: z.array(teamAssignmentSchema).min(1).max(12),
    orchestrator: z
      .object({
        assignee: teamResolvedAssigneeSchema,
        route: routeModeSchema,
        reason: z.string().max(500),
      })
      .strict(),
    // Which team planned this: the one saved for the project, or the team from Settings.
    teamScope: z.enum(['project', 'settings']).default('settings'),
    // Who split the goal into parts: the orchestrator, the user through the Prompt Guide, or the Project Studio's board.
    source: z.enum(['orchestrator', 'prompt-guide', 'board']).default('orchestrator'),
    // Things the user should read before approving, for example an added security review.
    warnings: z.array(z.string().max(500)).max(20),
    createdAt: timestampSchema,
  })
  .strict();

export const teamPlanInputSchema = z
  .object({
    projectId: z.string().min(1),
    goal: z.string().trim().min(1).max(4_000),
  })
  .strict();

export const teamStartInputSchema = z
  .object({
    projectId: z.string().min(1),
    goal: z.string().trim().min(1).max(4_000),
    parts: z.array(teamPartSchema).min(1).max(12),
    assignments: z.array(teamAssignmentSchema).min(1).max(12),
    // How much the editing roles may change. Reviewers always run read-only, whatever this says.
    autonomy: autonomyModeSchema,
    // Run after the team finishes (for example "npm test"). A failure goes back to the part that owns the files
    // it names, up to maxRounds times. Empty means no check.
    checkCommand: z.string().trim().max(1_000).default(''),
    maxRounds: z.number().int().min(1).max(5).default(2),
    // Run parts that do not depend on each other at the same time, each in its own copy of the project.
    parallel: z.boolean().default(false),
    maxConcurrent: z.number().int().min(2).max(8).default(3),
  })
  .strict();

export type TeamRoleId = z.infer<typeof teamRoleIdSchema>;
export type TeamWorkerRoleId = z.infer<typeof teamWorkerRoleIdSchema>;
export type TeamAssignee = z.infer<typeof teamAssigneeSchema>;
export type TeamResolvedAssignee = z.infer<typeof teamResolvedAssigneeSchema>;
export type TeamRouteChoice = z.infer<typeof teamRouteChoiceSchema>;
export type TeamPreset = z.infer<typeof teamPresetSchema>;
export type TeamRoleConfig = z.infer<typeof teamRoleConfigSchema>;
export type AgentTeam = z.infer<typeof agentTeamSchema>;
export type CustomRole = z.infer<typeof customRoleSchema>;
export type TeamPart = z.infer<typeof teamPartSchema>;
export type TeamPlan = z.infer<typeof teamPlanSchema>;
export type TeamBilling = z.infer<typeof teamBillingSchema>;
export type TeamAssignment = z.infer<typeof teamAssignmentSchema>;
export type TeamPlanDraft = z.infer<typeof teamPlanDraftSchema>;
export type TeamPlanInput = z.infer<typeof teamPlanInputSchema>;
export type TeamStartInput = z.infer<typeof teamStartInputSchema>;

/** What a role looks like to the code that plans and runs a job, whether it is built in or the user's own. */
export interface ResolvedRole extends TeamRoleInfo {
  id: string;
  custom: boolean;
}

/** Enough of a team to look roles up; hand-built teams and older settings may leave the custom list out. */
export interface TeamLike {
  roles?: AgentTeam['roles'];
  custom?: AgentTeam['custom'];
}

const hasOwn = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);

export function isBuiltInRole(id: string): id is TeamRoleId {
  return hasOwn(TEAM_ROLE_INFO, id);
}

/**
 * The label, description and access of a role. A role id nothing defines (a custom role deleted after a plan was
 * drafted) is read-only: the safe side, since it can then change nothing.
 */
export function resolveRole(team: TeamLike | undefined, id: string): ResolvedRole {
  if (isBuiltInRole(id)) return { ...TEAM_ROLE_INFO[id], id, custom: false };
  const custom = team?.custom?.find((role) => role.id === id);
  if (custom) return { id, label: custom.label, description: custom.description, access: custom.access, routine: false, custom: true };
  return { id, label: id, description: '', access: 'read', routine: false, custom: true };
}

/** The agent, route, model and instructions chosen for a role; Auto when the team says nothing about it. */
export function roleConfigFor(team: TeamLike | undefined, id: string): TeamRoleConfig {
  const fallback: TeamRoleConfig = { assignee: 'auto', route: 'auto', instructions: '' };
  if (isBuiltInRole(id)) return team?.roles?.[id] ?? fallback;
  const custom = team?.custom?.find((role) => role.id === id);
  return custom
    ? { assignee: custom.assignee, route: custom.route, instructions: custom.instructions, ...(custom.model ? { model: custom.model } : {}) }
    : fallback;
}

/** Whether a workflow step edits files: what it was given, or what its built-in role implies. */
export function stepAccess(step: { role?: string; access?: 'read' | 'edit' }): 'read' | 'edit' | undefined {
  if (step.access) return step.access;
  return step.role && isBuiltInRole(step.role) ? TEAM_ROLE_INFO[step.role].access : undefined;
}

/**
 * Groups steps into waves: every step in a wave only needs steps from earlier waves, so a wave's steps can run at
 * the same time. A dependency on a step not in the list (one already done) is already met. Order within a wave
 * follows the list, and a dependency loop cannot hang: after as many passes as there are steps it stops.
 */
export function planWaves<T extends { id: string; dependsOn?: readonly string[] }>(steps: readonly T[]): T[][] {
  const ids = new Set(steps.map((step) => step.id));
  const level = new Map<string, number>(steps.map((step) => [step.id, 0]));
  for (let pass = 0; pass < steps.length; pass += 1) {
    let changed = false;
    for (const step of steps) {
      const needs = (step.dependsOn ?? []).filter((id) => ids.has(id) && id !== step.id);
      const next = needs.length === 0 ? 0 : Math.min(steps.length, 1 + Math.max(...needs.map((id) => level.get(id) ?? 0)));
      if (next !== level.get(step.id)) {
        level.set(step.id, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const waves: T[][] = [];
  for (const step of steps) {
    const index = level.get(step.id) ?? 0;
    (waves[index] ??= []).push(step);
  }
  return waves.filter((wave) => wave.length > 0);
}

/** The team a new install starts with: KAI plans, and every other role is left to Auto on the Balanced preset. */
export function createDefaultAgentTeam(): AgentTeam {
  const auto = { assignee: 'auto', route: 'auto', instructions: '' } as const;
  return {
    preset: 'balanced',
    custom: [],
    roles: {
      orchestrator: { assignee: 'auto', route: 'auto', instructions: '' },
      frontend: { ...auto },
      backend: { ...auto },
      tests: { ...auto },
      securityReviewer: { ...auto },
      codeReviewer: { ...auto },
      docs: { ...auto },
    },
  };
}
