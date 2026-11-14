import * as crypto from 'node:crypto';
import {
  readyCards,
  resolveRole,
  roleConfigFor,
  type ArtifactKind,
  type BoardCard,
  type CardRun,
  type BoardStatus,
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
  type TeamRecordEntry,
  type TeamRecordAdvice,
  type TeamRecordQuery,
  type TeamPlanFromPartsInput,
  type StudioBoard,
} from '@kai/contracts';
import { agentName, assignTeam, completeTeam, partLevel, reach, resolveOrchestrator, teamAdvice, type AssignmentEnvironment } from './team-assign';
import { boardCardPart, boardCardPrompt } from './board-brief';
import { withFileAgents, type FileAgentRole } from './file-agents';
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
export type TeamStartRequest = Omit<TeamStartInput, 'checkCommand' | 'maxRounds' | 'parallel' | 'maxConcurrent'>
  & Partial<Pick<TeamStartInput, 'checkCommand' | 'maxRounds' | 'parallel' | 'maxConcurrent'>>;

export interface TeamPlannerPorts {
  settings(): Promise<AppSettings>;
  /** The team saved for one project, when it has its own; null when it uses the team from Settings. */
  projectTeam?(projectId: string): Promise<AgentTeam | null>;
  /** Roles the project defines as files in `.kai/agents`, added to whichever team applies. */
  fileAgents?(projectId: string): Promise<FileAgentRole[]>;
  teamRecords?(): Promise<TeamRecordEntry[]>;
  agentCapabilities(): Promise<AgentCapability[]>;
  directApi(): Promise<{ available: boolean; displayName: string; unavailableReason?: string; local?: boolean; provider?: string }>;
  proxyReady(): Promise<boolean>;
  createConversation(projectId: string, title: string): Promise<ConversationRecord>;
  runAgent(request: AgentRunRequest, ownerWindowId: number): Promise<AgentRunResult>;
  startWorkflow(input: WorkflowStartInput, ownerWindowId: number): Promise<WorkflowRun>;
  /** The board, when there is a Project Studio project behind this planner. */
  board?(projectId: string): Promise<StudioBoard>;
  /** The artifacts a card's brief is built from, keyed by kind. */
  artifactsFor?(projectId: string): Promise<Partial<Record<ArtifactKind, string>>>;
  /** The board's own claim, so two agents never hold the same card where cognitive1 is not configured. */
  claimCard?(projectId: string, cardId: string, agent: string): Promise<BoardCard>;
  recordCardRun?(projectId: string, cardId: string, run: CardRun): Promise<BoardCard>;
  moveCard?(projectId: string, cardId: string, status: BoardStatus, note?: string): Promise<BoardCard>;
  /** The files Git reports as changed, so a card records where it touched the project rather than what the agent claims. */
  changedFilesFor?(projectId: string): Promise<string[]>;
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
    const env = await this.environment(input.projectId);
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
    // Every part leaves with a level, so the plan card can pick the matching model when the user changes its agent.
    const ordered = (orderParts(guarded.parts) ?? guarded.parts)
      .map((part) => ({ ...part, effort: partLevel(part, resolveRole(team, part.role).access) }));
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
      source: 'orchestrator',
      warnings: [...orchestrator.warnings, ...guarded.warnings, ...assigned.warnings],
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * A plan from parts the user already has (the Prompt Guide wrote them), so no orchestrator call is made. The same
   * safeguards apply: reviews are added, parts are ordered and levelled, and every part gets a ready agent.
   */
  async planFromParts(input: TeamPlanFromPartsInput): Promise<TeamPlanDraft> {
    const settings = await this.ports.settings();
    const { team, scope } = await this.teamFor(input.projectId, settings);
    const problem = checkStructure(input.parts);
    if (problem) throw new Error(`These prompts cannot become a plan: ${problem}.`);
    const env = await this.environment(input.projectId);
    const guarded = applyGuardrails(input.goal, input.parts, team);
    const ordered = (orderParts(guarded.parts) ?? guarded.parts)
      .map((part) => ({ ...part, effort: partLevel(part, resolveRole(team, part.role).access) }));
    const assigned = assignTeam(ordered, team, env);
    return {
      id: `team_${crypto.randomUUID()}`,
      projectId: input.projectId,
      goal: input.goal,
      summary: 'Planned from the Prompt Guide.',
      parts: ordered,
      assignments: assigned.assignments,
      // No orchestrator ran; the field still names who would have, for the plan card's label.
      orchestrator: { assignee: 'api', route: 'direct', reason: 'The Prompt Guide wrote these prompts, so the orchestrator was not needed.' },
      teamScope: scope,
      source: 'prompt-guide',
      warnings: [...guarded.warnings, ...assigned.warnings],
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * A plan built straight from the board: one part per `ready` card, with the card's story, acceptance criteria,
   * artifacts and design ref as the brief. No orchestrator call is made — the board already did the splitting.
   */
  async planFromBoard(projectId: string): Promise<TeamPlanDraft> {
    if (!this.ports.board) throw new Error('The Project Studio board is not available.');
    const settings = await this.ports.settings();
    const { team, scope } = await this.teamFor(projectId, settings);
    const [board, artifacts] = await Promise.all([this.ports.board(projectId), this.ports.artifactsFor?.(projectId) ?? Promise.resolve({})]);
    const ready = readyCards(board);
    if (ready.length === 0) throw new Error('No card is ready. Finish or promote a card on the board first.');
    const parts = ready.map((card) => boardCardPart(card, artifacts));
    const env = await this.environment(projectId);
    const ordered = (orderParts(parts) ?? parts).map((part) => ({ ...part, effort: partLevel(part, resolveRole(team, part.role).access) }));
    const assigned = assignTeam(ordered, team, env);
    return {
      id: `team_${crypto.randomUUID()}`,
      projectId,
      goal: `Work the board: ${ready.map((card) => card.title).join(', ')}`.slice(0, 4_000),
      summary: `${ready.length} ready card${ready.length === 1 ? '' : 's'} from the Project Studio board.`,
      parts: ordered,
      assignments: assigned.assignments,
      orchestrator: { assignee: 'api', route: 'direct', reason: 'The board already split the work, so no orchestrator ran.' },
      teamScope: scope,
      source: 'board',
      warnings: [...assigned.warnings, 'A card is only moved to done by the board, and only when its check still passes.'],
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Runs one ready card, or as many as `maxCards` of them in order, one agent per card. Each card is claimed before
   * it runs and its result is recorded on it. The card ends in `review`, or back in `ready` with what it needs when
   * the run failed — never in `done`, whatever the agent says.
   */
  async workBoard(projectId: string, ownerWindowId: number, options: { maxCards?: number; agent?: AgentId; model?: string } = {}): Promise<BoardCard[]> {
    const ports = this.ports;
    if (!ports.board || !ports.claimCard || !ports.recordCardRun || !ports.moveCard) {
      throw new Error('The Project Studio board is not available.');
    }
    const settings = await ports.settings();
    const env = await this.environment(projectId);
    const limit = Math.max(1, options.maxCards ?? 1);
    const worked: BoardCard[] = [];
    for (let index = 0; index < limit; index += 1) {
      const board = await ports.board(projectId);
      const card = readyCards(board)[0];
      if (!card) break;
      const agent = options.agent ?? settings.defaultAgent;
      if (!reach(agent, settings.defaultRoute, env)) {
        throw new Error(`${agentName(agent, env)} is not ready over the ${settings.defaultRoute} route, so no card can run.`);
      }
      await ports.claimCard(projectId, card.id, agentName(agent, env));
      const artifacts = (await ports.artifactsFor?.(projectId)) ?? {};
      const conversation = await ports.createConversation(projectId, `Card: ${card.title}`.slice(0, 120));
      const result = await ports.runAgent({
        conversationId: conversation.id,
        prompt: boardCardPrompt(card, artifacts),
        agent,
        execution: 'cli',
        route: settings.defaultRoute,
        autonomy: settings.defaultAutonomy,
        freshSession: true,
        ...(options.model ? { model: options.model } : {}),
      }, ownerWindowId);
      await ports.recordCardRun(projectId, card.id, {
        agent,
        model: options.model ?? null,
        at: new Date().toISOString(),
        // What Git says the run changed, so the card's footprint is a fact rather than the agent's summary.
        files: (await ports.changedFilesFor?.(projectId)) ?? [],
      });
      const failed = result.status === 'failed';
      worked.push(await ports.moveCard(
        projectId,
        card.id,
        failed ? 'blocked' : 'review',
        failed ? `The run failed: ${result.error ?? 'unknown error'}` : 'The agent finished; the card needs a check and a person.',
      ));
    }
    return worked;
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
    const env = await this.environment(input.projectId);
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
      ...(input.parallel ? { parallel: { maxConcurrent: input.maxConcurrent ?? 3 } } : {}),
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
      suggestedAssignee: assignment.suggestedAssignee ?? assignment.assignee,
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
    const fileRoles = await this.ports.fileAgents?.(projectId).catch(() => []) ?? [];
    return own
      ? { team: withFileAgents(completeTeam(own), fileRoles), scope: 'project' }
      : { team: withFileAgents(completeTeam(settings.agentTeam), fileRoles), scope: 'settings' };
  }

  private plannerReply(result: AgentRunResult, team: ReturnType<typeof completeTeam>): Promise<ParsedTeamPlan> {
    if (result.status === 'failed' && !result.output.trim()) {
      return Promise.reject(new Error(`The orchestrator could not run: ${result.error ?? 'unknown error'}`));
    }
    return Promise.resolve(parseTeamPlan(result.output, team));
  }

  async advice(input: TeamRecordQuery): Promise<TeamRecordAdvice[]> {
    return teamAdvice(input.team, await this.environment(input.projectId));
  }

  private async environment(projectId?: string): Promise<AssignmentEnvironment> {
    const [capabilities, api, proxyReady, records, settings] = await Promise.all([
      this.ports.agentCapabilities(),
      this.ports.directApi(),
      this.ports.proxyReady(),
      this.ports.teamRecords?.() ?? Promise.resolve([]),
      this.ports.settings(),
    ]);
    return { capabilities, api, proxyReady, platform: process.platform, records, projectId, autoModel: settings.autoModel };
  }
}
