import { z } from 'zod';
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
  .regex(/^[A-Za-z0-9][\w.:/@[\]-]*$/, 'Use a model name such as gpt-5.5 or claude-sonnet-5.');

export const teamRoleConfigSchema = z
  .object({
    assignee: teamAssigneeSchema,
    route: teamRouteChoiceSchema,
    model: teamModelNameSchema.optional(),
    // Extra guidance appended to this role's tasks, for example "check the OWASP Top 10".
    instructions: z.string().max(2_000).default(''),
  })
  .strict();

export const agentTeamSchema = z
  .object({
    preset: teamPresetSchema,
    roles: z.record(teamRoleIdSchema, teamRoleConfigSchema),
  })
  .strict();

export const teamPartSchema = z
  .object({
    id: z.string().min(1).max(40),
    title: z.string().trim().min(1).max(120),
    role: teamWorkerRoleIdSchema,
    prompt: z.string().trim().min(1).max(6_000),
    dependsOn: z.array(z.string().min(1).max(40)).max(12).default([]),
    // Folders or files this part may touch, as the orchestrator reported them.
    paths: z.array(z.string().min(1).max(300)).max(20).default([]),
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
export type TeamPart = z.infer<typeof teamPartSchema>;
export type TeamPlan = z.infer<typeof teamPlanSchema>;
export type TeamBilling = z.infer<typeof teamBillingSchema>;
export type TeamAssignment = z.infer<typeof teamAssignmentSchema>;
export type TeamPlanDraft = z.infer<typeof teamPlanDraftSchema>;
export type TeamPlanInput = z.infer<typeof teamPlanInputSchema>;
export type TeamStartInput = z.infer<typeof teamStartInputSchema>;

/** The team a new install starts with: KAI plans, and every other role is left to Auto on the Balanced preset. */
export function createDefaultAgentTeam(): AgentTeam {
  const auto = { assignee: 'auto', route: 'auto', instructions: '' } as const;
  return {
    preset: 'balanced',
    roles: {
      orchestrator: { assignee: 'api', route: 'direct', instructions: '' },
      frontend: { ...auto },
      backend: { ...auto },
      tests: { ...auto },
      securityReviewer: { ...auto },
      codeReviewer: { ...auto },
      docs: { ...auto },
    },
  };
}
