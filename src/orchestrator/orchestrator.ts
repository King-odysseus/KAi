import { EventEmitter } from 'events';
import type { Cognitive1Client } from '../cognitive1/cognitive1-client';
import { DisabledCognitive1Client } from '../cognitive1/cognitive1-client';
import { createEventId, nowIso, type ApprovalRequestEvent, type DiffProposalEvent, type WorkbenchEvent } from '../core/events';
import type { AgentCapability, AgentId, AutonomyMode, PermissionKey, RouteMode, TaskRequest, WorkbenchState } from '../core/types';
import { canRunWithoutApproval, createPermissionProfile } from '../core/permissions';
import type { DiffApplier } from './diff-applier';
import { NoopDiffApplier } from './diff-applier';
import type { AgentAdapter, ApprovalResponse } from '../adapters/agent-adapter';
import type { Plan } from '../core/plan';
import { PlanRunner } from './plan-runner';
import type { Checkpoint } from './checkpoints';
import { createCheckpoint, diffFromCheckpoint, gitDiffStat, isGitRepo, restoreCheckpoint, restoreFile as restoreOneFile, readFileAtCheckpoint } from './checkpoints';

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
  private customPermissions: Partial<Record<PermissionKey, boolean>> = {};
  /** One checkpoint per taskId, captured right before that task's first
   * agent run. Kept for the life of the session so Review/Undo/Rewind work
   * even well after the turn finished. */
  private readonly checkpoints = new Map<string, Checkpoint>();
  /** Approval events currently awaiting a response, keyed by event id, so
   * respondToApproval() knows which adapter/taskId to feed the answer back
   * into. */
  private readonly pendingApprovals = new Map<string, ApprovalRequestEvent>();
  /** "Always allow" rules the user has set, keyed by `${agent}:${title}`. */
  private alwaysAllowRules = new Set<string>();
  /** Native session/thread id per agent for the CURRENT conversation, so a
   * follow-up to the same agent continues its session (claude --resume,
   * codex exec resume) instead of starting fresh each message. Cleared by
   * startNewConversation(). */
  private readonly agentSessions = new Map<AgentId, string>();
  /** Accumulated assistant text for the current task — used to build a real
   * handoff summary instead of just re-sending the original prompt. */
  private lastReplyText = '';

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
            supportsAutonomy: ['plan', 'ask', 'autoEdit', 'full', 'custom'],
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

  /** Runs a one-off recall for the composer's "Search memory" context chip —
   * does not log a session/task, unlike the recall run automatically at the
   * start of every task. */
  async searchMemory(query: string): Promise<string> {
    return this.cognitive1.recall({ query, project: this.projectPath });
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

  // ─── Agent comparison ─────────────────────────────────────────

  async compareTask(prompt: string, agentA: AgentId, agentB: AgentId): Promise<string> {
    if (this.state.isRunning || this.planRunning) {
      throw new Error("KAI already has an active run. Stop it before comparing.");
    }
    if (!this.adapters.has(agentA)) throw new Error(`No adapter for ${agentA}`);
    if (!this.adapters.has(agentB)) throw new Error(`No adapter for ${agentB}`);

    const compareId = "compare_" + Date.now();
    const route = this.state.route;
    const autonomy = this.state.autonomy;

    this.state = { ...this.state, activeAgent: (agentA + " vs " + agentB) as AgentId, activeTaskId: compareId, isRunning: true };
    this.emitState();

    void this.cognitive1.sessionStart({ task: prompt, agent: agentA + "+" + agentB, projectPath: this.projectPath }).catch(() => {});
    void this.cognitive1.recall({ query: prompt }).catch(() => {});

    this.emitEvent({ id: createEventId("cmp"), type: "agent.lifecycle", taskId: compareId, timestamp: nowIso(), agent: agentA + " vs " + agentB as AgentId, status: "starting", detail: "Comparing " + agentA + " vs " + agentB });

    const runSide = async (agent: AgentId, side: "left" | "right") => {
      const taskId = compareId + "_" + side;
      const adapter = this.adapters.get(agent)!;
      try {
        for await (const event of adapter.run({ taskId, prompt, route, autonomy, cwd: this.projectPath })) {
          (event as any).compareId = compareId;
          (event as any).side = side;
          if (event.type === "diff.proposal") void this.autoApproveDiff(event);
          this.emitEvent(event);
        }
        return { side, taskId, ok: true };
      } catch (err) {
        return { side, taskId, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    };

    const [left, right] = await Promise.all([runSide(agentA, "left"), runSide(agentB, "right")]);

    this.emitEvent({
      id: createEventId("cmp"), type: "raw.fallback", taskId: compareId, timestamp: nowIso(),
      agent: (agentA + " vs " + agentB) as AgentId, sourceType: "compare.complete",
      payload: { compareId, left: { agent: agentA, taskId: left.taskId, ok: left.ok, error: (left as any).error }, right: { agent: agentB, taskId: right.taskId, ok: right.ok, error: (right as any).error } },
    });

    this.state = { ...this.state, isRunning: false };
    this.emitState();
    return compareId;
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
    void this.emitTurnChanges(this.state.activeTaskId, fromAgent);

    const handoffSummary = await this.cognitive1.handoff({ fromAgent, toAgent, summary: `Task: ${this.lastPrompt}. Handoff from ${fromAgent} to ${toAgent}.`, projectPath: this.projectPath });
    this.emitEvent({ id: createEventId(), type: 'memory.event', taskId: this.state.activeTaskId, timestamp: nowIso(), agent: toAgent, action: 'handoff', summary: handoffSummary });

    const replyExcerpt = this.lastReplyText.trim().slice(0, 2000);
    const diffStat = this.projectPath ? await gitDiffStat(this.projectPath) : '';
    const handoffPrompt = [
      `[HANDOFF from ${fromAgent}]`,
      `Original task: ${this.lastPrompt}`,
      replyExcerpt ? `\n${fromAgent}'s last reply:\n${replyExcerpt}` : '',
      diffStat ? `\nFiles changed so far:\n${diffStat}` : '',
      `\nPick up where ${fromAgent} left off.`,
    ].filter(Boolean).join('\n');
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

  /** Sets the Custom-mode permission profile. Persisted per-workspace by the
   * caller (see extension.ts); has no effect unless autonomy is 'custom'. */
  setCustomPermissions(allowed: Partial<Record<PermissionKey, boolean>>): void {
    this.customPermissions = { ...allowed };
  }

  getCustomPermissions(): Partial<Record<PermissionKey, boolean>> {
    return { ...this.customPermissions };
  }

  /** Starts a fresh conversation: no agent resumes its previous session
   * until it runs again. Call when the user clicks "New chat". */
  startNewConversation(): void {
    this.agentSessions.clear();
  }

  getAgentSessionId(agent: AgentId): string | undefined {
    return this.agentSessions.get(agent);
  }

  // ─── Checkpoints (diff summary, review, undo, rewind) ──────────

  getCheckpoint(taskId: string): Checkpoint | undefined {
    return this.checkpoints.get(taskId);
  }

  /** Restores the working tree to a task's checkpoint — used by both
   * "Undo all" on the diff summary card and "Rewind code to here" on a
   * user message. Same operation; the UI just triggers it from two places. */
  async restoreToCheckpoint(taskId: string): Promise<{ restored: string[]; deleted: string[] }> {
    const checkpoint = this.checkpoints.get(taskId);
    if (!checkpoint) throw new Error('No checkpoint recorded for this task.');
    if (!this.projectPath) throw new Error('No workspace folder open.');
    return restoreCheckpoint(this.projectPath, checkpoint);
  }

  /** Restores one file from a task's checkpoint — "Reject" in the diff
   * editor for a single changed file. */
  async restoreOneFileFromCheckpoint(taskId: string, filePath: string): Promise<void> {
    const checkpoint = this.checkpoints.get(taskId);
    if (!checkpoint) throw new Error('No checkpoint recorded for this task.');
    if (!this.projectPath) throw new Error('No workspace folder open.');
    await restoreOneFile(this.projectPath, checkpoint, filePath);
  }

  /** Reads a file's content as of a task's checkpoint — backs the diff
   * editor's "before" side via the kai-checkpoint: content provider. */
  async readCheckpointFile(taskId: string, filePath: string): Promise<string> {
    const checkpoint = this.checkpoints.get(taskId);
    if (!checkpoint) throw new Error('No checkpoint recorded for this task.');
    if (!this.projectPath) throw new Error('No workspace folder open.');
    return readFileAtCheckpoint(this.projectPath, checkpoint, filePath);
  }

  private async ensureCheckpoint(taskId: string): Promise<void> {
    if (this.checkpoints.has(taskId) || !this.projectPath) return;
    try {
      if (!(await isGitRepo(this.projectPath))) return;
      this.checkpoints.set(taskId, await createCheckpoint(this.projectPath));
    } catch {
      // Best effort — a checkpoint failure must never block a run.
    }
  }

  /** Diffs the task's checkpoint against the current working tree and, if
   * anything changed, emits a turn.changes event for the diff summary card.
   * Safe to call more than once per task (e.g. once per handoff pause, once
   * at final completion) — each call reflects everything changed so far. */
  private async emitTurnChanges(taskId: string, agent: AgentId): Promise<void> {
    const checkpoint = this.checkpoints.get(taskId);
    if (!checkpoint || !this.projectPath) return;
    try {
      const files = await diffFromCheckpoint(this.projectPath, checkpoint);
      if (files.length === 0) return;
      this.emitEvent({ id: createEventId(), type: 'turn.changes', taskId, timestamp: nowIso(), agent, files, hasCheckpoint: true });
    } catch {
      // Best effort — never fail a run over the diff summary.
    }
  }

  // ─── Approvals ──────────────────────────────────────────────────

  private ruleKey(event: ApprovalRequestEvent): string {
    return `${event.agent ?? ''}:${event.title}`;
  }

  /** Loads persisted "always allow" rules (see extension.ts, which persists
   * them per workspace) — replaces the current set. */
  setAlwaysAllowRules(rules: string[]): void {
    this.alwaysAllowRules = new Set(rules);
  }

  getAlwaysAllowRules(): string[] {
    return [...this.alwaysAllowRules];
  }

  /**
   * Answers a pending approval.request. Records the decision and, when the
   * originating adapter implements respondToApproval, feeds it back into
   * the live run. Most adapters can't do that today (see AgentAdapter's
   * respondToApproval doc) — the response is still recorded either way so
   * the card resolves and an 'always' rule takes effect for future requests
   * this session.
   */
  async respondToApproval(eventId: string, response: ApprovalResponse): Promise<void> {
    const event = this.pendingApprovals.get(eventId);
    if (!event) throw new Error(`No pending approval found for ${eventId}.`);
    this.pendingApprovals.delete(eventId);

    if (response === 'always') this.alwaysAllowRules.add(this.ruleKey(event));
    this.emit('approvalRuleChanged', this.getAlwaysAllowRules());

    const adapter = event.agent ? this.adapters.get(event.agent) : undefined;
    await adapter?.respondToApproval?.(event.taskId, eventId, response);

    this.emitEvent({
      id: createEventId(), type: 'agent.lifecycle', taskId: event.taskId, timestamp: nowIso(), agent: event.agent,
      status: 'running',
      detail: response === 'deny' ? `Denied: ${event.title}` : `Approved${response === 'always' ? ' (always)' : ''}: ${event.title}`,
    });
  }

  /** Tracks an approval.request as it streams by, and auto-resolves it
   * (as 'once', silently) if an "always allow" rule already covers it. */
  private trackApproval(event: ApprovalRequestEvent): void {
    if (this.alwaysAllowRules.has(this.ruleKey(event))) {
      void this.respondToApprovalSilently(event);
      return;
    }
    this.pendingApprovals.set(event.id, event);
  }

  private async respondToApprovalSilently(event: ApprovalRequestEvent): Promise<void> {
    const adapter = event.agent ? this.adapters.get(event.agent) : undefined;
    try {
      await adapter?.respondToApproval?.(event.taskId, event.id, 'once');
    } catch {
      // Best effort — an always-allow auto-response must never crash a run.
    }
  }

  // Permission check — gates risky operations based on autonomy mode
  checkPermission(permission: PermissionKey): { allowed: boolean; escalated: boolean } {
    const profile = createPermissionProfile(this.state.autonomy, this.customPermissions);
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
    await this.ensureCheckpoint(taskId);
    this.lastReplyText = '';

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
    const resumeSessionId = this.agentSessions.get(agent);
    const customAllowed = this.state.autonomy === 'custom' ? this.customPermissions : undefined;

    try {
      for await (const event of adapter.run({ taskId, prompt, route, autonomy, cwd: this.projectPath, resumeSessionId, customAllowed })) {
        if (event.type === 'diff.proposal') {
          void this.autoApproveDiff(event);
        }
        if (event.type === 'approval.request') {
          this.trackApproval(event);
        }
        if (event.type === 'cost.update' && event.sessionId) {
          this.agentSessions.set(agent, event.sessionId);
        }
        if (event.type === 'text.delta' && event.channel === 'assistant') {
          this.lastReplyText += event.text;
        }
        this.emitEvent(event);
        if (event.type === 'agent.lifecycle' && (event.status === 'completed' || event.status === 'failed' || event.status === 'paused')) {
          void this.emitTurnChanges(taskId, agent);
        }
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
