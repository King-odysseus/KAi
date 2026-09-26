import * as crypto from 'node:crypto';
import { stepAccess } from '@kai/contracts';
import type {
  AgentRunRequest,
  AgentRunResult,
  ConversationRecord,
  Workflow,
  WorkflowLoopProgress,
  WorkflowRun,
  WorkflowStartInput,
  WorkflowStep,
} from '@kai/contracts';
import { buildFixPrompt, handoffSection, parseVerdict, routeFailure } from './team-plan';

export interface WorkflowCheckResult {
  passed: boolean;
  exitCode: number | null;
  output: string;
}

export interface WorkflowRunnerPorts {
  listConversations(): Promise<ConversationRecord[]>;
  getConversation(id: string): Promise<ConversationRecord | null>;
  saveConversation(conversation: ConversationRecord): Promise<void>;
  createConversation(projectId: string, firstPrompt: string): Promise<ConversationRecord>;
  runAgent(request: AgentRunRequest, ownerWindowId: number): Promise<AgentRunResult>;
  runCheck(projectId: string, command: string, signal: AbortSignal): Promise<WorkflowCheckResult>;
  cancelAgent(conversationId: string): boolean;
  notifyChanged(ownerWindowId: number, run: WorkflowRun | null): void;
}

interface ActiveWorkflow {
  ownerWindowId: number;
  conversationId: string;
  cancelled: boolean;
  controller: AbortController;
  done: Promise<void>;
}

type StepOutcome = 'completed' | 'failed' | 'stopped' | 'blocked';

/** Main-process workflow ownership. Renderer navigation never owns or drives a running workflow. */
export class DesktopWorkflowRunner {
  private readonly active = new Map<string, ActiveWorkflow>();

  constructor(private readonly ports: WorkflowRunnerPorts) {}

  async list(projectId?: string): Promise<WorkflowRun[]> {
    const conversations = await this.ports.listConversations();
    return conversations
      .filter((conversation) => conversation.workflow && (!projectId || conversation.projectId === projectId))
      .map((conversation) => runFor(conversation))
      .sort((left, right) => right.workflow.createdAt.localeCompare(left.workflow.createdAt));
  }

  async start(input: WorkflowStartInput, ownerWindowId: number): Promise<WorkflowRun> {
    const conversation = await this.ports.createConversation(input.projectId, `Workflow: ${input.title}`);
    const loop = input.loop ?? { enabled: false, maxRounds: 3, maxCostUsd: 0, maxDurationMinutes: 30, checkCommand: '' };
    const workflow: Workflow = {
      id: `workflow_${crypto.randomUUID()}`,
      title: input.title,
      steps: input.steps.map((step, index): WorkflowStep => ({
        id: step.id,
        agent: step.agent,
        prompt: step.prompt,
        label: step.label ?? `Step ${index + 1}`,
        ...(step.dependsOn?.length ? { dependsOn: step.dependsOn } : {}),
        ...(step.role ? { role: step.role } : {}),
        ...(step.access ? { access: step.access } : {}),
        ...(step.execution ? { execution: step.execution } : {}),
        ...(step.route ? { route: step.route } : {}),
        ...(step.autonomy ? { autonomy: step.autonomy } : {}),
        ...(step.model ? { model: step.model } : {}),
        ...(step.gate ? { gate: step.gate } : {}),
        ...(step.paths?.length ? { paths: step.paths } : {}),
        status: 'pending',
      })),
      execution: input.execution,
      route: input.route,
      ...(input.model?.trim() ? { model: input.model.trim() } : {}),
      autonomy: input.autonomy,
      loop,
      ...(input.teamCheck
        ? { teamCheck: { command: input.teamCheck.command, maxRounds: input.teamCheck.maxRounds, round: 0, lastPassed: null, lastOutput: '' } }
        : {}),
      ...(loop.enabled
        ? {
            loopProgress: {
              round: 1,
              maxRounds: loop.maxRounds,
              startedAt: new Date().toISOString(),
              elapsedMs: 0,
              costUsd: 0,
              lastCheckPassed: null,
              lastCheckOutput: '',
            } satisfies WorkflowLoopProgress,
          }
        : {}),
      status: 'running',
      currentStepIndex: 0,
      createdAt: new Date().toISOString(),
    };
    conversation.workflow = workflow;
    conversation.activeAgent = input.steps[0]?.agent ?? conversation.activeAgent;
    conversation.execution = input.execution;
    conversation.route = input.route;
    conversation.autonomy = input.autonomy;
    await this.ports.saveConversation(conversation);
    const active: ActiveWorkflow = {
      ownerWindowId,
      conversationId: conversation.id,
      cancelled: false,
      controller: new AbortController(),
      done: Promise.resolve(),
    };
    this.active.set(workflow.id, active);
    const run = runFor(conversation);
    this.ports.notifyChanged(ownerWindowId, run);
    active.done = this.trackExecution(workflow.id, active, conversation.id, input.execution, null);
    return run;
  }

  async stop(workflowId: string, ownerWindowId?: number): Promise<WorkflowRun> {
    const active = this.active.get(workflowId);
    if (active) {
      active.cancelled = true;
      active.controller.abort(new Error('The workflow was stopped.'));
      this.ports.cancelAgent(active.conversationId);
      await active.done.catch(() => undefined);
    }
    const conversation = await this.findConversationForWorkflow(workflowId);
    if (!conversation) throw new Error('Workflow not found.');
    // A job waiting on a blocked security review has nothing running, but "Stop" must still end it.
    const awaitingDecision = conversation.workflow?.status === 'paused'
      && conversation.workflow.steps.some((step) => step.verdict?.result === 'block' && !step.verdict.acknowledged);
    if (conversation.workflow?.status === 'running' || (conversation.workflow && awaitingDecision)) {
      conversation.workflow.status = 'aborted';
      conversation.workflow.steps = conversation.workflow.steps.map((step) => step.status === 'running'
        ? { ...step, status: 'failed', error: 'Stopped by the user.', completedAt: new Date().toISOString() }
        : step);
      if (conversation.workflow.loopProgress) conversation.workflow.loopProgress.stopReason = 'stopped';
      conversation.updatedAt = new Date().toISOString();
      await this.ports.saveConversation(conversation);
    }
    this.active.delete(workflowId);
    const notifyOwner = active?.ownerWindowId ?? ownerWindowId;
    const run = runFor(conversation);
    if (notifyOwner !== undefined) this.ports.notifyChanged(notifyOwner, run);
    return run;
  }

  /** Resume is explicit. Completed non-loop steps are never replayed; a paused loop starts its next bounded round. */
  async resume(workflowId: string, ownerWindowId: number): Promise<WorkflowRun> {
    if (this.active.has(workflowId)) throw new Error('This workflow is already running.');
    const conversation = await this.findConversationForWorkflow(workflowId);
    if (!conversation?.workflow) throw new Error('Workflow not found.');
    if (conversation.workflow.status === 'completed') throw new Error('This workflow is already complete.');
    const loop = conversation.workflow.loop ?? { enabled: false, maxRounds: 3, maxCostUsd: 0, maxDurationMinutes: 30, checkCommand: '' };
    // "Continue anyway" on a blocked security review: remember the decision so the workflow does not ask again.
    const unacknowledged = (step: WorkflowStep): boolean => step.verdict?.result === 'block' && !step.verdict.acknowledged;
    const acknowledgedGate = conversation.workflow.steps.some(unacknowledged);
    conversation.workflow.steps = conversation.workflow.steps.map((step) => (
      step.verdict && unacknowledged(step) ? { ...step, verdict: { ...step.verdict, acknowledged: true } } : step
    ));
    let resumeIndex = conversation.workflow.steps.findIndex((step) => step.status !== 'completed');
    const teamCheck = conversation.workflow.teamCheck;
    if (resumeIndex < 0 && teamCheck && (acknowledgedGate || teamCheck.lastPassed === false) && !(loop.enabled && conversation.workflow.loopProgress)) {
      // Every step is done but the check has not passed: either it never ran (the user just continued past a
      // blocked review) or it failed and used its rounds. Run it, with one more fix round if it had failed.
      conversation.workflow.teamCheck = teamCheck.lastPassed === false
        ? { ...teamCheck, maxRounds: teamCheck.round + 1, stopReason: undefined }
        : teamCheck;
      conversation.workflow.status = 'running';
      conversation.updatedAt = new Date().toISOString();
      await this.ports.saveConversation(conversation);
      const extra: ActiveWorkflow = {
        ownerWindowId,
        conversationId: conversation.id,
        cancelled: false,
        controller: new AbortController(),
        done: Promise.resolve(),
      };
      this.active.set(workflowId, extra);
      const run = runFor(conversation);
      this.ports.notifyChanged(ownerWindowId, run);
      extra.done = this.trackExecution(workflowId, extra, conversation.id, conversation.execution ?? 'cli', conversation.workflow.steps.length);
      return run;
    }
    if (resumeIndex < 0 && acknowledgedGate && !(loop.enabled && conversation.workflow.loopProgress)) {
      // The blocked review was the last step: continuing means the job is finished.
      conversation.updatedAt = new Date().toISOString();
      await this.ports.saveConversation(conversation);
      await this.complete(conversation.id);
      const finished = await this.ports.getConversation(conversation.id);
      const run = runFor(finished ?? conversation);
      this.ports.notifyChanged(ownerWindowId, run);
      return run;
    }
    if (loop.enabled && conversation.workflow.loopProgress) {
      const nextRound = conversation.workflow.loopProgress.round + 1;
      if (nextRound > loop.maxRounds) throw new Error(`The ${loop.maxRounds}-round limit was reached. Raise the round limit before resuming.`);
      conversation.workflow.steps = conversation.workflow.steps.map((step) => ({
        ...step,
        status: 'pending',
        error: undefined,
        output: undefined,
        verdict: undefined,
        startedAt: undefined,
        completedAt: undefined,
      }));
      conversation.workflow.loopProgress = {
        ...conversation.workflow.loopProgress,
        round: nextRound,
        elapsedMs: Date.now() - new Date(conversation.workflow.loopProgress.startedAt).getTime(),
        stopReason: undefined,
        lastCheckPassed: null,
        lastCheckOutput: '',
      };
      resumeIndex = 0;
    }
    if (resumeIndex < 0) throw new Error('There are no remaining workflow steps.');
    const execution = conversation.execution ?? 'cli';
    conversation.workflow.status = 'running';
    conversation.workflow.currentStepIndex = resumeIndex;
    conversation.workflow.steps = conversation.workflow.steps.map((step, index) => index === resumeIndex
      ? { ...step, status: 'pending', error: undefined }
      : step);
    conversation.updatedAt = new Date().toISOString();
    await this.ports.saveConversation(conversation);
    const active: ActiveWorkflow = {
      ownerWindowId,
      conversationId: conversation.id,
      cancelled: false,
      controller: new AbortController(),
      done: Promise.resolve(),
    };
    this.active.set(workflowId, active);
    const run = runFor(conversation);
    this.ports.notifyChanged(ownerWindowId, run);
    active.done = this.trackExecution(workflowId, active, conversation.id, execution, loop.enabled ? null : resumeIndex);
    return run;
  }

  isActive(workflowId: string): boolean {
    return this.active.has(workflowId);
  }

  async ownerWindowClosed(windowId: number, replacementWindowId: number | null): Promise<void> {
    const owned = [...this.active.entries()].filter(([, active]) => active.ownerWindowId === windowId);
    for (const [workflowId, active] of owned) {
      if (replacementWindowId === null) {
        await this.stop(workflowId).catch(() => undefined);
        continue;
      }
      active.ownerWindowId = replacementWindowId;
      const conversation = await this.ports.getConversation(active.conversationId);
      if (conversation?.workflow) this.ports.notifyChanged(replacementWindowId, runFor(conversation));
    }
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.active.keys()].map((workflowId) => this.stop(workflowId).catch(() => undefined)));
  }

  private async trackExecution(
    workflowId: string,
    active: ActiveWorkflow,
    conversationId: string,
    execution: 'cli' | 'api',
    startIndex: number | null,
  ): Promise<void> {
    try {
      await this.execute(conversationId, execution, active, startIndex);
    } finally {
      if (this.active.get(workflowId) === active) this.active.delete(workflowId);
    }
  }

  private async execute(
    conversationId: string,
    execution: 'cli' | 'api',
    active: ActiveWorkflow,
    startIndex: number | null,
  ): Promise<void> {
    let conversation = await this.ports.getConversation(conversationId);
    if (!conversation?.workflow) return;
    const loop = conversation.workflow.loop ?? { enabled: false, maxRounds: 3, maxCostUsd: 0, maxDurationMinutes: 30, checkCommand: '' };
    if (!loop.enabled) {
      const outcome = await this.executeSteps(conversationId, execution, active, startIndex ?? conversation.workflow.currentStepIndex);
      if (outcome === 'completed') {
        if (conversation.workflow.teamCheck) await this.verifyTeam(conversationId, execution, active);
        else await this.complete(conversationId);
      }
      return;
    }

    const startedAt = conversation.workflow.loopProgress?.startedAt ?? new Date().toISOString();
    let progress: WorkflowLoopProgress = conversation.workflow.loopProgress ?? {
      round: 1,
      maxRounds: loop.maxRounds,
      startedAt,
      elapsedMs: 0,
      costUsd: 0,
      lastCheckPassed: null,
      lastCheckOutput: '',
    };
    for (let round = progress.round; round <= loop.maxRounds; round += 1) {
      if (active.cancelled) return;
      const elapsedMs = Date.now() - new Date(startedAt).getTime();
      if (elapsedMs >= loop.maxDurationMinutes * 60_000) {
        await this.pauseLoop(conversationId, { ...progress, round, elapsedMs, stopReason: 'time_limit' }, 'The workflow loop reached its time limit.');
        return;
      }
      if (loop.maxCostUsd > 0 && progress.costUsd >= loop.maxCostUsd) {
        await this.pauseLoop(conversationId, { ...progress, round, elapsedMs, stopReason: 'cost_limit' }, 'The workflow loop reached its cost limit.');
        return;
      }
      conversation = await this.ports.getConversation(conversationId);
      if (!conversation?.workflow) return;
      conversation.workflow.steps = conversation.workflow.steps.map((step) => ({
        ...step,
        status: 'pending',
        error: undefined,
        output: undefined,
        verdict: undefined,
        startedAt: undefined,
        completedAt: undefined,
      }));
      progress = { ...progress, round, elapsedMs, maxRounds: loop.maxRounds, stopReason: undefined };
      conversation.workflow.loopProgress = progress;
      conversation.workflow.currentStepIndex = 0;
      conversation.workflow.status = 'running';
      conversation.updatedAt = new Date().toISOString();
      await this.ports.saveConversation(conversation);
      this.ports.notifyChanged(active.ownerWindowId, runFor(conversation));
      const outcome = await this.executeSteps(conversationId, execution, active, 0, (cost) => {
        progress = { ...progress, costUsd: progress.costUsd + cost, elapsedMs: Date.now() - new Date(startedAt).getTime() };
      });
      if (outcome !== 'completed') return;
      if (!loop.checkCommand.trim()) {
        await this.complete(conversationId, progress, 'passed');
        return;
      }
      let check: WorkflowCheckResult;
      try {
        check = await this.ports.runCheck(conversation.projectId ?? '', loop.checkCommand, active.controller.signal);
      } catch (error) {
        if (active.controller.signal.aborted) return;
        check = { passed: false, exitCode: null, output: error instanceof Error ? error.message : String(error) };
      }
      progress = {
        ...progress,
        elapsedMs: Date.now() - new Date(startedAt).getTime(),
        lastCheckPassed: check.passed,
        lastCheckOutput: check.output.slice(-4_000),
      };
      if (check.passed) {
        await this.complete(conversationId, progress, 'passed');
        return;
      }
      if (round >= loop.maxRounds) {
        await this.pauseLoop(conversationId, { ...progress, stopReason: 'max_rounds' }, `Check failed after ${round} round${round === 1 ? '' : 's'}.`);
        return;
      }
      await this.pauseLoop(conversationId, progress, '');
    }
  }

  private async executeSteps(
    conversationId: string,
    execution: 'cli' | 'api',
    active: ActiveWorkflow,
    startIndex: number,
    onCost?: (costUsd: number) => void,
  ): Promise<StepOutcome> {
    let conversation = await this.ports.getConversation(conversationId);
    if (!conversation?.workflow) return 'stopped';
    for (let index = startIndex; index < conversation.workflow.steps.length; index += 1) {
      if (active.cancelled) return 'stopped';
      conversation = await this.ports.getConversation(conversationId);
      if (!conversation?.workflow) return 'stopped';
      const current = conversation.workflow.steps[index];
      if (!current || current.status === 'completed') continue;
      const startedAt = new Date().toISOString();
      conversation.workflow.currentStepIndex = index;
      conversation.workflow.status = 'running';
      conversation.workflow.steps[index] = { ...current, status: 'running', startedAt, error: undefined };
      conversation.updatedAt = startedAt;
      await this.ports.saveConversation(conversation);
      this.ports.notifyChanged(active.ownerWindowId, runFor(conversation));

      // A team part follows its own agent, route and access, and sees what its dependencies produced.
      const allSteps = conversation.workflow.steps;
      const earlier = (current.dependsOn ?? []).flatMap((id) => {
        const dependency = allSteps.find((step) => step.id === id);
        return dependency?.status === 'completed'
          ? [{ label: dependency.label ?? dependency.id, agent: dependency.agent, output: dependency.output }]
          : [];
      });
      const stepModel = current.model ?? conversation.workflow.model;
      let result: AgentRunResult;
      try {
        result = await this.ports.runAgent({
          conversationId,
          prompt: `${current.prompt}${handoffSection(earlier)}`,
          agent: current.agent,
          execution: current.execution ?? execution,
          route: current.route ?? conversation.workflow.route,
          autonomy: current.autonomy ?? conversation.workflow.autonomy,
          ...(stepModel ? { model: stepModel } : {}),
          ...(current.role ? { freshSession: true } : {}),
        }, active.ownerWindowId);
      } catch (error) {
        result = {
          conversation,
          status: 'failed',
          output: '',
          error: error instanceof Error ? error.message : String(error),
        };
      }
      if (result.costUsd) onCost?.(result.costUsd);
      if (active.cancelled) return 'stopped';
      conversation = await this.ports.getConversation(conversationId) ?? result.conversation;
      if (!conversation.workflow) return 'stopped';
      const failed = result.status === 'failed' || Boolean(result.error);
      // A security review that blocks stops the job and waits for the user; passing lets it carry on.
      const verdict = !failed && current.gate === 'security' ? parseVerdict(result.output) : undefined;
      const blocked = verdict?.result === 'block';
      conversation.workflow.steps[index] = {
        ...conversation.workflow.steps[index]!,
        status: failed ? 'failed' : 'completed',
        output: result.output,
        ...(verdict ? { verdict: { ...verdict, acknowledged: false } } : {}),
        ...(result.error ? { error: result.error } : {}),
        completedAt: new Date().toISOString(),
      };
      conversation.workflow.status = failed || blocked ? 'paused' : 'running';
      conversation.updatedAt = new Date().toISOString();
      await this.ports.saveConversation(conversation);
      this.ports.notifyChanged(active.ownerWindowId, runFor(conversation));
      if (failed) return 'failed';
      if (blocked) return 'blocked';
    }
    return 'completed';
  }

  /**
   * Runs a team job's check. On failure the output is matched to the parts that own the files it names, and only
   * those parts run again with the failure in front of them, until it passes or the fix rounds run out.
   */
  private async verifyTeam(conversationId: string, execution: 'cli' | 'api', active: ActiveWorkflow): Promise<void> {
    for (;;) {
      if (active.cancelled) return;
      const conversation = await this.ports.getConversation(conversationId);
      const workflow = conversation?.workflow;
      const check = workflow?.teamCheck;
      if (!conversation || !workflow || !check) {
        await this.complete(conversationId);
        return;
      }
      let result: WorkflowCheckResult;
      try {
        result = await this.ports.runCheck(conversation.projectId ?? '', check.command, active.controller.signal);
      } catch (error) {
        if (active.controller.signal.aborted) return;
        result = { passed: false, exitCode: null, output: error instanceof Error ? error.message : String(error) };
      }
      const reported = { ...check, lastPassed: result.passed, lastOutput: result.output.slice(-4_000) };
      const finish = async (teamCheck: typeof check, status: 'paused' | 'complete'): Promise<void> => {
        workflow.teamCheck = teamCheck;
        if (status === 'paused') workflow.status = 'paused';
        conversation.updatedAt = new Date().toISOString();
        await this.ports.saveConversation(conversation);
        if (status === 'complete') await this.complete(conversationId);
        else this.ports.notifyChanged(active.ownerWindowId, runFor(conversation));
      };
      if (result.passed) {
        await finish({ ...reported, stopReason: 'passed' }, 'complete');
        return;
      }

      const owners = workflow.steps
        .filter((step) => !step.fixOf && step.role && stepAccess(step) === 'edit')
        .map((step) => ({ step, id: step.id, role: step.role ?? '', paths: step.paths ?? [] }));
      const route = routeFailure(result.output, owners);
      const round = check.round + 1;
      const fixes = route.ownerIds.flatMap((id) => {
        const owner = owners.find((candidate) => candidate.id === id)?.step;
        if (!owner) return [];
        const fix: WorkflowStep = {
          ...owner,
          id: `fix-${round}-${owner.id}`,
          label: `Fix round ${round}: ${owner.label ?? owner.id}`,
          prompt: buildFixPrompt(owner.prompt, check.command, round, result.output),
          dependsOn: [owner.id],
          fixOf: owner.id,
          round,
          status: 'pending',
          output: undefined,
          error: undefined,
          verdict: undefined,
          startedAt: undefined,
          completedAt: undefined,
        };
        return [fix];
      });
      // Out of rounds, nothing to send it to, or no room left in the plan: stop and let the user decide.
      if (check.round >= check.maxRounds || fixes.length === 0 || workflow.steps.length + fixes.length > 50) {
        await finish({ ...reported, stopReason: 'max_rounds' }, 'paused');
        return;
      }

      const firstFix = workflow.steps.length;
      workflow.steps = [...workflow.steps, ...fixes];
      workflow.teamCheck = { ...reported, round, stopReason: undefined };
      workflow.status = 'running';
      workflow.currentStepIndex = firstFix;
      conversation.updatedAt = new Date().toISOString();
      await this.ports.saveConversation(conversation);
      this.ports.notifyChanged(active.ownerWindowId, runFor(conversation));
      const outcome = await this.executeSteps(conversationId, execution, active, firstFix);
      if (outcome !== 'completed') return;
    }
  }

  private async complete(conversationId: string, progress?: WorkflowLoopProgress, stopReason?: WorkflowLoopProgress['stopReason']): Promise<void> {
    const conversation = await this.ports.getConversation(conversationId);
    if (!conversation?.workflow) return;
    conversation.workflow.status = 'completed';
    conversation.workflow.completedAt = new Date().toISOString();
    if (progress) conversation.workflow.loopProgress = { ...progress, stopReason };
    conversation.updatedAt = new Date().toISOString();
    await this.ports.saveConversation(conversation);
    this.ports.notifyChanged(this.active.get(conversation.workflow.id)?.ownerWindowId ?? 0, runFor(conversation));
  }

  private async pauseLoop(conversationId: string, progress: WorkflowLoopProgress, error: string): Promise<void> {
    const conversation = await this.ports.getConversation(conversationId);
    if (!conversation?.workflow) return;
    conversation.workflow.status = 'paused';
    conversation.workflow.loopProgress = progress;
    if (error) {
      const index = Math.max(0, conversation.workflow.steps.length - 1);
      const step = conversation.workflow.steps[index];
      if (step) conversation.workflow.steps[index] = { ...step, error };
    }
    conversation.updatedAt = new Date().toISOString();
    await this.ports.saveConversation(conversation);
    this.ports.notifyChanged(this.active.get(conversation.workflow.id)?.ownerWindowId ?? 0, runFor(conversation));
  }

  private async findConversationForWorkflow(workflowId: string): Promise<ConversationRecord | null> {
    return (await this.ports.listConversations()).find((conversation) => conversation.workflow?.id === workflowId) ?? null;
  }
}

function runFor(conversation: ConversationRecord): WorkflowRun {
  if (!conversation.workflow) throw new Error(`Conversation ${conversation.id} has no workflow.`);
  return {
    conversationId: conversation.id,
    projectId: conversation.projectId,
    workflow: conversation.workflow,
  };
}
