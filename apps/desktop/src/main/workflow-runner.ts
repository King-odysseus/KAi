import * as crypto from 'node:crypto';
import type {
  AgentRunRequest,
  AgentRunResult,
  ConversationRecord,
  Workflow,
  WorkflowRun,
  WorkflowStartInput,
  WorkflowStep,
} from '@kai/contracts';

export interface WorkflowRunnerPorts {
  listConversations(): Promise<ConversationRecord[]>;
  getConversation(id: string): Promise<ConversationRecord | null>;
  saveConversation(conversation: ConversationRecord): Promise<void>;
  createConversation(projectId: string, firstPrompt: string): Promise<ConversationRecord>;
  runAgent(request: AgentRunRequest, ownerWindowId: number): Promise<AgentRunResult>;
  cancelAgent(conversationId: string): boolean;
  notifyChanged(ownerWindowId: number, run: WorkflowRun | null): void;
}

interface ActiveWorkflow {
  ownerWindowId: number;
  conversationId: string;
  cancelled: boolean;
  done: Promise<void>;
}

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
    const active: ActiveWorkflow = { ownerWindowId, conversationId: conversation.id, cancelled: false, done: Promise.resolve() };
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
      conversation.updatedAt = new Date().toISOString();
      await this.ports.saveConversation(conversation);
    }
    this.active.delete(workflowId);
    const notifyOwner = active?.ownerWindowId ?? ownerWindowId;
    const run = runFor(conversation);
    if (notifyOwner !== undefined) this.ports.notifyChanged(notifyOwner, run);
    return run;
  }

  /** Resume is explicit and starts at the first failed or pending step; completed steps are never replayed. */
  async resume(workflowId: string, ownerWindowId: number): Promise<WorkflowRun> {
    if (this.active.has(workflowId)) throw new Error('This workflow is already running.');
    const conversation = await this.findConversationForWorkflow(workflowId);
    if (!conversation?.workflow) throw new Error('Workflow not found.');
    if (conversation.workflow.status === 'completed') throw new Error('This workflow is already complete.');
    const resumeIndex = conversation.workflow.steps.findIndex((step) => step.status !== 'completed');
    if (resumeIndex < 0) throw new Error('There are no remaining workflow steps.');
    const execution = conversation.execution ?? 'cli';
    conversation.workflow.status = 'running';
    conversation.workflow.currentStepIndex = resumeIndex;
    conversation.workflow.steps = conversation.workflow.steps.map((step, index) => index === resumeIndex
      ? { ...step, status: 'pending', error: undefined }
      : step);
    conversation.updatedAt = new Date().toISOString();
    await this.ports.saveConversation(conversation);
    const active: ActiveWorkflow = { ownerWindowId, conversationId: conversation.id, cancelled: false, done: Promise.resolve() };
    this.active.set(workflowId, active);
    const run = runFor(conversation);
    this.ports.notifyChanged(ownerWindowId, run);
    active.done = this.trackExecution(workflowId, active, conversation.id, execution, resumeIndex);
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
    const workflowId = conversation.workflow.id;
    let index = startIndex ?? conversation.workflow.currentStepIndex;
    for (; index < conversation.workflow.steps.length; index += 1) {
      if (active.cancelled) break;
      conversation = await this.ports.getConversation(conversationId);
      if (!conversation?.workflow) break;
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

      if (active.cancelled) break;
      conversation = await this.ports.getConversation(conversationId) ?? result.conversation;
      if (!conversation.workflow) break;
      const failed = result.status === 'failed' || Boolean(result.error);
      conversation.workflow.steps[index] = {
        ...conversation.workflow.steps[index]!,
        status: failed ? 'failed' : 'completed',
        output: result.output,
        ...(result.error ? { error: result.error } : {}),
        completedAt: new Date().toISOString(),
      };
      if (failed) {
        conversation.workflow.status = 'paused';
      } else if (conversation.workflow.steps.every((step) => step.status === 'completed')) {
        conversation.workflow.status = 'completed';
        conversation.workflow.completedAt = new Date().toISOString();
      }
      conversation.updatedAt = new Date().toISOString();
      await this.ports.saveConversation(conversation);
      this.ports.notifyChanged(active.ownerWindowId, runFor(conversation));
      if (failed) break;
    }
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
