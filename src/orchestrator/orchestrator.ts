import { EventEmitter } from 'events';
import type { Cognitive1Client } from '../cognitive1/cognitive1-client';
import { DisabledCognitive1Client } from '../cognitive1/cognitive1-client';
import { createEventId, nowIso, type DiffProposalEvent, type WorkbenchEvent } from '../core/events';
import type { AgentCapability, AgentId, AutonomyMode, PermissionKey, RouteMode, TaskRequest, WorkbenchState } from '../core/types';
import { canRunWithoutApproval, createPermissionProfile } from '../core/permissions';
import type { DiffApplier } from './diff-applier';
import { NoopDiffApplier } from './diff-applier';
import type { AgentAdapter } from '../adapters/agent-adapter';
import type { Plan } from '../core/plan';
import { PlanRunner } from './plan-runner';

export interface DiffRecord {
  event: DiffProposalEvent;
  status: 'pending' | 'approved' | 'rejected';
}

export class WorkbenchOrchestrator extends EventEmitter {
  private state: WorkbenchState;
  private readonly adapters = new Map<AgentId, AgentAdapter>();
  private readonly pendingDiffs = new Map<string, DiffRecord>();
  private lastPrompt: string = '';
  private handoffInProgress = false;
  private planRunner: PlanRunner | null = null;
  private planRunning = false;

  constructor(
    initialState: WorkbenchState,
    private readonly cognitive1: Cognitive1Client = new DisabledCognitive1Client(),
    private readonly projectPath?: string,
    private readonly diffApplier: DiffApplier = new NoopDiffApplier(),
  ) {
    super();
    this.state = { ...initialState };
  }

  registerAdapter(adapter: AgentAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  async getCapabilities(): Promise<AgentCapability[]> {
    // One adapter that hangs or throws must never blank the whole panel:
    // resolve each independently and substitute an "unavailable" card on failure.
    const results = await Promise.all(
      [...this.adapters.entries()].map(async ([id, a]): Promise<AgentCapability> => {
        try {
          return await a.getCapability();
        } catch (err) {
          return {
            id,
            displayName: id,
            available: false,
            unavailableReason: err instanceof Error ? err.message : String(err),
            supportsRoutes: ['direct', 'proxy'],
            supportsAutonomy: ['review', 'auto', 'custom'],
            supportsTools: true,
            supportsApprovals: false,
            supportsDiffs: true,
            supportsMcp: false,
            requiredConfigKeys: [],
          };
        }
      }),
    );
    return results;
  }

  async getCognitive1Health(): Promise<{ available: boolean; detail: string }> {
    return this.cognitive1.health();
  }

  getState(): WorkbenchState { return { ...this.state }; }
  getLastPrompt(): string { return this.lastPrompt; }

  getPendingDiffs(): DiffRecord[] {
    return [...this.pendingDiffs.values()].filter((d) => d.status === 'pending');
  }

  // ─── Plan execution ───────────────────────────────────────────

  getPlan(): Plan | null {
    return this.planRunner?.getPlan() ?? null;
  }

  isPlanRunning(): boolean {
    return this.planRunning;
  }

  async executePlan(plan: Plan): Promise<void> {
    if (this.state.isRunning || this.planRunning) {
      throw new Error('KAI already has an active run. Stop it before starting a plan.');
    }

    this.planRunning = true;
    this.planRunner = new PlanRunner(
      plan,
      this.adapters,
      this.cognitive1,
      this.projectPath,
      (event) => this.emitEvent(event),
    );

    this.planRunner.on('planEvent', (planEvent) => {
      this.emit('planEvent', planEvent);

      // Store completed plans in c1 memory
      if (planEvent.type === 'plan.completed' && this.planRunner) {
        const p = this.planRunner.getPlan();
        // Store plan summary in c1 — use learn() if available, fallback to sessionStart
        const c1 = this.cognitive1 as any;
        const summary = JSON.stringify({
          steps: p.steps.length,
          agents: [...new Set(p.steps.map(s => s.agent))],
          completedAt: p.completedAt,
        });
        if (typeof c1.learn === 'function') {
          void c1.learn({ title: p.title, description: summary, tags: ['plan', 'completed'] }).catch(() => {});
        } else {
          void c1.sessionStart({ task: 'Plan completed: ' + p.title + ' ' + summary, agent: p.steps[0]?.agent || 'codex', projectPath: this.projectPath }).catch(() => {});
        }
      }

      // Update orchestrator state to reflect current step
      if (planEvent.type === 'plan.step.starting' && planEvent.step) {
        this.state = {
          ...this.state,
          activeAgent: planEvent.step.agent,
          route: plan.route,
          autonomy: plan.autonomy,
          activeTaskId: planEvent.step.id,
          isRunning: true,
        };
        this.emitState();
      } else if (planEvent.type === 'plan.completed' || planEvent.type === 'plan.aborted') {
        this.state = { ...this.state, isRunning: false };
        this.planRunning = false;
        this.emitState();
      }
    });

    try {
      await this.planRunner.execute();
    } finally {
      this.planRunning = false;
      this.state = { ...this.state, isRunning: false };
      this.emitState();
    }
  }

  async pausePlan(): Promise<void> {
    this.planRunner?.pause();
  }

  async resumePlan(): Promise<void> {
    this.planRunner?.resume();
  }

  async abortPlan(): Promise<void> {
    if (this.planRunner) {
      await this.planRunner.abort();
      this.planRunning = false;
      this.state = { ...this.state, isRunning: false };
      this.emitState();
    }
  }

  async retryPlanStep(stepId: string, newPrompt?: string): Promise<void> {
    this.planRunner?.retryStep(stepId, newPrompt);
  }

  async skipPlanStep(stepId: string): Promise<void> {
    this.planRunner?.skipStep(stepId);
  }

  // ─── Agent control ─────────────────────────────────────────────

  setAgent(agent: AgentId): void {
    this.state = { ...this.state, activeAgent: agent };
    this.emitState();
  }

  setRoute(route: RouteMode): void {
    const from = this.state.route;
    this.state = { ...this.state, route };
    this.emitState();
    if (this.state.activeTaskId && from !== route) {
      this.emitEvent({ id: createEventId(), type: 'route.changed', taskId: this.state.activeTaskId, timestamp: nowIso(), agent: this.state.activeAgent, from, to: route });
    }
  }

  setAutonomy(autonomy: AutonomyMode): void {
    const from = this.state.autonomy;
    this.state = { ...this.state, autonomy };
    this.emitState();
    if (this.state.activeTaskId && from !== autonomy) {
      this.emitEvent({ id: createEventId(), type: 'autonomy.changed', taskId: this.state.activeTaskId, timestamp: nowIso(), agent: this.state.activeAgent, from, to: autonomy });
    }
  }

  approveDiff(eventId: string): Promise<void> { return this.resolveDiff(eventId, 'approved'); }
  rejectDiff(eventId: string): void { this.resolveDiffReject(eventId); }

  async startTask(request: TaskRequest): Promise<string> {
    if (this.state.isRunning) throw new Error('KAI already has an active agent run.');
    if (this.planRunning) throw new Error('A plan is currently executing. Abort the plan first.');
    const agent = request.agent ?? this.state.activeAgent;
    const route = request.route ?? this.state.route;
    const autonomy = request.autonomy ?? this.state.autonomy;
    this.lastPrompt = request.prompt;
    return this.runAgent(agent, route, autonomy, request.prompt);
  }

  async handoff(toAgent: AgentId): Promise<void> {
    if (!this.state.activeTaskId || !this.lastPrompt) throw new Error('No active task to hand off.');
    if (this.handoffInProgress) throw new Error('Handoff already in progress.');
    const fromAgent = this.state.activeAgent;
    if (fromAgent === toAgent) throw new Error(`Already using ${toAgent}.`);

    this.handoffInProgress = true;
    const currentAdapter = this.adapters.get(fromAgent);
    await currentAdapter?.stop(this.state.activeTaskId);

    this.emitEvent({ id: createEventId(), type: 'agent.lifecycle', taskId: this.state.activeTaskId, timestamp: nowIso(), agent: fromAgent, status: 'paused', detail: `Handing off from ${fromAgent} to ${toAgent}.` });

    const handoffSummary = await this.cognitive1.handoff({ fromAgent, toAgent, summary: `Task: ${this.lastPrompt}. Handoff from ${fromAgent} to ${toAgent}.`, projectPath: this.projectPath });
    this.emitEvent({ id: createEventId(), type: 'memory.event', taskId: this.state.activeTaskId, timestamp: nowIso(), agent: toAgent, action: 'handoff', summary: handoffSummary });

    const handoffPrompt = `[HANDOFF from ${fromAgent}]\nContinuing task: ${this.lastPrompt}\n\nPick up where ${fromAgent} left off.`;
    this.state = { ...this.state, activeAgent: toAgent, isRunning: true };
    this.emitState();

    try { await this.runAgentStream(toAgent, this.state.route, this.state.autonomy, handoffPrompt); }
    finally { this.handoffInProgress = false; this.state = { ...this.state, isRunning: false, activeAgent: toAgent }; this.emitState(); }
  }

  async stopActiveTask(): Promise<void> {
    // Abort any running plan first
    if (this.planRunning && this.planRunner) {
      await this.planRunner.abort();
      this.planRunning = false;
    }

    if (!this.state.activeTaskId) return;
    const adapter = this.adapters.get(this.state.activeAgent);
    await adapter?.stop(this.state.activeTaskId);
    this.state = { ...this.state, isRunning: false };
    this.emitState();
  }

  // Permission check — gates risky operations based on autonomy mode
  checkPermission(permission: PermissionKey): { allowed: boolean; escalated: boolean } {
    const profile = createPermissionProfile(this.state.autonomy);
    const allowed = canRunWithoutApproval(profile, permission);
    return { allowed, escalated: !allowed };
  }

  // Auto Mode: automatically approve diffs for safe operations
  private async autoApproveDiff(event: DiffProposalEvent): Promise<void> {
    const perm = this.checkPermission('workspaceEdit');
    if (perm.allowed) {
      if (event.diff) {
        const result = await this.diffApplier.applyDiff(event.filePath, event.diff);
        this.emitEvent({ id: createEventId(), type: 'file.edit.applied', taskId: event.taskId, timestamp: nowIso(), agent: event.agent, filePath: event.filePath, summary: `[Auto] ${result.detail}` });
      }
    } else {
      // Review mode: diff stays pending for manual approval
      this.pendingDiffs.set(event.id, { event, status: 'pending' });
    }
  }

  private async resolveDiff(eventId: string, status: 'approved'): Promise<void> {
    const record = this.pendingDiffs.get(eventId);
    if (!record || record.status !== 'pending') throw new Error(`No pending diff found for ${eventId}.`);

    const { event } = record;
    if (event.diff) {
      const result = await this.diffApplier.applyDiff(event.filePath, event.diff);
      record.status = 'approved';
      this.emitEvent({ id: createEventId(), type: 'file.edit.applied', taskId: event.taskId, timestamp: nowIso(), agent: event.agent, filePath: event.filePath, summary: result.detail });
    } else {
      record.status = 'approved';
      this.emitEvent({ id: createEventId(), type: 'agent.lifecycle', taskId: event.taskId, timestamp: nowIso(), agent: event.agent, status: 'running', detail: `Diff for ${event.filePath} acknowledged.` });
    }
  }

  private resolveDiffReject(eventId: string): void {
    const record = this.pendingDiffs.get(eventId);
    if (!record || record.status !== 'pending') throw new Error(`No pending diff found for ${eventId}.`);
    record.status = 'rejected';
    this.emitEvent({ id: createEventId(), type: 'agent.lifecycle', taskId: record.event.taskId, timestamp: nowIso(), agent: record.event.agent, status: 'running', detail: `Diff for ${record.event.filePath} was rejected.` });
  }

  private async runAgent(agent: AgentId, route: RouteMode, autonomy: AutonomyMode, prompt: string): Promise<string> {
    const adapter = this.adapters.get(agent);
    if (!adapter) throw new Error(`No adapter registered for ${agent}.`);

    const taskId = `task_${Date.now()}`;
    this.state = { activeAgent: agent, route, autonomy, activeTaskId: taskId, isRunning: true };
    this.emitState();

    const ss = await this.cognitive1.sessionStart({ task: prompt, agent, projectPath: this.projectPath });
    this.emitEvent({ id: createEventId(), type: 'memory.event', taskId, timestamp: nowIso(), agent, action: 'session_start', summary: ss });
    const rs = await this.cognitive1.recall({ query: prompt });
    this.emitEvent({ id: createEventId(), type: 'memory.event', taskId, timestamp: nowIso(), agent, action: 'recall', summary: rs });

    await this.runAgentStream(agent, route, autonomy, prompt);
    return taskId;
  }

  private async runAgentStream(agent: AgentId, route: RouteMode, autonomy: AutonomyMode, prompt: string): Promise<void> {
    const adapter = this.adapters.get(agent);
    if (!adapter) throw new Error(`No adapter registered for ${agent}.`);
    const taskId = this.state.activeTaskId!;

    try {
      for await (const event of adapter.run({ taskId, prompt, route, autonomy, cwd: this.projectPath })) {
        if (event.type === 'diff.proposal') {
          void this.autoApproveDiff(event);
        }
        this.emitEvent(event);
      }
    } finally {
      if (!this.handoffInProgress) {
        this.state = { ...this.state, isRunning: false };
        this.emitState();
      }
    }
  }

  private emitState(): void { this.emit('state', this.getState()); }
  private emitEvent(event: WorkbenchEvent): void { this.emit('event', event); }
}
