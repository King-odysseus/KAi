import { randomUUID } from 'node:crypto';
import { classifyWork, crewConfigSchema, crewRunSchema } from '@kai/contracts';
import type { AgentRunRequest, AgentRunResult, ConversationOrigin, CrewConfig, CrewDesign, CrewRole, CrewRun, CrewTask } from '@kai/contracts';
import {
  addChat, addCheckFix, addSpend, addTasks, continueToNextPhase, decideApproval, mergeChat, requestApprovals, answerAsk, enforceLimits, failBuild, failBuildSmart, helperChoiceFor, isFinished, parseReview, pickTasks, reviewTask,
  reassignReadOnlyTasks, resolveStuck, roleAccess, settle, startFollowUp, stuckTask, startTask, uniqueTaskIds, submitTask, subAgentsFor, taskBrief, unfinishedReason, guideCrewRun,
} from './crew-engine';
import { askPrompt, coveragePrompt, parseCoverage, parsePlanFull, parseStuckDecision, planPrompt, retryPrompt, reviewPrompt, reviewRolePrompt, stuckPrompt } from './crew-prompts';
import type { ParallelSession } from './parallel-session';

export interface CrewRunnerPorts {
  /** Opens a conversation for the crew's agents. `origin` marks it as the crew's, so the Workspace keeps it out of its tabs. */
  createConversation(projectId: string, title: string, origin?: ConversationOrigin): Promise<{ id: string }>;
  runAgent(request: AgentRunRequest, ownerWindowId: number, options?: { cwd?: string }): Promise<AgentRunResult>;
  cancelAgent(conversationId: string): boolean;
  runCheck(projectId: string, command: string, signal: AbortSignal, options?: { cwd?: string }): Promise<{ passed: boolean; output: string }>;
  save(run: CrewRun): Promise<void>;
  load(id: string): Promise<CrewRun | null>;
  list(projectId?: string): Promise<CrewRun[]>;
  /** Reads the Studio brief in this project, if one exists. */
  readBrief?(projectId: string): Promise<string | null>;
  notifyChanged(ownerWindowId: number, run: CrewRun): void;
  /** A few lines on how this developer usually builds things, for the goal. Optional: no conventions, no lines. */
  conventions?(projectId: string, goal: string): Promise<string>;
  /** Paths with uncommitted changes, so a task's files can be told apart from what was already changed. */
  changedFiles?(projectId: string): Promise<string[]>;
  /** Separate copies let independent builders work at once without sharing a writable tree. */
  worktrees?: { prepare(projectId: string, key: string): Promise<ParallelSession | null> };
  /** Open Pencil, through the one connection Studio already holds. Without it a Designer cannot draw. */
  design?: {
    status(): Promise<CrewDesign>;
    ensureRunning(): Promise<void>;
    /** One design turn with Open Pencil's tools, run in the project's folder. */
    draw(projectId: string, prompt: string, conversationId: string): Promise<{ status: 'completed' | 'failed'; output: string; error?: string; costUsd?: number }>;
  };
  now?(): Date;
}

/** What the runner needs from an agent run; a full AgentRunResult satisfies it, and a thrown error becomes one. */
type CallResult = Pick<AgentRunResult, 'status' | 'output'> & { error?: string; costUsd?: number; cancelled?: boolean };

export interface CrewStartInput {
  projectId: string;
  goal: string;
  config: CrewConfig;
  /** From the start interview: carry on through every phase. */
  keepGoing?: boolean;
  /** From the start interview: write for a developer who is not very technical. */
  explainSimply?: boolean;
}

/** The reviewer id the per-task project check is recorded under; it is not a role. */
const CHECK_REVIEWER = 'check';
/** What a Lead call is called in the conversation log, in place of the brief it was sent. */
const ASK_LABEL: Record<'plan' | 'review' | 'stuck' | 'coverage', string> = {
  plan: 'Plan the tasks',
  review: 'Review a task',
  stuck: 'Decide what to do with a stuck task',
  coverage: 'Check the goal against what was built',
};
/** The most phases a crew moves through by itself in one run, so a plan that never runs out still stops. */
const MAX_AUTO_PHASES = 12;

interface ActiveRun {
  ownerWindowId: number;
  conversationId: string;
  controller: AbortController;
  run: CrewRun;
  /** Whether the project's check already failed before the crew changed anything; then it cannot blame a task. */
  baselineFailing?: boolean;
  cancelled: boolean;
  done: Promise<void>;
  wave: number;
  serialRetryTasks: string[];
  /** Tasks the Lead has already been asked to unstick in this run; each gets one call. */
  leadDecided: Set<string>;
  /** How many times the crew has moved on to the next phase by itself in this run, so a loop always ends. */
  autoPhases: number;
  children: Set<string>;
}

/**
 * Drives a Crew run: the Lead writes the tasks, workers build independent tasks in isolated copies, the security role and the Lead check
 * each result, and a send-back goes to the builder that wrote it. The rules live in `crew-engine.ts`; this class only
 * starts agents and records what they said. Projects without Git worktree support fall back to one task at a time.
 */
export class DesktopCrewRunner {
  private readonly active = new Map<string, ActiveRun>();
  /** Questions to the Lead being answered right now, by run, so one can be stopped on its own. */
  private readonly asking = new Map<string, { conversationId: string; cancelled: boolean }>();
  /** What a builder said about the task it just finished, for the Lead's review of it. */
  private readonly builderReply = new Map<string, string>();
  /** What the per-task project check found, for the Lead's review of the same task. */
  private readonly checkNote = new Map<string, string>();

  constructor(private readonly ports: CrewRunnerPorts) {}

  private now(): Date {
    return this.ports.now?.() ?? new Date();
  }

  async start(input: CrewStartInput, ownerWindowId: number): Promise<CrewRun> {
    const at = this.now().toISOString();
    const runId = `crew_${randomUUID()}`;
    const conversation = await this.ports.createConversation(input.projectId, `Crew: ${input.goal.slice(0, 50)}`, { kind: 'crew', runId });
    const briefSnapshot = await this.ports.readBrief?.(input.projectId).catch(() => null) ?? null;
    const run = crewRunSchema.parse({
      schemaVersion: 1, id: runId, projectId: input.projectId, goal: input.goal, briefSnapshot, status: 'planning', conversationId: conversation.id,
      ...(input.keepGoing !== undefined ? { keepGoing: input.keepGoing } : {}), ...(input.explainSimply !== undefined ? { explainSimply: input.explainSimply } : {}),
      config: input.config, tasks: [], feed: [], startedAt: at, updatedAt: at,
    });
    const active = this.attach(run, ownerWindowId, conversation.id);
    await this.commit(active, run);
    active.done = this.drive(active);
    return active.run;
  }

  async list(projectId?: string): Promise<CrewRun[]> {
    const runs = await this.ports.list(projectId);
    // A run saved as running with nothing driving it was interrupted (the app closed): it is paused, not running.
    // Planning counts too: a crew closed while the Lead was still writing tasks has nothing driving it either.
    return runs.map((run) => ((run.status === 'running' || run.status === 'planning') && !this.active.has(run.id) ? { ...run, status: 'paused' as const } : run));
  }

  async get(runId: string): Promise<CrewRun | null> {
    return this.active.get(runId)?.run ?? (await this.list()).find((run) => run.id === runId) ?? null;
  }

  /** The user approved the plan. */
  async approve(runId: string, ownerWindowId: number): Promise<CrewRun> {
    const run = await this.require(runId);
    if (run.status !== 'awaitingApproval') throw new Error('This crew is not waiting for approval.');
    return this.resumeWith(run, ownerWindowId, { ...run, status: 'running' });
  }

  /** The user answered the question the run stopped on. */
  async answer(runId: string, answer: 'continue' | 'skip' | 'finish', guidance: string, ownerWindowId: number): Promise<CrewRun> {
    const run = await this.require(runId);
    if (!run.ask) {
      if (!guidance.trim() || answer !== 'continue') throw new Error('This crew is not waiting on a question.');
      if (run.status === 'completed' || run.status === 'stopped') throw new Error('This crew has finished.');
      const next = guideCrewRun(run, guidance, this.now().toISOString());
      const active = this.active.get(runId);
      if (active) {
        await this.commit(active, next);
        return active.run;
      }
      await this.ports.save(next);
      return next;
    }
    return this.resumeWith(run, ownerWindowId, answerAsk(run, answer, guidance, this.now().toISOString()));
  }

  /**
   * More work for a crew that has finished. The run goes back to planning with the request attached, and the Lead adds
   * tasks to the same board, so the roles, the accepted work and the spend carry on.
   */
  async followUp(runId: string, prompt: string, ownerWindowId: number): Promise<CrewRun> {
    const run = await this.require(runId);
    if (this.active.has(runId)) throw new Error('This crew is still working. Use Tell the Lead to steer it.');
    return this.resumeWith(run, ownerWindowId, startFollowUp(run, prompt, this.now().toISOString()));
  }

  /**
   * A message to the Lead from the Chat tab. Ask is answered from the board and the project and changes nothing; steer
   * changes what the crew does from the next task on; work plans more onto a finished board.
   */
  async message(runId: string, kind: 'ask' | 'steer' | 'work', text: string, ownerWindowId: number): Promise<CrewRun> {
    const run = await this.require(runId);
    const body = text.trim();
    if (!body) throw new Error('Write a message first.');
    const at = this.now().toISOString();
    const finished = run.status === 'completed' || run.status === 'stopped';
    if (kind === 'ask') return this.askLead(run, body, ownerWindowId);
    if (kind === 'work') {
      if (!finished) throw new Error('More work can be added once the crew has finished or been stopped. Use Steer to change what it is doing now.');
      return this.resumeWith(run, ownerWindowId, startFollowUp(addChat(run, { from: 'you', kind: 'work', text: body }, at), body, at));
    }
    // A finished crew has no next task to steer, so the note becomes what it plans next.
    if (finished) return this.resumeWith(run, ownerWindowId, startFollowUp(addChat(run, { from: 'you', kind: 'steer', text: body }, at), body, at));
    const steered = addChat(addChat(guideCrewRun(run, body, at), { from: 'you', kind: 'steer', text: body }, at), { from: 'lead', kind: 'note', text: 'Noted. The Lead will follow this from the next task on.' }, at);
    const active = this.active.get(runId);
    if (active) { await this.commit(active, steered); return active.run; }
    await this.ports.save(steered);
    return steered;
  }

  /**
   * New roles, agents, models or limits for a crew that already exists, for when an agent's subscription runs out or a
   * role needs a stronger model. They apply from the next task on, so the crew cannot be changed while it is working;
   * and a role that an unfinished task still uses cannot be taken away.
   */
  async updateConfig(runId: string, config: CrewConfig): Promise<CrewRun> {
    const run = await this.require(runId);
    if (run.status === 'running' || run.status === 'planning') throw new Error('Pause the crew first. A team change applies from its next task, not in the middle of one.');
    const parsed = crewConfigSchema.safeParse(config);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Check the crew settings.');
    const ids = new Set(parsed.data.roles.map((role) => role.id));
    const stranded = run.tasks.find((task) => !task.proposed && task.status !== 'accepted' && task.status !== 'skipped' && !ids.has(task.role));
    if (stranded) throw new Error(`"${stranded.title}" still needs the ${stranded.role} role, so it cannot be removed yet.`);
    const at = this.now().toISOString();
    const next = addChat({ ...run, config: parsed.data }, { from: 'lead', kind: 'note', text: 'The team was changed. The new roles apply from the next task.' }, at);
    const active = this.active.get(runId);
    if (active) { await this.commit(active, next); return active.run; }
    await this.ports.save(next);
    return next;
  }

  /** Records the person's yes or no on one approval card, then carries on once every card is answered. */
  async decide(runId: string, approvalId: string, approve: boolean, ownerWindowId: number): Promise<CrewRun> {
    const run = await this.require(runId);
    let next = decideApproval(run, approvalId, approve, this.now().toISOString());
    // A crew set to show its plan first still does, once the approvals are answered and nothing has been started.
    const untouched = next.tasks.every((task) => task.status === 'backlog' && task.reviews.length === 0);
    if (next.status === 'running' && run.status !== 'running' && next.config.approvePlan && untouched) next = { ...next, status: 'awaitingApproval' };
    return this.resumeWith(run, ownerWindowId, next);
  }

  /** Turns plain-language writing on or off for the Lead's replies. */
  async setExplainSimply(runId: string, explainSimply: boolean): Promise<CrewRun> {
    const run = await this.require(runId);
    const next = { ...run, explainSimply, updatedAt: this.now().toISOString() };
    const active = this.active.get(runId);
    if (active) { await this.commit(active, next); return active.run; }
    await this.ports.save(next);
    return next;
  }

  /**
   * Asks the Lead what is still undone in the plan. A crew that finished before the check existed has nothing stored, so
   * its phases could not be shown as buttons; this runs the same check on request, without changing the board.
   */
  async findPhases(runId: string, ownerWindowId: number): Promise<CrewRun> {
    const run = await this.require(runId);
    if (run.status === 'running' || run.status === 'planning') throw new Error('The crew is working. Ask again when it has paused or finished.');
    const lead = run.config.roles.find((role) => role.kind === 'lead');
    if (!lead) throw new Error('This crew has no Lead to ask.');
    const active = await this.localActive(run, ownerWindowId);
    const answer = await this.askJson(active, lead, coveragePrompt(active.run), 'coverage', parseCoverage);
    const at = this.now().toISOString();
    const paid: CrewRun = { ...active.run, spentUsd: active.run.spentUsd + answer.costUsd };
    const remaining = answer.value?.remaining ?? paid.remaining;
    const text = answer.value === null
      ? 'I could not tell what is left in the plan just now. Try again in a moment.'
      : remaining.length > 0
        ? `Still to do in the plan: ${remaining.join('; ')}.`
        : 'I found nothing left undone in the plan.';
    await this.commit(active, addChat({ ...paid, remaining }, { from: 'lead', kind: 'note', text }, at));
    return active.run;
  }

  /** Turns "keep going through every phase" on or off. Turning it on for a finished crew with work left starts the next phase. */
  async setKeepGoing(runId: string, keepGoing: boolean, ownerWindowId: number): Promise<CrewRun> {
    const run = await this.require(runId);
    const at = this.now().toISOString();
    const note = keepGoing
      ? 'Keep going is on. When a phase is finished the crew will plan the next one itself, and stop only for a security block, a limit, or a question only you can answer.'
      : 'Keep going is off. The crew will stop and say what is left when the planned tasks are finished.';
    const next = addChat({ ...run, keepGoing }, { from: 'lead', kind: 'note', text: note }, at);
    const active = this.active.get(runId);
    if (active) { await this.commit(active, next); return active.run; }
    const finished = run.status === 'completed' || run.status === 'stopped';
    if (keepGoing && finished && run.remaining.length > 0) return this.resumeWith(run, ownerWindowId, continueToNextPhase(next, run.remaining, at));
    await this.ports.save(next);
    return next;
  }

  /** The crew's running state when it is working, otherwise one that borrows (or opens) its conversation for a call to the Lead. */
  private async localActive(run: CrewRun, ownerWindowId: number): Promise<ActiveRun> {
    const live = this.active.get(run.id);
    if (live) return live;
    const conversationId = run.conversationId ?? (await this.ports.createConversation(run.projectId, `Crew: ${run.goal.slice(0, 50)}`, { kind: 'crew', runId: run.id })).id;
    return {
      ownerWindowId, conversationId, controller: new AbortController(), run: { ...run, conversationId }, cancelled: false, done: Promise.resolve(),
      wave: 0, leadDecided: new Set(), autoPhases: 0, serialRetryTasks: [], children: new Set(),
    };
  }

  private async askLead(run: CrewRun, question: string, ownerWindowId: number): Promise<CrewRun> {
    const lead = run.config.roles.find((role) => role.kind === 'lead');
    if (!lead) throw new Error('This crew has no Lead to ask.');
    const live = this.active.has(run.id);
    const active = await this.localActive(run, ownerWindowId);
    // A crew that is working has its agents in its own conversation, so a question gets one of its own; an idle crew
    // answers in the run's conversation. Either way the id is saved with the first line, so the next question reuses it.
    const conversationId = live
      ? (active.run.askConversationId ?? (await this.ports.createConversation(run.projectId, `Crew: ${run.goal.slice(0, 50)}`, { kind: 'crew', runId: run.id })).id)
      : active.conversationId;
    await this.commit(active, addChat({ ...active.run, ...(live ? { askConversationId: conversationId } : {}) }, { from: 'you', kind: 'ask', text: question }, this.now().toISOString()));
    const entry = { conversationId, cancelled: false };
    this.asking.set(run.id, entry);
    let result: CallResult;
    try {
      result = await this.call(active, lead, askPrompt(active.run, question), { fresh: true, label: `Question to the Lead: ${question}`, conversationId });
    } finally {
      this.asking.delete(run.id);
    }
    // A steer or an approval can land while the answer is being written. An idle crew's copy of the run is this call's
    // own, so it is brought up to date first, or saving the answer would put back what it changed.
    if (!live) {
      const latest = await this.get(run.id);
      if (latest) active.run = { ...latest, chat: mergeChat(latest.chat, active.run.chat) };
    }
    const at = this.now().toISOString();
    if (entry.cancelled) {
      await this.commit(active, addChat(active.run, { from: 'lead', kind: 'note', text: 'Stopped. I did not finish answering.' }, at));
      return active.run;
    }
    const reply = result.status === 'completed' && result.output.trim() ? result.output.trim() : `I could not answer that just now${result.error ? `: ${result.error.slice(0, 200)}` : '.'}`;
    const paid: CrewRun = { ...active.run, spentUsd: active.run.spentUsd + (result.costUsd ?? 0) };
    await this.commit(active, addChat(paid, { from: 'lead', kind: 'answer', text: reply }, at));
    return active.run;
  }

  /** Stops the Lead answering a question. Only the answer's own conversation is cancelled, never the crew's agents. */
  async stopAsk(runId: string): Promise<CrewRun> {
    const entry = this.asking.get(runId);
    if (entry) {
      entry.cancelled = true;
      this.ports.cancelAgent(entry.conversationId);
    }
    return this.require(runId);
  }

  /** Picks a paused or interrupted run back up. Work that was mid-build starts again; nothing accepted is redone. */
  async resume(runId: string, ownerWindowId: number): Promise<CrewRun> {
    const run = await this.require(runId);
    if (this.active.has(runId)) return this.active.get(runId)!.run;
    if (run.status === 'completed' || run.status === 'stopped') throw new Error('This crew has finished.');
    if (run.ask || run.status === 'needsYou') throw new Error('This crew is waiting for your answer first.');
    const at = this.now().toISOString();
    return this.resumeWith(run, ownerWindowId, {
      // A run with no tasks yet was interrupted while planning, so it plans again instead of starting an empty build.
      ...run, status: run.status === 'awaitingApproval' ? 'awaitingApproval' : run.tasks.length === 0 || run.followUp ? 'planning' : 'running', updatedAt: at,
      // A task that was being built when the run stopped has no result to review, so it waits to be built again.
      tasks: run.tasks.map((task) => (task.status === 'building' ? { ...task, status: 'backlog' as const } : task)),
    });
  }

  /** Stops the agent that is running now and pauses the crew where it is. */
  async pause(runId: string): Promise<CrewRun> {
    const active = this.active.get(runId);
    if (!active) return this.require(runId);
    active.cancelled = true;
    active.controller.abort();
    await Promise.all([active.conversationId, ...active.children].map((id) => this.ports.cancelAgent(id)));
    await active.done.catch(() => undefined);
    this.active.delete(runId);
    // A run that finished or stopped to ask while Pause was pressed keeps that outcome.
    if (active.run.status !== 'running' && active.run.status !== 'planning') return active.run;
    const run = { ...active.run, status: 'paused' as const, updatedAt: this.now().toISOString() };
    await this.commit(active, run);
    return run;
  }

  /** Ends the run with what is accepted so far. */
  async stop(runId: string): Promise<CrewRun> {
    const paused = await this.pause(runId);
    const at = this.now().toISOString();
    const run: CrewRun = { ...paused, status: 'stopped', completedAt: at, updatedAt: at, ask: null };
    await this.ports.save(run);
    return run;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.active.keys()].map((id) => this.pause(id).catch(() => undefined)));
  }

  /** Resolves when the agent work for this run has stopped (finished, waiting on you, or paused). */
  async whenIdle(runId: string): Promise<void> {
    await this.active.get(runId)?.done.catch(() => undefined);
  }

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  private async require(runId: string): Promise<CrewRun> {
    const run = await this.get(runId);
    if (!run) throw new Error('That crew run no longer exists.');
    return run;
  }

  private attach(run: CrewRun, ownerWindowId: number, conversationId: string): ActiveRun {
    const active: ActiveRun = { ownerWindowId, conversationId, controller: new AbortController(), run, cancelled: false, done: Promise.resolve(), wave: 0, leadDecided: new Set(), autoPhases: 0, serialRetryTasks: run.tasks.filter((task) => task.note.startsWith('Its changes conflicted with another independent task') || task.note.startsWith('Its changes conflicted with another task')).map((task) => task.id), children: new Set() };
    this.active.set(run.id, active);
    return active;
  }

  private async resumeWith(previous: CrewRun, ownerWindowId: number, next: CrewRun): Promise<CrewRun> {
    const existing = this.active.get(previous.id);
    if (existing && !existing.cancelled) { await this.commit(existing, next); return next; }
    // One conversation per run: a resume or follow-up carries on in the run's own, and only a run that never had one
    // (started before the crew kept its id) gets a new one.
    const conversation = next.conversationId
      ? { id: next.conversationId }
      : await this.ports.createConversation(next.projectId, `Crew: ${next.goal.slice(0, 50)}`, { kind: 'crew', runId: next.id });
    // The newest conversation holds the latest work, so it is the one the Chat tab links to.
    const stamped: CrewRun = { ...next, conversationId: conversation.id };
    const active = this.attach(stamped, ownerWindowId, conversation.id);
    await this.commit(active, stamped);
    if (stamped.status === 'running' || stamped.status === 'planning') active.done = this.drive(active);
    else this.active.delete(stamped.id);
    return stamped;
  }

  private async commit(active: ActiveRun, run: CrewRun): Promise<void> {
    // A line added to the thread while another save was in flight is kept, whichever copy of the run reaches here.
    const stamped = { ...run, chat: mergeChat(active.run.chat, run.chat), liveConversations: this.liveIds(active) };
    active.run = stamped;
    await this.ports.save(stamped);
    this.ports.notifyChanged(active.ownerWindowId, stamped);
  }

  private liveIds(active: ActiveRun): string[] {
    return [active.conversationId, ...active.children];
  }

  /** Tells the screen which conversations are live now, without saving: a helper started or finished between commits. */
  private announce(active: ActiveRun): void {
    active.run = { ...active.run, liveConversations: this.liveIds(active) };
    this.ports.notifyChanged(active.ownerWindowId, active.run);
  }

  private async drive(active: ActiveRun): Promise<void> {
    try {
      // A fresh run plans first; so does a finished run that was given a follow-up, whose board already has tasks.
      if (active.run.status === 'planning') {
        await this.plan(active);
        // Planning replaces the run, so its status is read afresh: it may now be waiting for approval or for you.
        if ((active.run as CrewRun).status !== 'running') return;
      }
      await this.loop(active);
    } catch (error) {
      if (active.cancelled) return;
      const at = this.now().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      const run: CrewRun = {
        ...active.run, status: 'paused', updatedAt: at,
        feed: [...active.run.feed, { id: `feed_${randomUUID()}`, at, who: 'crew', kind: 'info' as const, text: `The crew stopped on a problem: ${message.slice(0, 300)}` }].slice(-400),
      };
      await this.commit(active, run).catch(() => undefined);
    } finally {
      if (active.run.status !== 'running' && active.run.status !== 'planning') this.active.delete(active.run.id);
    }
  }

  private async plan(active: ActiveRun): Promise<void> {
    const { run: current } = active;
    const planner = current.config.roles.find((role) => role.kind === 'planner') ?? current.config.roles.find((role) => role.kind === 'lead')!;
    const conventions = (await this.ports.conventions?.(current.projectId, current.goal).catch(() => '')) ?? '';
    const design = (await this.ports.design?.status().catch(() => null)) ?? null;
    const answer = await this.askJson(active, planner, planPrompt(current.goal, current.config, conventions, current, design), 'plan', parsePlanFull);
    if (design) active.run = { ...active.run, design };
    if (active.cancelled) return;
    const at = this.now().toISOString();
    let run = active.run;
    if (answer.value === null && current.followUp) {
      // The finished work is still finished: a follow-up the Lead could not plan puts the run back as it was.
      const message = 'The Lead could not plan that follow-up. The finished work is unchanged; try asking again in other words.';
      await this.commit(active, { ...run, status: 'completed', followUp: null, completedAt: at, spentUsd: run.spentUsd + answer.costUsd, updatedAt: at, feed: [...run.feed, { id: `feed_${randomUUID()}`, at, who: planner.id, kind: 'info' as const, text: message }] });
      return;
    }
    if (answer.value === null) {
      const message = 'The Lead could not produce a usable plan.';
      await this.commit(active, { ...run, status: 'needsYou', ask: { reason: 'noProgress', message }, spentUsd: run.spentUsd + answer.costUsd, updatedAt: at, feed: [...run.feed, { id: `feed_${randomUUID()}`, at, who: planner.id, kind: 'needsYou', text: message }] });
      return;
    }
    const before = run.tasks.length;
    const added = addTasks({ ...run, spentUsd: run.spentUsd + answer.costUsd }, uniqueTaskIds(run.tasks, answer.value.tasks), at);
    run = added.run;
    for (const reason of added.refused) run = { ...run, feed: [...run.feed, { id: `feed_${randomUUID()}`, at, who: 'crew', kind: 'info' as const, text: `Left out a task: ${reason}` }] };
    if (run.tasks.length === before && current.followUp) {
      const message = `The Lead had nothing new to add for that. ${added.refused[0] ?? ''}`.trim();
      await this.commit(active, { ...run, status: 'completed', followUp: null, completedAt: at, updatedAt: at, feed: [...run.feed, { id: `feed_${randomUUID()}`, at, who: planner.id, kind: 'info' as const, text: message }] });
      return;
    }
    if (run.tasks.length === 0) {
      const message = `The plan had no usable tasks. ${added.refused[0] ?? ''}`.trim();
      await this.commit(active, { ...run, status: 'needsYou', ask: { reason: 'noProgress', message } });
      return;
    }
    run = { ...run, feed: [...run.feed, { id: `feed_${randomUUID()}`, at, who: planner.id, kind: 'info' as const, text: `Wrote ${run.tasks.length - before} ${run.tasks.length - before === 1 ? 'task' : 'tasks'}.` }] };
    // What the plan says needs the person's OK is asked for before anything is built; the crew never assumes it.
    const planned = requestApprovals({ ...run, followUp: null }, answer.value.approvals, at);
    await this.commit(active, planned.status === 'needsYou' ? { ...planned, updatedAt: at } : { ...planned, status: run.config.approvePlan ? 'awaitingApproval' : 'running', updatedAt: at });
  }

  /** On a fresh run, runs the project check once before any task, so a repository that already fails is not blamed on the first builder. */
  private async measureBaseline(active: ActiveRun): Promise<void> {
    const { run } = active;
    const command = run.config.checkCommand;
    if (!command || active.baselineFailing !== undefined || run.tasks.some((task) => task.status !== 'backlog' || task.reviews.length > 0)) return;
    const check = await this.ports.runCheck(run.projectId, command, active.controller.signal);
    if (active.cancelled) return;
    active.baselineFailing = !check.passed;
    if (check.passed) return;
    const at = this.now().toISOString();
    await this.commit(active, { ...run, feed: [...run.feed, { id: `feed_${randomUUID()}`, at, who: 'crew', kind: 'info' as const, text: `"${command}" already fails before any task, so it is only checked once everything is accepted.` }] });
  }

  private async loop(active: ActiveRun): Promise<void> {
    await this.measureBaseline(active);
    for (;;) {
      if (active.cancelled) return;
      let run = reassignReadOnlyTasks(enforceLimits(active.run, this.now()), this.now().toISOString());
      if (run !== active.run) await this.commit(active, run);
      // A task that ran out of retries goes to the Lead before it goes to the user, once per task per run.
      if (run.status === 'needsYou' && await this.leadUnsticks(active)) continue;
      if (run.status !== 'running') return;

      // Work waiting for a verdict (a task whose review was cut short) is judged before anything new is started.
      const waiting = run.tasks.find((task) => task.status === 'review');
      if (waiting) { await this.review(active, waiting.id); continue; }

      if (isFinished(run)) {
        const finished = await this.finish(active);
        if (finished) return;
        continue;
      }

      const ready = pickTasks(run);
      const serialRetry = active.serialRetryTasks.map((id) => ready.find((task) => task.id === id)).find((task) => task !== undefined);
      const next = serialRetry ?? ready[0];
      if (!next) {
        const message = unfinishedReason(run) ?? 'No task can start.';
        run = { ...run, status: 'needsYou', ask: { reason: 'noProgress', message: `The crew is stuck: ${message}` }, updatedAt: this.now().toISOString() };
        await this.commit(active, settle(run, run.updatedAt));
        return;
      }
      const roles = run.config.roles;
      const batch = serialRetry
        ? [next]
        : ready.filter((task) => {
          const role = roles.find((item) => item.id === task.role);
          return role?.kind !== 'designer';
        }).slice(0, run.config.limits.maxParallelTasks);
      if (batch.length > 1 && !this.ports.worktrees && !active.run.feed.some((item) => item.text.includes('parallel Crew work needs a Git project'))) {
        await this.commit(active, { ...active.run, feed: [...active.run.feed, { id: `feed_${randomUUID()}`, at: this.now().toISOString(), who: 'crew', kind: 'info', text: 'Independent tasks are running one at a time because parallel Crew work needs a Git project with a commit.' }] });
      }
      if (batch.length > 1 && this.ports.worktrees) {
        let session: ParallelSession | null = null;
        try { session = await this.ports.worktrees.prepare(run.projectId, `crew-${run.id}-${++active.wave}`); }
        catch (error) {
          await this.commit(active, { ...active.run, feed: [...active.run.feed, { id: `feed_${randomUUID()}`, at: this.now().toISOString(), who: 'crew', kind: 'info', text: `Independent tasks will run one at a time because separate project copies could not be prepared: ${error instanceof Error ? error.message : String(error)}` }] });
        }
        if (session) {
          await this.buildParallel(active, batch, session);
          continue;
        }
        if (!session && !active.run.feed.some((item) => item.text.includes('parallel Crew work needs a Git project'))) {
          await this.commit(active, { ...active.run, feed: [...active.run.feed, { id: `feed_${randomUUID()}`, at: this.now().toISOString(), who: 'crew', kind: 'info', text: 'Independent tasks are running one at a time because parallel Crew work needs a Git project with a commit.' }] });
        }
      }
      if (serialRetry) active.serialRetryTasks = active.serialRetryTasks.filter((id) => id !== serialRetry.id);
      await this.build(active, next.id);
    }
  }

  /** Builds independent tasks in separate project copies, integrates their work, then reviews the integrated result. */
  private async buildParallel(active: ActiveRun, tasks: readonly CrewTask[], session: ParallelSession): Promise<void> {
    const at = (): string => this.now().toISOString();
    let run = active.run;
    for (const task of tasks) {
      const role = run.config.roles.find((item) => item.id === task.role);
      if (role) run = startTask(run, task.id, role.id, at());
    }
    await this.commit(active, run);
    type Outcome = { taskId: string; status: 'success' | 'failed' | 'checkFailed'; commit?: string; files: string[]; output: string; costUsd: number; error?: string; checkOutput?: string };
    const outcomes = new Map<string, Outcome>();
    try {
      await Promise.all(tasks.map(async (task) => {
        const role = active.run.config.roles.find((item) => item.id === task.role);
        if (!role) { outcomes.set(task.id, { taskId: task.id, status: 'failed', files: [], output: '', costUsd: 0, error: `There is no role ${task.role}.` }); return; }
        if (roleAccess(role) !== 'edit') { outcomes.set(task.id, { taskId: task.id, status: 'failed', files: [], output: '', costUsd: 0, error: `${role.label} cannot change files, so it cannot build this.` }); return; }
        let conversationId = active.conversationId;
        try {
          const cwd = await session.checkout(task.id);
          if (active.cancelled) return;
          const conversation = await this.ports.createConversation(active.run.projectId, `Crew task: ${task.title}`, { kind: 'crew', runId: active.run.id });
          conversationId = conversation.id;
          active.children.add(conversationId);
          this.announce(active);
          if (active.cancelled) return;
          const conventions = (await this.ports.conventions?.(active.run.projectId, `${active.run.goal} ${task.title}`).catch(() => '')) ?? '';
          const result = await this.call(active, role, taskBrief(active.run, task.id, conventions), { effortFrom: `${task.title}\n${task.description}`, fresh: true, cwd, conversationId, label: `Build: ${task.title}` });
          if (active.cancelled) return;
          if (result.status === 'failed') {
            outcomes.set(task.id, { taskId: task.id, status: 'failed', files: [], output: result.output, costUsd: result.costUsd ?? 0, error: result.error ?? 'The agent stopped without finishing.' });
            return;
          }
          if (active.run.config.checkCommand && !active.baselineFailing) {
            const check = await this.ports.runCheck(active.run.projectId, active.run.config.checkCommand, active.controller.signal, { cwd });
            if (!check.passed) {
              outcomes.set(task.id, { taskId: task.id, status: 'checkFailed', files: [], output: result.output, costUsd: result.costUsd ?? 0, checkOutput: check.output });
              return;
            }
          }
          if (active.cancelled) return;
          const commit = await session.commit(task.id, `Crew: ${task.title}`);
          if (active.cancelled) return;
          const files = await session.filesChanged(commit);
          outcomes.set(task.id, { taskId: task.id, status: 'success', commit, files, output: result.output, costUsd: result.costUsd ?? 0 });
        } catch (error) {
          outcomes.set(task.id, { taskId: task.id, status: 'failed', files: [], output: '', costUsd: 0, error: error instanceof Error ? error.message : String(error) });
        } finally {
          if (conversationId !== active.conversationId) { active.children.delete(conversationId); this.announce(active); }
        }
      }));
      if (active.cancelled) return;
      const commits = tasks.flatMap((task) => { const outcome = outcomes.get(task.id); return outcome?.status === 'success' && outcome.commit ? [{ stepId: task.id, commit: outcome.commit }] : []; });
      const integration = commits.length ? await session.integrate(commits) : null;
      const conflicts = new Set(integration?.conflicts.map((item) => item.stepId) ?? []);
      for (const outcome of outcomes.values()) {
        if (integration?.skipped.some((file) => outcome.files.includes(file))) conflicts.add(outcome.taskId);
      }
      if (integration?.skipped.length) await this.commit(active, { ...active.run, feed: [...active.run.feed, { id: `feed_${randomUUID()}`, at: at(), who: 'crew', kind: 'info', text: `The project changed while independent tasks were running. KAI kept your versions of: ${integration.skipped.join(', ')}. Affected tasks will retry alone.` }] });
      for (const task of tasks) {
        const outcome = outcomes.get(task.id);
        if (!outcome) continue;
        if (conflicts.has(task.id)) {
          if (!active.serialRetryTasks.includes(task.id)) active.serialRetryTasks.push(task.id);
          await this.commit(active, { ...active.run, tasks: active.run.tasks.map((item) => item.id === task.id ? { ...item, status: 'backlog' as const, note: 'Its changes conflicted with another independent task. It will be retried alone on top of the integrated work.' } : item), feed: [...active.run.feed, { id: `feed_${randomUUID()}`, at: at(), who: 'crew', kind: 'info' as const, taskId: task.id, text: `The changes for "${task.title}" conflicted with another task, so it will be retried on its own.` }] });
          continue;
        }
        if (outcome.status === 'failed') {
          await this.commit(active, failBuildSmart(addSpend(active.run, task.id, outcome.costUsd, at()), task.id, outcome.error ?? 'The agent stopped without finishing.', at()));
          continue;
        }
        if (outcome.status === 'checkFailed') {
          let failed = addSpend(active.run, task.id, outcome.costUsd, at());
          failed = submitTask(failed, task.id, { files: [], costUsd: 0 }, at());
          failed = reviewTask(failed, task.id, { verdict: 'sendBack', feedback: `The project check "${failed.config.checkCommand}" fails in this task's isolated copy.${outcome.checkOutput ? `\n${outcome.checkOutput.trim().slice(-1_500)}` : ''}`, reviewer: CHECK_REVIEWER }, at());
          this.builderReply.set(task.id, outcome.output);
          await this.commit(active, failed);
          continue;
        }
        let submitted = submitTask(active.run, task.id, { files: outcome.files, costUsd: outcome.costUsd }, at());
        if (submitted.config.checkCommand && !active.baselineFailing) {
          const current = submitted.tasks.find((item) => item.id === task.id)!;
          submitted = { ...submitted, tasks: submitted.tasks.map((item) => item.id === task.id ? { ...item, reviews: [...item.reviews, { round: current.round, verdict: 'accept' as const, feedback: '', reviewer: CHECK_REVIEWER, at: at() }] } : item) };
          this.checkNote.set(task.id, `The project check "${submitted.config.checkCommand}" passed in this task's isolated copy.`);
        }
        this.builderReply.set(task.id, outcome.output);
        await this.commit(active, submitted);
        await this.review(active, task.id);
      }
    } finally {
      await session.dispose().catch(() => undefined);
    }
  }

  /** Everything is accepted: run the project's own check if there is one, and finish only when it passes. */
  private async finish(active: ActiveRun): Promise<boolean> {
    const at = this.now().toISOString();
    const { run } = active;
    if (!run.config.checkCommand) return this.settleWithCoverage(active, at);
    const check = await this.ports.runCheck(run.projectId, run.config.checkCommand, active.controller.signal);
    if (active.cancelled) return true;
    if (check.passed) return this.settleWithCoverage(active, at, { passed: true });
    const fixed = addCheckFix(run, check.output, at);
    await this.commit(active, fixed);
    return fixed.status !== 'running';
  }

  /**
   * Every planned task is accepted, but that is not the same as the goal being met: a goal that names a multi-phase plan
   * is often planned one phase at a time. The Lead is asked what is still undone. With "keep going" on, the crew plans
   * the next part itself; otherwise it finishes and says plainly what is left. Returns true when the run is over.
   */
  private async settleWithCoverage(active: ActiveRun, at: string, check?: { passed: boolean }): Promise<boolean> {
    const lead = active.run.config.roles.find((role) => role.kind === 'lead');
    if (lead) {
      const answer = await this.askJson(active, lead, coveragePrompt(active.run), 'coverage', parseCoverage);
      if (active.cancelled) return true;
      const remaining = answer.value?.remaining ?? [];
      const paid: CrewRun = { ...active.run, remaining, spentUsd: active.run.spentUsd + answer.costUsd, updatedAt: this.now().toISOString() };
      if (remaining.length > 0 && active.run.keepGoing && active.autoPhases < MAX_AUTO_PHASES) {
        active.autoPhases += 1;
        await this.commit(active, continueToNextPhase(paid, remaining, this.now().toISOString()));
        await this.plan(active);
        // Planning left the run running (more tasks added) or put it back as finished (nothing to add); only the first goes on.
        return (active.run as CrewRun).status !== 'running';
      }
      await this.commit(active, paid);
    }
    await this.commit(active, settle(active.run, at, check));
    return true;
  }

  private async build(active: ActiveRun, taskId: string): Promise<void> {
    const at = (): string => this.now().toISOString();
    let task = active.run.tasks.find((item) => item.id === taskId)!;
    const role = active.run.config.roles.find((item) => item.id === task.role);
    if (!role) { await this.commit(active, failBuild(active.run, taskId, `There is no role ${task.role}.`, at())); return; }
    if (roleAccess(role) !== 'edit') { await this.commit(active, failBuild(active.run, taskId, `${role.label} cannot change files, so it cannot build this.`, at())); return; }

    await this.commit(active, startTask(active.run, taskId, role.id, at()));
    const conventions = (await this.ports.conventions?.(active.run.projectId, `${active.run.goal} ${task.title}`).catch(() => '')) ?? '';
    const before = await this.changed(active.run.projectId);
    const brief = taskBrief(active.run, taskId, conventions);
    const result = role.kind === 'designer' && this.ports.design
      ? await this.draw(active, task, brief)
      : await this.call(active, role, brief, { effortFrom: `${task.title}\n${task.description}`, fresh: true, label: `Build: ${task.title}` });
    if (active.cancelled) return;
    let run = addSpend(active.run, taskId, result.costUsd ?? 0, at());
    if (result.status === 'failed') {
      await this.commit(active, failBuildSmart(run, taskId, result.error ?? 'The agent stopped without finishing.', at()));
      return;
    }
    const after = await this.changed(active.run.projectId);
    const files = after.filter((file) => !before.includes(file));
    // A designer changed Open Pencil, so the pages the Lead and the builders see are read again.
    if (role.kind === 'designer') run = { ...run, design: (await this.ports.design?.status().catch(() => null)) ?? run.design };
    // The cost was already added above; submitting only moves the task to review with its files.
    run = submitTask(run, taskId, { files }, at());
    task = run.tasks.find((item) => item.id === taskId)!;
    await this.commit(active, run);
    this.builderReply.set(taskId, result.output);
    await this.review(active, taskId);
  }

  /** Every reviewer kind that exists, then the Lead, check a finished task. */
  private async review(active: ActiveRun, taskId: string): Promise<void> {
    const at = (): string => this.now().toISOString();
    const roles = active.run.config.roles;
    const task = (): CrewTask => active.run.tasks.find((item) => item.id === taskId)!;
    const builder = roles.find((role) => role.id === task().assignedTo);
    const mayChangeFiles = builder ? roleAccess(builder) === 'edit' : true;

    // The project's own check comes before any opinion: a task that breaks it is sent back with the output, so a break
    // is found one task after it happens, not after every task has been accepted. Runs once per round.
    const checkCommand = active.run.config.checkCommand;
    if (checkCommand && mayChangeFiles && !active.baselineFailing && !task().reviews.some((review) => review.reviewer === CHECK_REVIEWER && review.round === task().round)) {
      const check = await this.ports.runCheck(active.run.projectId, checkCommand, active.controller.signal);
      if (active.cancelled) return;
      if (!check.passed) {
        const tail = check.output.trim().slice(-1_500);
        await this.commit(active, reviewTask(active.run, taskId, { verdict: 'sendBack', feedback: `The project check "${checkCommand}" fails with this task's changes.${tail ? `
${tail}` : ''}`, reviewer: CHECK_REVIEWER }, at()));
        this.checkNote.delete(taskId);
        return;
      }
      this.checkNote.set(taskId, `The project check "${checkCommand}" passed after this task.`);
      await this.commit(active, { ...active.run, tasks: active.run.tasks.map((item) => (item.id === taskId ? { ...item, reviews: [...item.reviews, { round: item.round, verdict: 'accept' as const, feedback: '', reviewer: CHECK_REVIEWER, at: at() }] } : item)) });
    }

    // A fixed order keeps a run reproducible: security first, then the test and audit passes, then a plain
    // reviewer. Each role runs once per round; a pass is remembered so a resumed run does not pay twice.
    const REVIEW_ORDER = ['security', 'tester', 'auditor', 'license', 'compliance', 'reviewer'] as const;
    for (const kind of REVIEW_ORDER) {
      for (const reviewer of roles.filter((role) => role.kind === kind)) {
        if (!mayChangeFiles) continue;
        if (task().reviews.some((review) => review.reviewer === reviewer.id && review.round === task().round)) continue;
        const answer = await this.askJson(active, reviewer, reviewRolePrompt(kind, active.run, task()), 'review', parseReview);
        if (active.cancelled) return;
        let run = addSpend(active.run, taskId, answer.costUsd, at());
        if (answer.value && answer.value.verdict === 'accept') {
          run = { ...run, tasks: run.tasks.map((item) => (item.id === taskId ? { ...item, reviews: [...item.reviews, { round: item.round, verdict: 'accept' as const, feedback: '', reviewer: reviewer.id, at: at() }] } : item)) };
          await this.commit(active, run);
        } else {
          const verdict = answer.value ?? { verdict: 'needsYou' as const, feedback: `${reviewer.label} gave an answer that could not be read, so the work was not checked.` };
          await this.commit(active, reviewTask(run, taskId, { ...verdict, reviewer: reviewer.id }, at()));
          return;
        }
      }
    }

    const lead = roles.find((role) => role.kind === 'lead')!;
    const answer = await this.askJson(active, lead, reviewPrompt(active.run, task(), this.builderReply.get(taskId) ?? '', this.checkNote.get(taskId)), 'review', parseReview);
    if (active.cancelled) return;
    const run = addSpend(active.run, taskId, answer.costUsd, at());
    const verdict = answer.value ?? { verdict: 'needsYou' as const, feedback: 'The Lead gave an answer that could not be read, so the work was not accepted without a check.' };
    // The reviewer passes stay in the task's reviews; the Lead's verdict is the one that decides the task.
    await this.commit(active, reviewTask(run, taskId, { ...verdict, reviewer: lead.id }, at()));
    this.builderReply.delete(taskId);
  }

  /**
   * The crew is meant to keep going on its own, so a stuck task is put to the Lead first: try again with a different
   * instruction, skip it, or hand it to the user. The Lead gets one call per task; if its answer is "ask", cannot be
   * read, or the retry fails again, the question goes to the user as before. Returns true when the run can go on.
   */
  private async leadUnsticks(active: ActiveRun): Promise<boolean> {
    const stuck = stuckTask(active.run);
    if (!stuck || active.leadDecided.has(stuck.id)) return false;
    active.leadDecided.add(stuck.id);
    const lead = active.run.config.roles.find((role) => role.kind === 'lead');
    if (!lead) return false;
    const answer = await this.askJson(active, lead, stuckPrompt(active.run, stuck), 'stuck', parseStuckDecision);
    if (active.cancelled) return true;
    const at = this.now().toISOString();
    const paid = addSpend(active.run, stuck.id, answer.costUsd, at);
    const next = answer.value ? resolveStuck(paid, answer.value, lead.id, at) : null;
    await this.commit(active, next ?? paid);
    return next !== null;
  }

  /** A designer's turn: Open Pencil is opened if needed, then the agent draws with its tools. */
  private async draw(active: ActiveRun, task: CrewTask, brief: string): Promise<CallResult> {
    const design = this.ports.design!;
    const page = task.designRef ?? task.title;
    const prompt = `${brief}\n\nDraw or update this page in Open Pencil with its tools. Name the page exactly "${page}". Follow the style of the pages already there. When done, say which page you drew and what is on it.`;
    try {
      await design.ensureRunning();
      return await design.draw(active.run.projectId, prompt, `crew-${active.run.id}`);
    } catch (error) {
      return { status: 'failed', output: '', error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async changed(projectId: string): Promise<string[]> {
    return (await this.ports.changedFiles?.(projectId).catch(() => [])) ?? [];
  }

  /** Asks a role for a reply that must parse; if it does not, asks once more with a stricter request. */
  private async askJson<T>(active: ActiveRun, role: CrewRole, prompt: string, kind: 'plan' | 'review' | 'stuck' | 'coverage', parse: (text: string) => T | null): Promise<{ value: T | null; costUsd: number }> {
    let costUsd = 0;
    const first = await this.call(active, role, prompt, { fresh: true, label: ASK_LABEL[kind] });
    costUsd += first.costUsd ?? 0;
    if (active.cancelled) return { value: null, costUsd };
    const value = first.status === 'completed' ? parse(first.output) : null;
    if (value !== null || first.status === 'failed') return { value, costUsd };
    const second = await this.call(active, role, retryPrompt(kind), { fresh: false, label: `${ASK_LABEL[kind]} (asked again)` });
    costUsd += second.costUsd ?? 0;
    return { value: second.status === 'completed' ? parse(second.output) : null, costUsd };
  }

  private async call(active: ActiveRun, role: CrewRole, prompt: string, options: { fresh: boolean; effortFrom?: string; cwd?: string; conversationId?: string; label?: string }): Promise<CallResult> {
    const { config } = active.run;
    const instructions = role.instructions.trim();
    const request: AgentRunRequest = {
      conversationId: options.conversationId ?? active.conversationId,
      prompt: instructions ? `${prompt}\n\nExtra guidance for your role:\n${instructions}` : prompt,
      agent: role.agent,
      execution: role.execution,
      route: role.route,
      ...(role.execution === 'api' && role.api ? { apiConnection: role.api } : {}),
      // A role that cannot edit runs in Plan, whatever the crew's autonomy says.
      autonomy: roleAccess(role) === 'edit' ? config.autonomy : 'plan',
      helpers: helperChoiceFor(subAgentsFor(config, role.id, 0)),
      ...(role.model ? { model: role.model } : options.effortFrom && config.savings.lightModelForRoutine ? { effort: classifyWork(options.effortFrom).level } : {}),
      ...(options.fresh ? { freshSession: true } : {}),
      // The log shows a short line, not the whole brief.
      ...(options.label ? { displayText: options.label.replace(/\s+/g, ' ').trim().slice(0, 500) } : {}),
    };
    try {
      return await this.ports.runAgent(request, active.ownerWindowId, options.cwd ? { cwd: options.cwd } : undefined);
    } catch (error) {
      return { status: 'failed', output: '', error: error instanceof Error ? error.message : String(error) };
    }
  }
}
