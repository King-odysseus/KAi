import { describe, expect, it } from 'vitest';
import type {
  AgentRunRequest,
  AgentRunResult,
  ConversationRecord,
  WorkflowRun,
  WorkflowStartInput,
} from '../packages/contracts/src';
import { DesktopWorkflowRunner, type WorkflowRunnerPorts } from '../apps/desktop/src/main/workflow-runner';

function conversation(id: string, projectId = 'project-1'): ConversationRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id,
    projectId,
    title: 'Workflow',
    createdAt: now,
    updatedAt: now,
    archived: false,
    unread: false,
    activeAgent: null,
    route: null,
    autonomy: null,
    turns: [],
    events: [],
  };
}

function startInput(overrides: Partial<WorkflowStartInput> = {}): WorkflowStartInput {
  return {
    projectId: 'project-1',
    title: 'Ship safely',
    execution: 'api',
    route: 'proxy',
    model: 'deepseek-chat',
    autonomy: 'ask',
    steps: [
      { id: 'step-1', agent: 'codex', prompt: 'Inspect the project', label: 'Inspect' },
      { id: 'step-2', agent: 'codex', prompt: 'Implement the change', label: 'Implement' },
    ],
    ...overrides,
  };
}

function harness(overrides: Partial<WorkflowRunnerPorts> = {}): {
  runner: DesktopWorkflowRunner;
  records: Map<string, ConversationRecord>;
  notifications: Array<{ owner: number; run: WorkflowRun | null }>;
} {
  const records = new Map<string, ConversationRecord>();
  const notifications: Array<{ owner: number; run: WorkflowRun | null }> = [];
  let nextConversation = 1;
  const ports: WorkflowRunnerPorts = {
    listConversations: async () => [...records.values()],
    getConversation: async (id) => records.get(id) ?? null,
    saveConversation: async (value) => {
      records.set(value.id, structuredClone(value));
    },
    createConversation: async (projectId, firstPrompt) => {
      const value = conversation(`workflow-conversation-${nextConversation++}`, projectId);
      value.title = firstPrompt;
      records.set(value.id, value);
      return structuredClone(value);
    },
    runAgent: async (request) => ({
      conversation: records.get(request.conversationId) ?? conversation(request.conversationId),
      status: 'completed',
      output: `completed: ${request.prompt}`,
    }),
    runCheck: async () => ({ passed: true, exitCode: 0, output: 'ok' }),
    cancelAgent: () => false,
    notifyChanged: (owner, run) => notifications.push({ owner, run }),
    ...overrides,
  };
  return { runner: new DesktopWorkflowRunner(ports), records, notifications };
}

describe('desktop workflow runner', () => {
  it('owns execution in the main process, honors route settings, and completes each step once', async () => {
    const requests: AgentRunRequest[] = [];
    const { runner, records, notifications } = harness({
      runAgent: async (request) => {
        requests.push(request);
        return {
          conversation: records.get(request.conversationId) ?? conversation(request.conversationId),
          status: 'completed',
          output: `completed: ${request.prompt}`,
        };
      },
    });

    const started = await runner.start(startInput(), 11);
    await waitFor(async () => (await runner.list('project-1'))[0]?.workflow.status === 'completed');

    expect(requests.map((request) => request.prompt)).toEqual(['Inspect the project', 'Implement the change']);
    expect(requests.every((request) => request.execution === 'api' && request.route === 'proxy' && request.autonomy === 'ask')).toBe(true);
    expect(requests.every((request) => request.model === 'deepseek-chat')).toBe(true);
    expect(notifications.every((entry) => entry.owner === 11)).toBe(true);
    expect(records.get(started.conversationId)?.workflow).toMatchObject({
      status: 'completed',
      currentStepIndex: 1,
      steps: [{ status: 'completed' }, { status: 'completed' }],
    });
  });

  it('stops the active step and does not start later steps', async () => {
    let releaseFirst!: (value: AgentRunResult) => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    let cancelled = 0;
    const { runner } = harness({
      runAgent: async (request) => {
        firstStarted();
        return new Promise<AgentRunResult>((resolve) => {
          releaseFirst = (value) => resolve(value);
        });
      },
      cancelAgent: () => {
        cancelled += 1;
        releaseFirst({
          conversation: conversation('workflow-conversation-1'),
          status: 'failed',
          output: '',
          error: 'cancelled',
        });
        return true;
      },
    });

    const run = await runner.start(startInput(), 3);
    await started;
    const stopped = await runner.stop(run.workflow.id);

    expect(cancelled).toBe(1);
    expect(stopped.workflow).toMatchObject({
      status: 'aborted',
      steps: [{ status: 'failed', error: 'Stopped by the user.' }, { status: 'pending' }],
    });
  });

  it('resumes at the first unfinished step without replaying completed work', async () => {
    const record = conversation('workflow-conversation-existing');
    record.workflow = {
      id: 'workflow-existing',
      title: 'Recover',
      steps: [
        { id: 'done', agent: 'codex', prompt: 'Already done', status: 'completed', output: 'kept' },
        { id: 'failed', agent: 'codex', prompt: 'Retry this', status: 'failed', error: 'temporary' },
        { id: 'pending', agent: 'codex', prompt: 'Then this', status: 'pending' },
      ],
      execution: 'cli',
      route: 'direct',
      autonomy: 'ask',
      status: 'paused',
      currentStepIndex: 1,
      createdAt: new Date().toISOString(),
    };
    const prompts: string[] = [];
    const { runner, records } = harness({
      listConversations: async () => [...records.values()],
      runAgent: async (request) => {
        prompts.push(request.prompt);
        return {
          conversation: records.get(request.conversationId)!,
          status: 'completed',
          output: `completed: ${request.prompt}`,
        };
      },
    });
    records.set(record.id, structuredClone(record));

    const resumed = await runner.resume(record.workflow.id, 8);
    expect(resumed.workflow.currentStepIndex).toBe(1);
    await waitFor(async () => (await runner.list('project-1'))[0]?.workflow.status === 'completed');

    expect(prompts).toEqual(['Retry this', 'Then this']);
    expect(records.get(record.id)?.workflow?.steps[0]).toMatchObject({ status: 'completed', output: 'kept' });
  });

  it('repeats a bounded loop until its check passes', async () => {
    const prompts: string[] = [];
    let checks = 0;
    const { runner, records } = harness({
      runAgent: async (request) => {
        prompts.push(request.prompt);
        return {
          conversation: records.get(request.conversationId)!,
          status: 'completed',
          output: `completed: ${request.prompt}`,
        };
      },
      runCheck: async () => {
        checks += 1;
        return { passed: checks >= 2, exitCode: checks >= 2 ? 0 : 1, output: checks >= 2 ? 'passed' : 'failed' };
      },
    });

    const run = await runner.start(startInput({
      loop: { enabled: true, maxRounds: 4, maxCostUsd: 0, maxDurationMinutes: 30, checkCommand: 'npm test' },
    }), 4);
    await waitFor(async () => (await runner.list('project-1'))[0]?.workflow.status === 'completed');

    expect(prompts).toEqual(['Inspect the project', 'Implement the change', 'Inspect the project', 'Implement the change']);
    expect(checks).toBe(2);
    expect(records.get(run.conversationId)?.workflow?.loopProgress).toMatchObject({
      round: 2,
      lastCheckPassed: true,
      stopReason: 'passed',
    });
  });

  it('pauses at the round limit and does not replay beyond it on resume', async () => {
    let calls = 0;
    const { runner, records } = harness({
      runAgent: async (request) => {
        calls += 1;
        return {
          conversation: records.get(request.conversationId)!,
          status: 'completed',
          output: 'done',
        };
      },
      runCheck: async () => ({ passed: false, exitCode: 1, output: 'still failing' }),
    });
    const run = await runner.start(startInput({
      loop: { enabled: true, maxRounds: 2, maxCostUsd: 0, maxDurationMinutes: 30, checkCommand: 'npm test' },
    }), 5);
    await waitFor(async () => (await runner.list('project-1'))[0]?.workflow.status === 'paused');

    expect(calls).toBe(4);
    expect(records.get(run.conversationId)?.workflow?.loopProgress).toMatchObject({ round: 2, stopReason: 'max_rounds' });
    await expect(runner.resume(run.workflow.id, 5)).rejects.toThrow(/round limit/);
  });

  it('stops before a new round when the cost limit is reached', async () => {
    let calls = 0;
    const { runner, records } = harness({
      runAgent: async (request) => {
        calls += 1;
        return {
          conversation: records.get(request.conversationId)!,
          status: 'completed',
          output: 'done',
          costUsd: 0.6,
        };
      },
      runCheck: async () => ({ passed: false, exitCode: 1, output: 'failed' }),
    });
    const run = await runner.start(startInput({
      steps: [{ id: 'only', agent: 'codex', prompt: 'Work', label: 'Work' }],
      loop: { enabled: true, maxRounds: 5, maxCostUsd: 0.5, maxDurationMinutes: 30, checkCommand: 'npm test' },
    }), 6);
    await waitFor(async () => (await runner.list('project-1'))[0]?.workflow.status === 'paused');

    expect(calls).toBe(1);
    expect(records.get(run.conversationId)?.workflow?.loopProgress).toMatchObject({ costUsd: 0.6, stopReason: 'cost_limit' });
  });

  it('transfers a running workflow and its future updates when its owner window closes', async () => {
    let release!: (value: AgentRunResult) => void;
    let firstStarted!: () => void;
    let calls = 0;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const { runner, notifications } = harness({
      runAgent: async (request) => {
        if (calls++ > 0) {
          return {
            conversation: conversation(request.conversationId),
            status: 'completed',
            output: 'done',
          };
        }
        firstStarted();
        return new Promise<AgentRunResult>((resolve) => {
          release = () => resolve({
            conversation: conversation(request.conversationId),
            status: 'completed',
            output: 'done',
          });
        });
      },
    });

    const run = await runner.start(startInput(), 1);
    await started;
    await runner.ownerWindowClosed(1, 2);
    expect((await runner.list('project-1'))[0]?.workflow.status).toBe('running');
    release();
    await waitFor(async () => (await runner.list('project-1'))[0]?.workflow.status === 'completed');

    expect(notifications.some((entry) => entry.owner === 2 && entry.run?.workflow.id === run.workflow.id)).toBe(true);
    const transferredIndex = notifications.findIndex((entry) => entry.owner === 2);
    expect(notifications.slice(transferredIndex).some((entry) => entry.owner === 1)).toBe(false);
  });
});

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for workflow state.');
}
