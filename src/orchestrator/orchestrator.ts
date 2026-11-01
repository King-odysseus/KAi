import { EventEmitter } from 'events';
import type { Cognitive1Client } from '../cognitive1/cognitive1-client';
import { DisabledCognitive1Client } from '../cognitive1/cognitive1-client';
import { buildExecutionRulesBriefing, type CognitiveRuleStore, type KaiRuleDocument, type KaiRuleInput } from '../cognitive1/rule-store';
import { createEventId, nowIso, type ApprovalRequestEvent, type DiffProposalEvent, type WorkbenchEvent } from '../core/events';
import type { AgentCapability, AgentId, AutonomyMode, PermissionKey, RouteMode, TaskRequest, WorkbenchState } from '../core/types';
import { canRunWithoutApproval, createPermissionProfile } from '../core/permissions';
import type { DiffApplier } from './diff-applier';
import { NoopDiffApplier } from './diff-applier';
import type { AgentAdapter, ApprovalResponse } from '../adapters/agent-adapter';
import { buildConversationBriefing, buildMemoryBriefing, type ConversationTurn } from '../core/prompt-builder';
import {
  buildGoalPrompt,
  completeGoal as markGoalComplete,
  createGoal,
  pauseGoal as markGoalPaused,
  resumeGoal as markGoalResumed,
  updateGoal as editGoal,
  type GoalInput,
  type WorkbenchGoal,
} from '../core/goal';
import type { Plan } from '../core/plan';
import { PlanRunner } from './plan-runner';
import type { Checkpoint } from './checkpoints';
import { createCheckpoint, diffFromCheckpoint, gitDiffStat, isGitRepo, restoreCheckpoint, restoreFile as restoreOneFile, readFileAtCheckpoint } from './checkpoints';
import { createCompareWorktree, removeCompareWorktree, worktreeChanges, worktreeDiffPatch, applyWorktreePatch } from './worktrees';

export interface DiffRecord {
  event: DiffProposalEvent;
  status: 'pending' | 'approved' | 'rejected';
}

/** Native agent session metadata persisted with a conversation. The route
 * and workspace are part of the key because a session created through one
 * provider (or in a different checkout) must not be resumed through another. */
export interface AgentSessionRecord {
  sessionId: string;
  route: RouteMode;
  projectPath?: string;
}

export class WorkbenchOrchestrator extends EventEmitter {
  private state: WorkbenchState;
  private readonly adapters = new Map<AgentId, AgentAdapter>();
  private readonly pendingDiffs = new Map<string, DiffRecord>();
  private lastPrompt: string = '';
  private handoffInProgress = false;
  private planRunner: PlanRunner | null = null;
  private planRunning = false;
  /** Durable goal state for the current conversation. Goals span turns until
   * the user clears or completes them. */
  private goal: WorkbenchGoal | null = null;
  private customPermissions: Partial<Record<PermissionKey, boolean>> = {};
  /** One checkpoint per taskId, captured right before that task's first
   * agent run. Kept for the life of the session so Review/Undo/Rewind work
   * even well after the turn finished. */
  private readonly checkpoints = new Map<string, Checkpoint>();
  /** Approval events currently awaiting a response, keyed by event id, so
   * respondToApproval() knows which adapter/taskId to feed the answer back
   * into. */
  private readonly pendingApprovals = new Map<string, ApprovalRequestEvent>();
  /** File edits reported directly by an agent stream for the current task,
   * used to produce a changed-files summary when checkpoint diffing is
   * unavailable (for example outside git). */
  private readonly observedFileChanges = new Map<string, Map<string, { path: string; added: number; removed: number }>>();
  /** "Always allow" rules the user has set, keyed by `${agent}:${title}`. */
  private alwaysAllowRules = new Set<string>();
  /** Native session/thread id per agent for the CURRENT conversation, so a
   * follow-up to the same agent continues its session (claude --resume,
   * codex exec resume) instead of starting fresh each message. Cleared by
   * startNewConversation(). */
  private readonly agentSessions = new Map<AgentId, AgentSessionRecord>();
  /** Accumulated assistant text for the current task — used to build a real
   * handoff summary instead of just re-sending the original prompt. */
  private lastReplyText = '';
  /** User/assistant transcript for the current conversation. Agents with a
   * native resumable session already have this context; a provider that was
   * just selected for the first time gets it as a prompt briefing instead. */
  private readonly conversationTurns: ConversationTurn[] = [];
  /** Active compare runs, keyed by compareId, so pickCompareWinner/
   * removeCompareSides know which worktrees to apply from and clean up. */
  private readonly compareRuns = new Map<string, { agentA: AgentId; agentB: AgentId; worktreeLeft: string; worktreeRight: string }>();

  constructor(
    initialState: WorkbenchState,
    private readonly cognitive1: Cognitive1Client = new DisabledCognitive1Client(),
    private readonly projectPath?: string,
    private readonly diffApplier: DiffApplier = new NoopDiffApplier(),
    private readonly ruleStore?: CognitiveRuleStore,
  ) {
    super();
    this.state = { ...initialState };
  }

  /** Where the short "how this developer builds" list comes from. Every agent run is given it, so it is set once. */
  setConventionsProvider(provider: () => string): void {
    this.conventionsProvider = provider;
  }

  private conventionsProvider: () => string = () => '';

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

  async getRuleDocument(): Promise<KaiRuleDocument> {
    if (!this.ruleStore) throw new Error('Cognitive1 execution rules are not configured.');
    return this.ruleStore.read();
  }

  async saveRule(input: KaiRuleInput): Promise<KaiRuleDocument> {
    if (!this.ruleStore) throw new Error('Cognitive1 execution rules are not configured.');
    return this.ruleStore.save(input);
  }

  /** Runs a one-off recall for the composer's "Search memory" context chip —
   * does not log a session/task, unlike the recall run automatically at the
   * start of every task. */
  async searchMemory(query: string): Promise<string> {
    return this.cognitive1.recall({ query, project: this.projectPath });
  }

  getState(): WorkbenchState { return { ...this.state }; }
  getLastPrompt(): string { return this.lastPrompt; }

  getGoal(): WorkbenchGoal | null { return this.goal ? { ...this.goal } : null; }

  /** Creates or edits the current goal without starting an agent run. */
  setGoal(input: GoalInput): WorkbenchGoal {
    this.goal = this.goal ? editGoal(this.goal, input) : createGoal(input);
    this.emitState();
    return { ...this.goal };
  }

  /** Restores persisted goal state when loading a conversation. */
  restoreGoal(goal: WorkbenchGoal | null): void {
    this.goal = goal ? { ...goal } : null;
    this.emitState();
  }

  async clearGoal(): Promise<void> {
    if (!this.goal) return;
    this.goal = null;
    this.emitState();
    if (this.state.isRunning || this.planRunning) await this.stopActiveTask();
  }

  async pauseGoal(): Promise<void> {
    if (!this.goal || this.goal.status !== 'running') return;
    this.goal = markGoalPaused(this.goal);
    this.emitState();
    if (this.state.isRunning || this.planRunning) await this.stopActiveTask();
  }

  async resumeGoal(): Promise<void> {
    if (!this.goal || this.goal.status !== 'paused') return;
    this.goal = markGoalResumed(this.goal);
    this.emitState();
    if (this.state.isRunning || this.planRunning) return;
    const prompt = buildGoalPrompt(this.goal);
    this.lastPrompt = this.goal.outcome;
    await this.runAgent(this.state.activeAgent, this.state.route, this.state.autonomy, prompt);
  }

  async completeGoal(): Promise<void> {
    if (!this.goal || this.goal.status === 'completed') return;
    this.goal = markGoalComplete(this.goal);
    this.emitState();
    if (this.state.isRunning || this.planRunning) await this.stopActiveTask();
  }

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
      await this.getExecutionRulesBriefing(),
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

  /**
   * Runs two agents on the same prompt side by side. Each runs in its own
   * git worktree (never the real workspace) so neither can see or overwrite
   * the other's edits, and nothing touches the user's actual files until
   * they pick a winner with pickCompareWinner(). Requires a git repo.
   */
  async compareTask(prompt: string, agentA: AgentId, agentB: AgentId): Promise<string> {
    if (this.state.isRunning || this.planRunning) {
      throw new Error("KAI already has an active run. Stop it before comparing.");
    }
    if (!this.adapters.has(agentA)) throw new Error(`No adapter for ${agentA}`);
    if (!this.adapters.has(agentB)) throw new Error(`No adapter for ${agentB}`);
    if (!this.projectPath) throw new Error('Compare needs an open workspace folder.');
    if (!(await isGitRepo(this.projectPath))) throw new Error('Compare needs a git repository (each side runs in its own worktree).');

    const compareId = "compare_" + Date.now();
    const route = this.state.route;
    const autonomy = this.state.autonomy;

    this.state = { ...this.state, activeAgent: (agentA + " vs " + agentB) as AgentId, activeTaskId: compareId, isRunning: true };
    this.emitState();

    void this.cognitive1.sessionStart({ task: prompt, agent: agentA + "+" + agentB, projectPath: this.projectPath }).catch(() => {});
    void this.cognitive1.recall({ query: prompt }).catch(() => {});

    const comparisonPrompt = [await this.getExecutionRulesBriefing(), prompt].filter(Boolean).join('\n\n');

    this.emitEvent({
      id: createEventId("cmp"), type: "agent.lifecycle", taskId: compareId, timestamp: nowIso(),
      agent: agentA + " vs " + agentB as AgentId, status: "starting",
      detail: "Comparing " + agentA + " vs " + agentB + " in separate worktrees",
      compareAgents: [agentA, agentB],
    } as WorkbenchEvent & { compareAgents: AgentId[] });

    const [worktreeLeft, worktreeRight] = await Promise.all([
      createCompareWorktree(this.projectPath, `${compareId}-left`),
      createCompareWorktree(this.projectPath, `${compareId}-right`),
    ]);
    this.compareRuns.set(compareId, { agentA, agentB, worktreeLeft, worktreeRight });

    const runSide = async (agent: AgentId, side: "left" | "right", cwd: string) => {
      const taskId = compareId + "_" + side;
      const adapter = this.adapters.get(agent)!;
      const startedAt = Date.now();
      try {
        for await (const event of adapter.run({ taskId, prompt: comparisonPrompt, route, autonomy, cwd })) {
          (event as WorkbenchEvent & { compareId?: string; side?: string }).compareId = compareId;
          (event as WorkbenchEvent & { compareId?: string; side?: string }).side = side;
          // Never auto-apply diffs here — each side's edits stay inside its
          // own worktree until the user picks a winner.
          this.emitEvent(event);
        }
        return { side, taskId, ok: true, elapsedMs: Date.now() - startedAt };
      } catch (err) {
        return { side, taskId, ok: false, error: err instanceof Error ? err.message : String(err), elapsedMs: Date.now() - startedAt };
      }
    };

    const [left, right] = await Promise.all([
      runSide(agentA, "left", worktreeLeft),
      runSide(agentB, "right", worktreeRight),
    ]);

    const [leftFiles, rightFiles] = await Promise.all([
      worktreeChanges(worktreeLeft).catch(() => []),
      worktreeChanges(worktreeRight).catch(() => []),
    ]);

    this.emitEvent({
      id: createEventId("cmp"), type: "raw.fallback", taskId: compareId, timestamp: nowIso(),
      agent: (agentA + " vs " + agentB) as AgentId, sourceType: "compare.complete",
      payload: {
        compareId,
        left: { agent: agentA, taskId: left.taskId, ok: left.ok, error: left.ok ? undefined : left.error, elapsedMs: left.elapsedMs, files: leftFiles },
        right: { agent: agentB, taskId: right.taskId, ok: right.ok, error: right.ok ? undefined : right.error, elapsedMs: right.elapsedMs, files: rightFiles },
      },
    });

    this.state = { ...this.state, isRunning: false };
    this.emitState();
    return compareId;
  }

  /** Applies the winning side's changes onto the real workspace and
   * removes both worktrees. Throws if the patch doesn't apply cleanly
   * (e.g. the user edited the same files in the meantime) — the worktrees
   * are left in place in that case so nothing is lost. */
  async pickCompareWinner(compareId: string, side: 'left' | 'right'): Promise<void> {
    const run = this.compareRuns.get(compareId);
    if (!run) throw new Error('No active compare run found.');
    if (!this.projectPath) throw new Error('No workspace folder open.');
    const winnerPath = side === 'left' ? run.worktreeLeft : run.worktreeRight;
    const loserPath = side === 'left' ? run.worktreeRight : run.worktreeLeft;

    const patch = await worktreeDiffPatch(winnerPath);
    await applyWorktreePatch(this.projectPath, patch);

    await removeCompareWorktree(this.projectPath, winnerPath);
    await removeCompareWorktree(this.projectPath, loserPath);
    this.compareRuns.delete(compareId);
  }

  /** Discards both sides of a compare run without applying either. */
  async discardCompare(compareId: string): Promise<void> {
    const run = this.compareRuns.get(compareId);
    if (!run || !this.projectPath) return;
    await removeCompareWorktree(this.projectPath, run.worktreeLeft);
    await removeCompareWorktree(this.projectPath, run.worktreeRight);
    this.compareRuns.delete(compareId);
  }

  /** The worktree path for one side of an active compare run — used by
   * "Open worktree" (opens a new VS Code window there). */
  getCompareWorktreePath(compareId: string, side: 'left' | 'right'): string | undefined {
    const run = this.compareRuns.get(compareId);
    if (!run) return undefined;
    return side === 'left' ? run.worktreeLeft : run.worktreeRight;
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

  async retryPlanStep(stepId: string, newPrompt?: string, newAgent?: AgentId): Promise<void> {
    this.planRunner?.retryStep(stepId, newPrompt, newAgent);
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
    if (request.goal) {
      if (!this.goal || this.goal.status === 'completed') this.goal = createGoal(request.goal);
      else this.goal = editGoal(this.goal, request.goal);
      if (this.goal.status === 'paused') this.goal = markGoalResumed(this.goal);
      this.emitState();
    }
    const agent = request.agent ?? this.state.activeAgent;
    const route = request.route ?? this.state.route;
    const autonomy = request.autonomy ?? this.state.autonomy;
    this.lastPrompt = request.prompt;
    const prompt = this.goal && this.goal.status === 'running'
      ? buildGoalPrompt(this.goal, request.prompt)
      : request.prompt;
    const conversationBriefing = this.agentSessions.has(agent) ? '' : buildConversationBriefing(this.conversationTurns);
    this.conversationTurns.push({ role: 'user', text: request.prompt });
    return this.runAgent(agent, route, autonomy, prompt, conversationBriefing);
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
    this.conversationTurns.length = 0;
    this.goal = null;
    this.emitState();
  }

  getAgentSessionId(agent: AgentId): string | undefined {
    return this.agentSessions.get(agent)?.sessionId;
  }

  /** Snapshots the native session ids for persistence with a conversation. */
  getAgentSessions(): Partial<Record<AgentId, AgentSessionRecord>> {
    const sessions: Partial<Record<AgentId, AgentSessionRecord>> = {};
    for (const [agent, record] of this.agentSessions) {
      sessions[agent] = { ...record };
    }
    return sessions;
  }

  /** Restores persisted native session ids when reopening a conversation.
   * Records from a different route or workspace are ignored so KAI starts a
   * fresh native session instead of trying to resume an incompatible one. */
  restoreAgentSessions(sessions?: Partial<Record<AgentId, AgentSessionRecord>>): void {
    this.agentSessions.clear();
    if (!sessions) return;
    for (const agent of Object.keys(sessions) as AgentId[]) {
      const record = sessions[agent];
      if (!record?.sessionId) continue;
      if (record.route !== this.state.route) continue;
      if (record.projectPath !== this.projectPath) continue;
      this.agentSessions.set(agent, { ...record });
    }
  }

  /** Restores the in-memory transcript when reopening a saved conversation,
   * so switching to an agent without a native session still carries context. */
  restoreConversationTurns(turns: ConversationTurn[]): void {
    this.conversationTurns.length = 0;
    this.conversationTurns.push(...turns);
  }

  getConversationTurns(): ConversationTurn[] {
    return this.conversationTurns.map((turn) => ({ ...turn }));
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
    if (checkpoint && this.projectPath) {
      try {
        const files = await diffFromCheckpoint(this.projectPath, checkpoint);
        if (files.length > 0) {
          this.emitEvent({ id: createEventId(), type: 'turn.changes', taskId, timestamp: nowIso(), agent, files, hasCheckpoint: true });
          return;
        }
      } catch {
        // Fall through to the agent-reported changes below.
      }
    }

    const observed = [...(this.observedFileChanges.get(taskId)?.values() ?? [])];
    if (observed.length === 0) return;
    this.emitEvent({
      id: createEventId(), type: 'turn.changes', taskId, timestamp: nowIso(), agent,
      files: observed, hasCheckpoint: false,
    });
  }

  /** Records a file edit reported directly by an agent's stream. */
  private recordFileChange(event: Extract<WorkbenchEvent, { type: 'file.change' }>): void {
    let changes = this.observedFileChanges.get(event.taskId);
    if (!changes) {
      changes = new Map();
      this.observedFileChanges.set(event.taskId, changes);
    }
    const existing = changes.get(event.path) ?? { path: event.path, added: 0, removed: 0 };
    existing.added += event.added ?? 0;
    existing.removed += event.removed ?? 0;
    changes.set(event.path, existing);
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

  /** Saves a short pattern (task + reply excerpt + changed files) to
   * Cognitive1 after a turn finishes, so a later recall has something real
   * to find. `learn()` isn't part of the shared Cognitive1Client interface
   * (only EmbeddedCognitive1 has it) — same defensive cast plan-runner.ts
   * already uses for the same reason. */
  private async learnFromTurn(taskId: string, agent: AgentId): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
    const c1 = this.cognitive1 as any;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    if (typeof c1.learn !== 'function') return;
    try {
      // this.lastPrompt is the user's original task — never the
      // memory-briefing-augmented prompt actually sent to the agent
      // (runAgentStream's own `prompt` param), which would make the saved
      // pattern's title/description just echo the last recall back at itself.
      const task = this.lastPrompt;
      const replyExcerpt = this.lastReplyText.trim().slice(0, 500);
      const checkpoint = this.checkpoints.get(taskId);
      const files = checkpoint && this.projectPath ? await diffFromCheckpoint(this.projectPath, checkpoint).catch(() => []) : [];
      const description = [
        `Task: ${task.slice(0, 300)}`,
        replyExcerpt ? `Reply: ${replyExcerpt}` : '',
        files.length ? `Files: ${files.map((f) => f.path).join(', ')}` : '',
      ].filter(Boolean).join('\n');
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await c1.learn({ title: task.slice(0, 80), description, tags: [agent, 'turn'] });
    } catch {
      // Best effort — never fail a run over saving a memory.
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

  private async runAgent(
    agent: AgentId,
    route: RouteMode,
    autonomy: AutonomyMode,
    prompt: string,
    conversationBriefing = '',
  ): Promise<string> {
    const adapter = this.adapters.get(agent);
    if (!adapter) throw new Error(`No adapter registered for ${agent}.`);

    const taskId = `task_${Date.now()}`;
    this.state = { activeAgent: agent, route, autonomy, activeTaskId: taskId, isRunning: true };
    this.emitState();
    await this.ensureCheckpoint(taskId);
    this.observedFileChanges.delete(taskId);
    this.lastReplyText = '';

    const ss = await this.cognitive1.sessionStart({ task: prompt, agent, projectPath: this.projectPath });
    this.emitEvent({ id: createEventId(), type: 'memory.event', taskId, timestamp: nowIso(), agent, action: 'session_start', summary: ss });
    const rs = await this.cognitive1.recall({ query: prompt });
    this.emitEvent({ id: createEventId(), type: 'memory.event', taskId, timestamp: nowIso(), agent, action: 'recall', summary: rs });

    // Actually give the agent what was recalled — previously fetched but
    // never sent, so the "Used N memories" chip showed even though the
    // agent never saw a word of it.
    const briefing = buildMemoryBriefing(rs);
    const finalPrompt = [conversationBriefing, this.conventionsProvider(), briefing, prompt].filter(Boolean).join('\n\n');

    await this.runAgentStream(agent, route, autonomy, finalPrompt);
    return taskId;
  }

  private async runAgentStream(agent: AgentId, route: RouteMode, autonomy: AutonomyMode, prompt: string): Promise<void> {
    const adapter = this.adapters.get(agent);
    if (!adapter) throw new Error(`No adapter registered for ${agent}.`);
    const taskId = this.state.activeTaskId!;
    const resumeSessionId = this.agentSessions.get(agent)?.sessionId;
    const customAllowed = this.state.autonomy === 'custom' ? this.customPermissions : undefined;
    const finalPrompt = [await this.getExecutionRulesBriefing(), prompt].filter(Boolean).join('\n\n');

    try {
      for await (const event of adapter.run({ taskId, prompt: finalPrompt, route, autonomy, cwd: this.projectPath, resumeSessionId, customAllowed })) {
        if (event.type === 'diff.proposal') {
          void this.autoApproveDiff(event);
        }
        if (event.type === 'approval.request') {
          this.trackApproval(event);
        }
        if (event.type === 'cost.update' && event.sessionId) {
          this.agentSessions.set(agent, { sessionId: event.sessionId, route, projectPath: this.projectPath });
        }
        if (event.type === 'file.change') {
          this.recordFileChange(event);
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
      if (this.lastReplyText.trim()) {
        this.conversationTurns.push({ role: 'assistant', text: this.lastReplyText.trim() });
      }
      if (!this.handoffInProgress) {
        this.state = { ...this.state, isRunning: false };
        this.emitState();
        void this.learnFromTurn(taskId, agent);
      }
    }
  }

  private emitState(): void { this.emit('state', this.getState()); }
  private emitEvent(event: WorkbenchEvent): void { this.emit('event', event); }

  private async getExecutionRulesBriefing(): Promise<string> {
    if (!this.ruleStore) return '';
    try {
      const document = await this.ruleStore.read();
      return buildExecutionRulesBriefing(document.markdown);
    } catch (error) {
      this.emitEvent({
        id: createEventId(),
        type: 'error',
        taskId: this.state.activeTaskId ?? 'workbench',
        timestamp: nowIso(),
        message: `Cognitive1 execution rules could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
        recoverable: true,
      });
      return '';
    }
  }
}
