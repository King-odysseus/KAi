import * as crypto from 'node:crypto';
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

type StepOutcome = 'completed' | 'failed' | 'stopped';

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
        status: 'pending',
      })),
      execution: input.execution,
      route: input.route,
      ...(input.model?.trim() ? { model: input.model.trim() } : {}),
      autonomy: input.autonomy,
      loop,
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
    if (conversation.workflow?.status === 'running') {
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
    let resumeIndex = conversation.workflow.steps.findIndex((step) => step.status !== 'completed');
    if (loop.enabled && conversation.workflow.loopProgress) {
      const nextRound = conversation.workflow.loopProgress.round + 1;
      if (nextRound > loop.maxRounds) throw new Error(`The ${loop.maxRounds}-round limit was reached. Raise the round limit before resuming.`);
      conversation.workflow.steps = conversation.workflow.steps.map((step) => ({
        ...step,
        status: 'pending',
        error: undefined,
        output: undefined,
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
      if (outcome === 'completed') await this.complete(conversationId);
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

      let result: AgentRunResult;
      try {
        result = await this.ports.runAgent({
          conversationId,
          prompt: current.prompt,
          agent: current.agent,
          execution,
          route: conversation.workflow.route,
          autonomy: conversation.workflow.autonomy,
          ...(conversation.workflow.model ? { model: conversation.workflow.model } : {}),
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
      conversation.workflow.steps[index] = {
        ...conversation.workflow.steps[index]!,
        status: failed ? 'failed' : 'completed',
        output: result.output,
        ...(result.error ? { error: result.error } : {}),
        completedAt: new Date().toISOString(),
      };
      conversation.workflow.status = failed ? 'paused' : 'running';
      conversation.updatedAt = new Date().toISOString();
      await this.ports.saveConversation(conversation);
      this.ports.notifyChanged(active.ownerWindowId, runFor(conversation));
      if (failed) return 'failed';
    }
    return 'completed';
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
