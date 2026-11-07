import { randomUUID } from 'node:crypto';
import { classifyWork, crewRunSchema } from '@kai/contracts';
import type { AgentRunRequest, AgentRunResult, CrewConfig, CrewDesign, CrewRole, CrewRun, CrewTask } from '@kai/contracts';
import {
  addCheckFix, addSpend, addTasks, answerAsk, enforceLimits, failBuild, helperChoiceFor, isFinished, parseReview, pickTasks, reviewTask,
  roleAccess, settle, startTask, submitTask, subAgentsFor, taskBrief, unfinishedReason,
} from './crew-engine';
import { parsePlan, planPrompt, retryPrompt, reviewPrompt, reviewRolePrompt } from './crew-prompts';

export interface CrewRunnerPorts {
  createConversation(projectId: string, title: string): Promise<{ id: string }>;
  runAgent(request: AgentRunRequest, ownerWindowId: number): Promise<AgentRunResult>;
  cancelAgent(conversationId: string): boolean;
  runCheck(projectId: string, command: string, signal: AbortSignal): Promise<{ passed: boolean; output: string }>;
  save(run: CrewRun): Promise<void>;
  load(id: string): Promise<CrewRun | null>;
  list(projectId?: string): Promise<CrewRun[]>;
  notifyChanged(ownerWindowId: number, run: CrewRun): void;
  /** A few lines on how this developer usually builds things, for the goal. Optional: no conventions, no lines. */
  conventions?(projectId: string, goal: string): Promise<string>;
  /** Paths with uncommitted changes, so a task's files can be told apart from what was already changed. */
  changedFiles?(projectId: string): Promise<string[]>;
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
}

/** The reviewer id the per-task project check is recorded under; it is not a role. */
const CHECK_REVIEWER = 'check';

interface ActiveRun {
  ownerWindowId: number;
  conversationId: string;
  controller: AbortController;
  run: CrewRun;
  /** Whether the project's check already failed before the crew changed anything; then it cannot blame a task. */
  baselineFailing?: boolean;
  cancelled: boolean;
  done: Promise<void>;
}

/**
 * Drives a Crew run: the Lead writes the tasks, workers build them one at a time, the security role and the Lead check
 * each result, and a send-back goes to the builder that wrote it. The rules live in `crew-engine.ts`; this class only
 * starts agents and records what they said. Work runs one task at a time in the project; running several at once
 * needs separate copies of it, as the workflow runner uses, and is not wired here yet.
 */
export class DesktopCrewRunner {
  private readonly active = new Map<string, ActiveRun>();
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
    const conversation = await this.ports.createConversation(input.projectId, `Crew: ${input.goal.slice(0, 50)}`);
    const run = crewRunSchema.parse({
      schemaVersion: 1, id: `crew_${randomUUID()}`, projectId: input.projectId, goal: input.goal, status: 'planning',
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
    return runs.map((run) => (run.status === 'running' && !this.active.has(run.id) ? { ...run, status: 'paused' as const } : run));
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
    if (!run.ask) throw new Error('This crew is not waiting on a question.');
    return this.resumeWith(run, ownerWindowId, answerAsk(run, answer, guidance, this.now().toISOString()));
  }

  /** Picks a paused or interrupted run back up. Work that was mid-build starts again; nothing accepted is redone. */
  async resume(runId: string, ownerWindowId: number): Promise<CrewRun> {
    const run = await this.require(runId);
    if (this.active.has(runId)) return this.active.get(runId)!.run;
    if (run.status === 'completed' || run.status === 'stopped') throw new Error('This crew has finished.');
    if (run.ask || run.status === 'needsYou') throw new Error('This crew is waiting for your answer first.');
    const at = this.now().toISOString();
    return this.resumeWith(run, ownerWindowId, {
      ...run, status: run.status === 'awaitingApproval' ? 'awaitingApproval' : 'running', updatedAt: at,
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
    this.ports.cancelAgent(active.conversationId);
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
    const active: ActiveRun = { ownerWindowId, conversationId, controller: new AbortController(), run, cancelled: false, done: Promise.resolve() };
    this.active.set(run.id, active);
    return active;
  }

  private async resumeWith(previous: CrewRun, ownerWindowId: number, next: CrewRun): Promise<CrewRun> {
    const existing = this.active.get(previous.id);
    if (existing && !existing.cancelled) { await this.commit(existing, next); return next; }
    const conversation = await this.ports.createConversation(next.projectId, `Crew: ${next.goal.slice(0, 50)}`);
    const active = this.attach(next, ownerWindowId, conversation.id);
    await this.commit(active, next);
    if (next.status === 'running') active.done = this.drive(active);
    else this.active.delete(next.id);
    return next;
  }

  private async commit(active: ActiveRun, run: CrewRun): Promise<void> {
    active.run = run;
    await this.ports.save(run);
    this.ports.notifyChanged(active.ownerWindowId, run);
  }

  private async drive(active: ActiveRun): Promise<void> {
    try {
      if (active.run.tasks.length === 0 && active.run.status === 'planning') {
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
    const answer = await this.askJson(active, planner, planPrompt(current.goal, current.config, conventions, current, design), 'plan', parsePlan);
    if (design) active.run = { ...active.run, design };
    if (active.cancelled) return;
    const at = this.now().toISOString();
    let run = active.run;
    if (answer.value === null) {
      const message = 'The Lead could not produce a usable plan.';
      await this.commit(active, { ...run, status: 'needsYou', ask: { reason: 'noProgress', message }, spentUsd: run.spentUsd + answer.costUsd, updatedAt: at, feed: [...run.feed, { id: `feed_${randomUUID()}`, at, who: planner.id, kind: 'needsYou', text: message }] });
      return;
    }
    const added = addTasks({ ...run, spentUsd: run.spentUsd + answer.costUsd }, answer.value, at);
    run = added.run;
    for (const reason of added.refused) run = { ...run, feed: [...run.feed, { id: `feed_${randomUUID()}`, at, who: 'crew', kind: 'info' as const, text: `Left out a task: ${reason}` }] };
    if (run.tasks.length === 0) {
      const message = `The plan had no usable tasks. ${added.refused[0] ?? ''}`.trim();
      await this.commit(active, { ...run, status: 'needsYou', ask: { reason: 'noProgress', message } });
      return;
    }
    run = { ...run, feed: [...run.feed, { id: `feed_${randomUUID()}`, at, who: planner.id, kind: 'info' as const, text: `Wrote ${run.tasks.length} tasks.` }] };
    await this.commit(active, { ...run, status: run.config.approvePlan ? 'awaitingApproval' : 'running', updatedAt: at });
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
      let run = enforceLimits(active.run, this.now());
      if (run !== active.run) await this.commit(active, run);
      if (run.status !== 'running') return;

      // Work waiting for a verdict (a task whose review was cut short) is judged before anything new is started.
      const waiting = run.tasks.find((task) => task.status === 'review');
      if (waiting) { await this.review(active, waiting.id); continue; }

      if (isFinished(run)) {
        const finished = await this.finish(active);
        if (finished) return;
        continue;
      }

      const next = pickTasks({ ...run, config: { ...run.config, limits: { ...run.config.limits, maxParallelTasks: 1 } } })[0];
      if (!next) {
        const message = unfinishedReason(run) ?? 'No task can start.';
        run = { ...run, status: 'needsYou', ask: { reason: 'noProgress', message: `The crew is stuck: ${message}` }, updatedAt: this.now().toISOString() };
        await this.commit(active, settle(run, run.updatedAt));
        return;
      }
      await this.build(active, next.id);
    }
  }

  /** Everything is accepted: run the project's own check if there is one, and finish only when it passes. */
  private async finish(active: ActiveRun): Promise<boolean> {
    const at = this.now().toISOString();
    const { run } = active;
    if (!run.config.checkCommand) { await this.commit(active, settle(run, at)); return true; }
    const check = await this.ports.runCheck(run.projectId, run.config.checkCommand, active.controller.signal);
    if (active.cancelled) return true;
    if (check.passed) { await this.commit(active, settle(run, at, { passed: true })); return true; }
    const fixed = addCheckFix(run, check.output, at);
    await this.commit(active, fixed);
    return fixed.status !== 'running';
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
      : await this.call(active, role, brief, { effortFrom: `${task.title}\n${task.description}`, fresh: true });
    if (active.cancelled) return;
    let run = addSpend(active.run, taskId, result.costUsd ?? 0, at());
    if (result.status === 'failed') {
      await this.commit(active, failBuild(run, taskId, result.error ?? 'The agent stopped without finishing.', at()));
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
  private async askJson<T>(active: ActiveRun, role: CrewRole, prompt: string, kind: 'plan' | 'review', parse: (text: string) => T | null): Promise<{ value: T | null; costUsd: number }> {
    let costUsd = 0;
    const first = await this.call(active, role, prompt, { fresh: true });
    costUsd += first.costUsd ?? 0;
    if (active.cancelled) return { value: null, costUsd };
    const value = first.status === 'completed' ? parse(first.output) : null;
    if (value !== null || first.status === 'failed') return { value, costUsd };
    const second = await this.call(active, role, retryPrompt(kind), { fresh: false });
    costUsd += second.costUsd ?? 0;
    return { value: second.status === 'completed' ? parse(second.output) : null, costUsd };
  }

  private async call(active: ActiveRun, role: CrewRole, prompt: string, options: { fresh: boolean; effortFrom?: string }): Promise<CallResult> {
    const { config } = active.run;
    const instructions = role.instructions.trim();
    const request: AgentRunRequest = {
      conversationId: active.conversationId,
      prompt: instructions ? `${prompt}\n\nExtra guidance for your role:\n${instructions}` : prompt,
      agent: role.agent,
      execution: role.execution,
      route: role.route,
      // A role that cannot edit runs in Plan, whatever the crew's autonomy says.
      autonomy: roleAccess(role) === 'edit' ? config.autonomy : 'plan',
      helpers: helperChoiceFor(subAgentsFor(config, role.id, 0)),
      ...(role.model ? { model: role.model } : options.effortFrom && config.savings.lightModelForRoutine ? { effort: classifyWork(options.effortFrom).level } : {}),
      ...(options.fresh ? { freshSession: true } : {}),
    };
    try {
      return await this.ports.runAgent(request, active.ownerWindowId);
    } catch (error) {
      return { status: 'failed', output: '', error: error instanceof Error ? error.message : String(error) };
    }
  }
}
