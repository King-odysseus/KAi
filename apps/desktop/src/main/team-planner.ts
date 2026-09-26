import * as crypto from 'node:crypto';
import {
  resolveRole,
  roleConfigFor,
  type AgentCapability,
  type AgentId,
  type AgentTeam,
  type AgentRunRequest,
  type AgentRunResult,
  type AppSettings,
  type ConversationRecord,
  type TeamAssignment,
  type TeamPart,
  type TeamPlanDraft,
  type TeamPlanInput,
  type TeamStartInput,
  type WorkflowRun,
  type WorkflowStartInput,
} from '@kai/contracts';
import { assignTeam, completeTeam, reach, resolveOrchestrator, type AssignmentEnvironment } from './team-assign';
import {
  applyGuardrails,
  buildOrchestratorPrompt,
  buildRepairPrompt,
  buildStepPrompt,
  checkStructure,
  orderParts,
  parseTeamPlan,
  type ParsedTeamPlan,
} from './team-plan';

/** The check and its rounds are optional for a caller; a missing check means the job has none. */
export type TeamStartRequest = Omit<TeamStartInput, 'checkCommand' | 'maxRounds'> & Partial<Pick<TeamStartInput, 'checkCommand' | 'maxRounds'>>;

export interface TeamPlannerPorts {
  settings(): Promise<AppSettings>;
  /** The team saved for one project, when it has its own; null when it uses the team from Settings. */
  projectTeam?(projectId: string): Promise<AgentTeam | null>;
  agentCapabilities(): Promise<AgentCapability[]>;
  directApi(): Promise<{ available: boolean; displayName: string; unavailableReason?: string; local?: boolean }>;
  proxyReady(): Promise<boolean>;
  createConversation(projectId: string, title: string): Promise<ConversationRecord>;
  runAgent(request: AgentRunRequest, ownerWindowId: number): Promise<AgentRunResult>;
  startWorkflow(input: WorkflowStartInput, ownerWindowId: number): Promise<WorkflowRun>;
}

/**
 * Turns a goal into a reviewed plan and then into a workflow. Planning only reads the project: nothing is
 * changed until the user approves the plan and starts it.
 */
export class DesktopTeamPlanner {
  constructor(private readonly ports: TeamPlannerPorts) {}

  async plan(input: TeamPlanInput, ownerWindowId: number): Promise<TeamPlanDraft> {
    const settings = await this.ports.settings();
    const { team, scope } = await this.teamFor(input.projectId, settings);
    const env = await this.environment();
    const orchestrator = resolveOrchestrator(team, env);
    if (!orchestrator) {
      throw new Error('No agent is ready to plan. Install and sign in to a CLI agent, or set up Direct API in Settings.');
    }

    const conversation = await this.ports.createConversation(input.projectId, `Team plan: ${input.goal}`);
    const orchestratorConfig = team.roles.orchestrator;
    const runPlanner = (prompt: string): Promise<AgentRunResult> => this.ports.runAgent({
      conversationId: conversation.id,
      prompt,
      // API-mode runs still carry an agent id for labelling; the default agent is only a label there.
      agent: orchestrator.assignee === 'api' ? settings.defaultAgent : orchestrator.assignee,
      execution: orchestrator.assignee === 'api' ? 'api' : 'cli',
      route: orchestrator.route,
      // Planning must never change files.
      autonomy: 'plan',
      freshSession: true,
      ...(orchestratorConfig?.model ? { model: orchestratorConfig.model } : {}),
    }, ownerWindowId);

    let parsed = await this.plannerReply(await runPlanner(buildOrchestratorPrompt(input.goal, team)), team);
    if (!parsed.ok) parsed = await this.plannerReply(await runPlanner(buildRepairPrompt(parsed.error)), team);
    if (!parsed.ok) throw new Error(`The orchestrator did not return a usable plan (${parsed.error}). Try again, or pick a different orchestrator in Settings.`);

    const guarded = applyGuardrails(input.goal, parsed.plan.parts, team);
    const ordered = orderParts(guarded.parts) ?? guarded.parts;
    const assigned = assignTeam(ordered, team, env);
    return {
      id: `team_${crypto.randomUUID()}`,
      projectId: input.projectId,
      goal: input.goal,
      summary: parsed.plan.summary,
      parts: ordered,
      assignments: assigned.assignments,
      orchestrator: { assignee: orchestrator.assignee, route: orchestrator.route, reason: orchestrator.reason },
      teamScope: scope,
      warnings: [...orchestrator.warnings, ...guarded.warnings, ...assigned.warnings],
      createdAt: new Date().toISOString(),
    };
  }

  async start(input: TeamStartRequest, ownerWindowId: number): Promise<WorkflowRun> {
    const settings = await this.ports.settings();
    const { team } = await this.teamFor(input.projectId, settings);
    const problem = checkStructure(input.parts);
    if (problem) throw new Error(`This plan cannot run: ${problem}.`);
    // checkStructure already proved the parts can be ordered, so the fallback is never used.
    const ordered = orderParts(input.parts) ?? input.parts;
    const byPart = new Map<string, TeamAssignment>(input.assignments.map((assignment) => [assignment.partId, assignment]));

    // Availability can change between planning and approval, so check again before anything runs.
    const env = await this.environment();
    const planned = ordered.map((part) => {
      const assignment = byPart.get(part.id);
      if (!assignment) throw new Error(`"${part.title}" has no agent assigned.`);
      if (!reach(assignment.assignee, assignment.route, env)) {
        throw new Error(`${resolveRole(team, part.role).label} "${part.title}" cannot run: ${assignment.assignee} is not ready over the ${assignment.route} route. Pick another agent and try again.`);
      }
      return { part, assignment };
    });

    return this.ports.startWorkflow({
      projectId: input.projectId,
      title: `Team: ${input.goal.slice(0, 120)}`,
      // Each step carries its own execution, route and autonomy; these are only the workflow-level defaults.
      execution: 'cli',
      route: 'direct',
      autonomy: input.autonomy,
      loop: { enabled: false, maxRounds: 3, maxCostUsd: 0, maxDurationMinutes: 30, checkCommand: '' },
      ...(input.checkCommand?.trim() ? { teamCheck: { command: input.checkCommand.trim(), maxRounds: input.maxRounds ?? 2 } } : {}),
      steps: planned.map(({ part, assignment }) => this.stepFor(part, assignment, input, settings, team)),
    }, ownerWindowId);
  }

  private stepFor(
    part: TeamPart,
    assignment: TeamAssignment,
    input: TeamStartRequest,
    settings: AppSettings,
    team: ReturnType<typeof completeTeam>,
  ): WorkflowStartInput['steps'][number] {
    const info = resolveRole(team, part.role);
    const config = roleConfigFor(team, part.role);
    const agent: AgentId = assignment.assignee === 'api' ? settings.defaultAgent : assignment.assignee;
    const model = assignment.model ?? config.model;
    return {
      id: part.id,
      agent,
      label: `${info.label}: ${part.title}`,
      prompt: buildStepPrompt(input.goal, part, config, info),
      ...(part.dependsOn.length > 0 ? { dependsOn: part.dependsOn } : {}),
      role: part.role,
      access: info.access,
      execution: assignment.assignee === 'api' ? 'api' : 'cli',
      route: assignment.route,
      // Reviewers only read, whatever autonomy the user chose for the editing roles.
      autonomy: info.access === 'read' ? 'plan' : input.autonomy,
      ...(model ? { model } : {}),
      ...(part.role === 'securityReviewer' ? { gate: 'security' as const } : {}),
      ...(part.paths.length > 0 ? { paths: part.paths } : {}),
    };
  }

  private async teamFor(projectId: string, settings: AppSettings): Promise<{ team: ReturnType<typeof completeTeam>; scope: 'project' | 'settings' }> {
    const own = await this.ports.projectTeam?.(projectId);
    return own ? { team: completeTeam(own), scope: 'project' } : { team: completeTeam(settings.agentTeam), scope: 'settings' };
  }

  private plannerReply(result: AgentRunResult, team: ReturnType<typeof completeTeam>): Promise<ParsedTeamPlan> {
    if (result.status === 'failed' && !result.output.trim()) {
      return Promise.reject(new Error(`The orchestrator could not run: ${result.error ?? 'unknown error'}`));
    }
    return Promise.resolve(parseTeamPlan(result.output, team));
  }

  private async environment(): Promise<AssignmentEnvironment> {
    const [capabilities, api, proxyReady] = await Promise.all([
      this.ports.agentCapabilities(),
      this.ports.directApi(),
      this.ports.proxyReady(),
    ]);
    return { capabilities, api, proxyReady, platform: process.platform };
  }
}
