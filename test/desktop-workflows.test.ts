import { afterEach, describe, expect, it, vi } from 'vitest';
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
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it('pauses before a new round when the time limit is reached', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T10:00:00.000Z'));
    let calls = 0;
    const { runner, records } = harness({
      runAgent: async (request) => {
        calls += 1;
        vi.setSystemTime(new Date('2026-09-24T10:01:01.000Z'));
        return {
          conversation: records.get(request.conversationId)!,
          status: 'completed',
          output: 'done',
        };
      },
      runCheck: async () => ({ passed: false, exitCode: 1, output: 'still failing' }),
    });

    try {
      const run = await runner.start(startInput({
        steps: [{ id: 'only', agent: 'codex', prompt: 'Work', label: 'Work' }],
        loop: { enabled: true, maxRounds: 5, maxCostUsd: 0, maxDurationMinutes: 1, checkCommand: 'npm test' },
      }), 7);
      await vi.runAllTimersAsync();

      expect(calls).toBe(1);
      expect(records.get(run.conversationId)?.workflow?.loopProgress).toMatchObject({
        round: 2,
        elapsedMs: 61_000,
        stopReason: 'time_limit',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs a team step with its own agent, route and access, a fresh session, and what its dependencies produced', async () => {
    const requests: AgentRunRequest[] = [];
    const { runner } = harness({
      runAgent: async (request) => {
        requests.push(request);
        return { conversation: conversation(request.conversationId), status: 'completed', output: `output of ${request.agent}` };
      },
    });

    await runner.start(startInput({
      execution: 'cli',
      route: 'direct',
      model: undefined,
      autonomy: 'autoEdit',
      steps: [
        { id: 'api', agent: 'codex', prompt: 'Build the API', label: 'Backend: API', role: 'backend' },
        { id: 'review', agent: 'claude', prompt: 'Review it', label: 'Code review', role: 'codeReviewer', dependsOn: ['api'], route: 'proxy', autonomy: 'plan', execution: 'api', model: 'deepseek-chat' },
      ],
    }), 1);
    await waitFor(async () => (await runner.list('project-1'))[0]?.workflow.status === 'completed');

    expect(requests[0]).toMatchObject({ agent: 'codex', execution: 'cli', route: 'direct', autonomy: 'autoEdit', freshSession: true });
    expect(requests[0]!.prompt).toBe('Build the API');
    expect(requests[1]).toMatchObject({ agent: 'claude', execution: 'api', route: 'proxy', autonomy: 'plan', model: 'deepseek-chat', freshSession: true });
    expect(requests[1]!.prompt).toContain('Review it');
    expect(requests[1]!.prompt).toContain('### Backend: API (codex)\noutput of codex');
  });

  it('leaves an ordinary workflow step exactly as before: no hand-off and a resumable session', async () => {
    const requests: AgentRunRequest[] = [];
    const { runner } = harness({
      runAgent: async (request) => {
        requests.push(request);
        return { conversation: conversation(request.conversationId), status: 'completed', output: 'done' };
      },
    });

    await runner.start(startInput(), 1);
    await waitFor(async () => (await runner.list('project-1'))[0]?.workflow.status === 'completed');

    expect(requests.map((request) => request.prompt)).toEqual(['Inspect the project', 'Implement the change']);
    expect(requests.every((request) => request.freshSession === undefined)).toBe(true);
  });

  function gatedInput(): WorkflowStartInput {
    return startInput({
      execution: 'cli',
      route: 'direct',
      autonomy: 'autoEdit',
      steps: [
        { id: 'code', agent: 'codex', prompt: 'Write it', role: 'backend' },
        { id: 'security', agent: 'claude', prompt: 'Review it', role: 'securityReviewer', gate: 'security', dependsOn: ['code'], autonomy: 'plan' },
        { id: 'docs', agent: 'kimi', prompt: 'Document it', role: 'docs' },
      ],
    });
  }

  it('stops and asks when the security review blocks, then carries on once the user continues', async () => {
    const prompts: string[] = [];
    const { runner } = harness({
      runAgent: async (request) => {
        prompts.push(request.prompt.split('\n')[0]!);
        const output = request.agent === 'claude' ? 'Found a committed key.\nVERDICT: BLOCK - the API key is in the repo' : 'ok';
        return { conversation: conversation(request.conversationId), status: 'completed', output };
      },
    });

    const run = await runner.start(gatedInput(), 4);
    await waitFor(async () => (await runner.list('project-1'))[0]?.workflow.status === 'paused');

    const paused = (await runner.list('project-1'))[0]!.workflow;
    expect(paused.steps.map((step) => step.status)).toEqual(['completed', 'completed', 'pending']);
    expect(paused.steps[1]!.verdict).toEqual({ result: 'block', reason: 'the API key is in the repo', acknowledged: false });
    expect(prompts).not.toContain('Document it');
    expect(runner.isActive(run.workflow.id)).toBe(false);

    await runner.resume(run.workflow.id, 4);
    await waitFor(async () => (await runner.list('project-1'))[0]?.workflow.status === 'completed');
    const finished = (await runner.list('project-1'))[0]!.workflow;
    expect(finished.steps[1]!.verdict).toMatchObject({ result: 'block', acknowledged: true });
    expect(prompts).toContain('Document it');
    // The reviewer was not run a second time: continuing means carrying on, not reviewing again.
    expect(prompts.filter((prompt) => prompt === 'Review it')).toHaveLength(1);
  });

  it('ends a job that is waiting on a blocked security review when the user chooses Stop', async () => {
    const { runner } = harness({
      runAgent: async (request) => ({
        conversation: conversation(request.conversationId),
        status: 'completed',
        output: request.agent === 'claude' ? 'VERDICT: BLOCK - exposed secret' : 'ok',
      }),
    });

    const run = await runner.start(gatedInput(), 4);
    await waitFor(async () => (await runner.list('project-1'))[0]?.workflow.status === 'paused');

    const stopped = await runner.stop(run.workflow.id);

    expect(stopped.workflow.status).toBe('aborted');
    expect(stopped.workflow.steps.map((step) => step.status)).toEqual(['completed', 'completed', 'pending']);
  });

  it('lets the job carry on without asking when the security review passes', async () => {
    const { runner } = harness({
      runAgent: async (request) => ({
        conversation: conversation(request.conversationId),
        status: 'completed',
        output: request.agent === 'claude' ? 'Nothing serious.\nVERDICT: PASS' : 'ok',
      }),
    });

    await runner.start(gatedInput(), 4);
    await waitFor(async () => (await runner.list('project-1'))[0]?.workflow.status === 'completed');

    expect((await runner.list('project-1'))[0]!.workflow.steps[1]!.verdict).toMatchObject({ result: 'pass' });
  });

  it('treats a security review with no clear verdict as a block', async () => {
    const { runner } = harness({
      runAgent: async (request) => ({ conversation: conversation(request.conversationId), status: 'completed', output: 'Seems okay to me.' }),
    });

    await runner.start(gatedInput(), 4);
    await waitFor(async () => (await runner.list('project-1'))[0]?.workflow.status === 'paused');

    expect((await runner.list('project-1'))[0]!.workflow.steps[1]!.verdict).toMatchObject({ result: 'block' });
  });

  it('finishes the job when the user continues past a blocked review that was the last step', async () => {
    const prompts: string[] = [];
    const { runner } = harness({
      runAgent: async (request) => {
        prompts.push(request.prompt);
        return { conversation: conversation(request.conversationId), status: 'completed', output: request.agent === 'claude' ? 'VERDICT: BLOCK - injection' : 'ok' };
      },
    });

    const run = await runner.start(startInput({
      execution: 'cli',
      route: 'direct',
      steps: [
        { id: 'code', agent: 'codex', prompt: 'Write it', role: 'backend' },
        { id: 'security', agent: 'claude', prompt: 'Review it', role: 'securityReviewer', gate: 'security', dependsOn: ['code'] },
      ],
    }), 4);
    await waitFor(async () => (await runner.list('project-1'))[0]?.workflow.status === 'paused');

    const resumed = await runner.resume(run.workflow.id, 4);

    expect(resumed.workflow.status).toBe('completed');
    expect(resumed.workflow.steps[1]!.verdict).toMatchObject({ acknowledged: true });
    expect(prompts).toHaveLength(2);
  });

  it('does not gate a step that has no gate, whatever its output says', async () => {
    const { runner } = harness({
      runAgent: async (request) => ({ conversation: conversation(request.conversationId), status: 'completed', output: 'VERDICT: BLOCK - nope' }),
    });

    await runner.start(startInput({ steps: [{ id: 'a', agent: 'codex', prompt: 'One' }, { id: 'b', agent: 'codex', prompt: 'Two' }] }), 1);
    await waitFor(async () => (await runner.list('project-1'))[0]?.workflow.status === 'completed');
  });

  function checkedInput(overrides: Partial<WorkflowStartInput> = {}): WorkflowStartInput {
    return startInput({
      execution: 'cli',
      route: 'direct',
      autonomy: 'autoEdit',
      teamCheck: { command: 'npm test', maxRounds: 2 },
      steps: [
        { id: 'ui', agent: 'claude', prompt: 'Build the UI', label: 'Frontend: UI', role: 'frontend', paths: ['src/ui'] },
        { id: 'api', agent: 'codex', prompt: 'Build the API', label: 'Backend: API', role: 'backend', paths: ['src/api'] },
        { id: 'review', agent: 'gemini', prompt: 'Review it', label: 'Code review', role: 'codeReviewer', dependsOn: ['ui', 'api'], autonomy: 'plan' },
      ],
      ...overrides,
    });
  }

  /** A check that returns each output in turn (a passing one is an empty string) and records every command. */
  function scriptedChecks(outputs: string[]): { runCheck: WorkflowRunnerPorts['runCheck']; commands: string[] } {
    const commands: string[] = [];
    return {
      commands,
      runCheck: async (_project, command) => {
        commands.push(command);
        const output = outputs[Math.min(commands.length - 1, outputs.length - 1)] ?? '';
        return { passed: output === '', exitCode: output === '' ? 0 : 1, output };
      },
    };
  }

  it('finishes a team job after its check passes, without sending anything back', async () => {
    const checks = scriptedChecks(['']);
    const { runner } = harness({ runCheck: checks.runCheck });

    await runner.start(checkedInput(), 1);
    await waitFor(async () => (await runner.list('project-1'))[0]?.workflow.status === 'completed');

    const workflow = (await runner.list('project-1'))[0]!.workflow;
    expect(checks.commands).toEqual(['npm test']);
    expect(workflow.steps).toHaveLength(3);
    expect(workflow.teamCheck).toMatchObject({ lastPassed: true, round: 0, stopReason: 'passed' });
  });

  it('sends a failed check only to the part that owns the files it names, with the failure in front of it', async () => {
    const agents: AgentRunRequest[] = [];
    const checks = scriptedChecks(['FAIL src/api/login.test.ts\n  Expected 200, received 500\n    at src/api/login.ts:12:5', '']);
    const { runner } = harness({
      runCheck: checks.runCheck,
      runAgent: async (request) => {
        agents.push(request);
        return { conversation: conversation(request.conversationId), status: 'completed', output: `output of ${request.agent}` };
      },
    });

    await runner.start(checkedInput(), 1);
    await waitFor(async () => (await runner.list('project-1'))[0]?.workflow.status === 'completed');

    const workflow = (await runner.list('project-1'))[0]!.workflow;
    expect(checks.commands).toEqual(['npm test', 'npm test']);
    expect(workflow.steps.map((step) => step.id)).toEqual(['ui', 'api', 'review', 'fix-1-api']);
    expect(workflow.steps[3]).toMatchObject({ fixOf: 'api', round: 1, role: 'backend', agent: 'codex', dependsOn: ['api'], status: 'completed' });
    // The frontend part did not run again: agents were claude, codex, gemini, then codex once more.
    expect(agents.map((request) => request.agent)).toEqual(['claude', 'codex', 'gemini', 'codex']);
    const fix = agents[3]!;
    expect(fix).toMatchObject({ autonomy: 'autoEdit', freshSession: true });
    expect(fix.prompt).toContain('FIX ROUND 1');
    expect(fix.prompt).toContain('Expected 200, received 500');
    expect(fix.prompt).toContain('Build the API');
    expect(fix.prompt).toContain('### Backend: API (codex)\noutput of codex');
    expect(workflow.teamCheck).toMatchObject({ round: 1, lastPassed: true, stopReason: 'passed' });
  });

  it('sends a failure to every part that owns a file it names', async () => {
    const agents: string[] = [];
    const checks = scriptedChecks(['error in C:\\work\\project\\src\\ui\\App.tsx:3\nand src/api/routes.ts:9', '']);
    const { runner } = harness({
      runCheck: checks.runCheck,
      runAgent: async (request) => {
        agents.push(request.agent);
        return { conversation: conversation(request.conversationId), status: 'completed', output: 'ok' };
      },
    });

    await runner.start(checkedInput(), 1);
    await waitFor(async () => (await runner.list('project-1'))[0]?.workflow.status === 'completed');

    expect((await runner.list('project-1'))[0]!.workflow.steps.map((step) => step.id)).toEqual(['ui', 'api', 'review', 'fix-1-ui', 'fix-1-api']);
    expect(agents.slice(3)).toEqual(['claude', 'codex']);
  });

  it('falls back to the backend part when a failure names no file it can match', async () => {
    const checks = scriptedChecks(['Test suite failed to run', '']);
    const { runner } = harness({ runCheck: checks.runCheck });

    await runner.start(checkedInput(), 1);
    await waitFor(async () => (await runner.list('project-1'))[0]?.workflow.status === 'completed');

    expect((await runner.list('project-1'))[0]!.workflow.steps.map((step) => step.id)).toEqual(['ui', 'api', 'review', 'fix-1-api']);
  });

  it('pauses when the fix rounds run out, and Resume allows exactly one more', async () => {
    const checks = scriptedChecks(['FAIL src/api/a.ts', 'FAIL src/api/a.ts', 'FAIL src/api/a.ts', '']);
    const { runner } = harness({ runCheck: checks.runCheck });

    const run = await runner.start(checkedInput({ teamCheck: { command: 'npm test', maxRounds: 1 } }), 1);
    await waitFor(async () => (await runner.list('project-1'))[0]?.workflow.status === 'paused');

    const paused = (await runner.list('project-1'))[0]!.workflow;
    expect(paused.steps.map((step) => step.id)).toEqual(['ui', 'api', 'review', 'fix-1-api']);
    expect(paused.teamCheck).toMatchObject({ round: 1, maxRounds: 1, lastPassed: false, stopReason: 'max_rounds' });
    expect(checks.commands).toHaveLength(2);

    await runner.resume(run.workflow.id, 1);
    await waitFor(async () => (await runner.list('project-1'))[0]?.workflow.status === 'completed');

    const finished = (await runner.list('project-1'))[0]!.workflow;
    expect(finished.steps.map((step) => step.id)).toEqual(['ui', 'api', 'review', 'fix-1-api', 'fix-2-api']);
    expect(finished.teamCheck).toMatchObject({ round: 2, maxRounds: 2, lastPassed: true, stopReason: 'passed' });
    expect(checks.commands).toHaveLength(4);
  });

  it('runs the check after the user continues past a blocked security review that was the last step', async () => {
    const checks = scriptedChecks(['']);
    const { runner } = harness({
      runCheck: checks.runCheck,
      runAgent: async (request) => ({
        conversation: conversation(request.conversationId),
        status: 'completed',
        output: request.agent === 'claude' ? 'VERDICT: BLOCK - injection' : 'ok',
      }),
    });

    const run = await runner.start(checkedInput({
      steps: [
        { id: 'api', agent: 'codex', prompt: 'Build the API', label: 'Backend: API', role: 'backend', paths: ['src/api'] },
        { id: 'security', agent: 'claude', prompt: 'Review it', label: 'Security review', role: 'securityReviewer', gate: 'security', dependsOn: ['api'], autonomy: 'plan' },
      ],
    }), 1);
    await waitFor(async () => (await runner.list('project-1'))[0]?.workflow.status === 'paused');
    // The check has not run: the job stopped for the security decision first.
    expect(checks.commands).toEqual([]);

    await runner.resume(run.workflow.id, 1);
    await waitFor(async () => (await runner.list('project-1'))[0]?.workflow.status === 'completed');

    expect(checks.commands).toEqual(['npm test']);
    expect((await runner.list('project-1'))[0]!.workflow.teamCheck).toMatchObject({ lastPassed: true, stopReason: 'passed' });
  });

  it('sends a failed check to a custom editing role that owns the file, using the access stored on its step', async () => {
    const checks = scriptedChecks(['error in db/schema.sql:4', '']);
    const agents: string[] = [];
    const { runner } = harness({
      runCheck: checks.runCheck,
      runAgent: async (request) => {
        agents.push(request.agent);
        return { conversation: conversation(request.conversationId), status: 'completed', output: 'ok' };
      },
    });

    await runner.start(checkedInput({
      steps: [
        { id: 'ui', agent: 'claude', prompt: 'Build the UI', label: 'Frontend: UI', role: 'frontend', paths: ['src/ui'] },
        { id: 'db', agent: 'qwen', prompt: 'Create the table', label: 'Database: orders', role: 'custom-database', access: 'edit', paths: ['db'] },
        { id: 'audit', agent: 'gemini', prompt: 'Audit it', label: 'Accessibility', role: 'custom-a11y', access: 'read', autonomy: 'plan' },
      ],
    }), 1);
    await waitFor(async () => (await runner.list('project-1'))[0]?.workflow.status === 'completed');

    const workflow = (await runner.list('project-1'))[0]!.workflow;
    expect(workflow.steps.map((step) => step.id)).toEqual(['ui', 'db', 'audit', 'fix-1-db']);
    expect(workflow.steps[3]).toMatchObject({ role: 'custom-database', access: 'edit', agent: 'qwen', fixOf: 'db' });
    // The read-only custom role is never asked to fix anything.
    expect(agents).toEqual(['claude', 'qwen', 'gemini', 'qwen']);
  });

  it('pauses instead of looping when a failing check has no editing part to send it to', async () => {
    const checks = scriptedChecks(['FAIL']);
    const { runner } = harness({ runCheck: checks.runCheck });

    await runner.start(checkedInput({ steps: [{ id: 'review', agent: 'gemini', prompt: 'Review it', label: 'Code review', role: 'codeReviewer', autonomy: 'plan' }] }), 1);
    await waitFor(async () => (await runner.list('project-1'))[0]?.workflow.status === 'paused');

    expect((await runner.list('project-1'))[0]!.workflow.teamCheck).toMatchObject({ lastPassed: false, stopReason: 'max_rounds' });
    expect(checks.commands).toHaveLength(1);
  });

  describe('parts running side by side', () => {
    interface FakeSessionLog {
      prepared: string[];
      checkouts: string[];
      commits: string[];
      integrated: Array<Array<{ stepId: string; commit: string }>>;
      disposed: number;
    }

    /** A copy-and-merge layer that records what the runner asked for and merges however a test says. */
    function fakeWorktrees(options: {
      conflicts?: (commits: Array<{ stepId: string; commit: string }>) => Array<{ stepId: string; files: string[] }>;
      skipped?: string[];
      unavailable?: boolean;
    } = {}): { port: NonNullable<WorkflowRunnerPorts['worktrees']>; log: FakeSessionLog } {
      const log: FakeSessionLog = { prepared: [], checkouts: [], commits: [], integrated: [], disposed: 0 };
      let skippedOnce = options.skipped;
      return {
        log,
        port: {
          prepare: async (_projectId, key) => {
            log.prepared.push(key);
            if (options.unavailable) return null;
            return {
              checkout: async (stepId) => {
                log.checkouts.push(stepId);
                return `/copies/${stepId}`;
              },
              commit: async (stepId) => {
                log.commits.push(stepId);
                return `commit-${stepId}`;
              },
              integrate: async (commits) => {
                log.integrated.push([...commits]);
                const skipped = skippedOnce ?? [];
                skippedOnce = undefined;
                return { conflicts: options.conflicts?.(commits) ?? [], applied: commits.map((commit) => commit.stepId), skipped, integrationCommit: 'abcdef1234567890' };
              },
              dispose: async () => {
                log.disposed += 1;
              },
            };
          },
        },
      };
    }

    /** An agent runner that takes a little while and counts how many runs overlap. */
    function timedAgents(output: (request: AgentRunRequest) => string = (request) => `done by ${request.agent}`, delayMs = 40) {
      const calls: Array<{ request: AgentRunRequest; cwd?: string }> = [];
      let running = 0;
      let most = 0;
      return {
        calls,
        mostAtOnce: () => most,
        runAgent: async (request: AgentRunRequest, _owner: number, options?: { cwd?: string }): Promise<AgentRunResult> => {
          calls.push({ request, ...(options?.cwd ? { cwd: options.cwd } : {}) });
          running += 1;
          most = Math.max(most, running);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          running -= 1;
          return { conversation: conversation(request.conversationId), status: 'completed', output: output(request) };
        },
      };
    }

    function teamInput(overrides: Partial<WorkflowStartInput> = {}): WorkflowStartInput {
      return startInput({
        execution: 'cli',
        route: 'direct',
        autonomy: 'autoEdit',
        parallel: { maxConcurrent: 3 },
        steps: [
          { id: 'ui', agent: 'claude', prompt: 'Build the UI', label: 'Frontend: UI', role: 'frontend', access: 'edit', paths: ['src/ui'] },
          { id: 'api', agent: 'codex', prompt: 'Build the API', label: 'Backend: API', role: 'backend', access: 'edit', paths: ['src/api'] },
          { id: 'review', agent: 'gemini', prompt: 'Review it', label: 'Code review', role: 'codeReviewer', access: 'read', dependsOn: ['ui', 'api'], autonomy: 'plan' },
        ],
        ...overrides,
      });
    }

    const statusOf = async (runner: DesktopWorkflowRunner) => (await runner.list('project-1'))[0]?.workflow.status;

    it('runs independent parts at the same time, each in its own copy and conversation, then merges them', async () => {
      const agents = timedAgents();
      const worktrees = fakeWorktrees();
      const { runner, records } = harness({ runAgent: agents.runAgent, worktrees: worktrees.port });

      const run = await runner.start(teamInput(), 1);
      await waitFor(async () => (await statusOf(runner)) === 'completed');

      expect(agents.mostAtOnce()).toBe(2);
      const ui = agents.calls.find((call) => call.request.agent === 'claude')!;
      const api = agents.calls.find((call) => call.request.agent === 'codex')!;
      expect(ui.cwd).toBe('/copies/ui');
      expect(api.cwd).toBe('/copies/api');
      // Each part used its own conversation, kept out of the sidebar, never the workflow's own.
      expect(ui.request.conversationId).not.toBe(run.conversationId);
      expect(ui.request.conversationId).not.toBe(api.request.conversationId);
      expect(records.get(ui.request.conversationId)?.archived).toBe(true);
      // Only the two editing parts were committed and merged, in plan order.
      expect(worktrees.log.commits.sort()).toEqual(['api', 'ui']);
      expect(worktrees.log.integrated).toEqual([[{ stepId: 'ui', commit: 'commit-ui' }, { stepId: 'api', commit: 'commit-api' }]]);
      expect(worktrees.log.disposed).toBe(1);
      // The review ran after the merge, in the project itself, and saw both parts' results.
      const review = agents.calls.find((call) => call.request.agent === 'gemini')!;
      expect(review.cwd).toBeUndefined();
      expect(review.request.conversationId).toBe(run.conversationId);
      expect(review.request.prompt).toContain('### Frontend: UI (claude)\ndone by claude');
      expect(review.request.prompt).toContain('### Backend: API (codex)\ndone by codex');
      const workflow = (await runner.list('project-1'))[0]!.workflow;
      expect(workflow.steps.map((step) => [step.id, step.status, step.isolated ?? false])).toEqual([
        ['ui', 'completed', true],
        ['api', 'completed', true],
        ['review', 'completed', false],
      ]);
    });

    it('never runs more parts at once than the limit', async () => {
      const agents = timedAgents();
      const { runner } = harness({ runAgent: agents.runAgent, worktrees: fakeWorktrees().port });

      await runner.start(teamInput({
        parallel: { maxConcurrent: 2 },
        steps: ['a', 'b', 'c', 'd'].map((id) => ({ id, agent: 'codex' as const, prompt: `Part ${id}`, role: 'backend', access: 'edit' as const })),
      }), 1);
      await waitFor(async () => (await statusOf(runner)) === 'completed');

      expect(agents.calls).toHaveLength(4);
      expect(agents.mostAtOnce()).toBe(2);
    });

    it('runs a part whose changes clashed again on its own, on top of the merged work', async () => {
      const agents = timedAgents();
      const worktrees = fakeWorktrees({ conflicts: (commits) => (commits.length > 1 ? [{ stepId: 'api', files: ['src/shared.ts'] }] : []) });
      const { runner } = harness({ runAgent: agents.runAgent, worktrees: worktrees.port });

      await runner.start(teamInput(), 1);
      await waitFor(async () => (await statusOf(runner)) === 'completed');

      const apiRuns = agents.calls.filter((call) => call.request.agent === 'codex');
      expect(apiRuns).toHaveLength(2);
      expect(apiRuns[0]!.cwd).toBe('/copies/api');
      // The second run was in the project itself, after the clash.
      expect(apiRuns[1]!.cwd).toBeUndefined();
      const workflow = (await runner.list('project-1'))[0]!.workflow;
      const api = workflow.steps.find((step) => step.id === 'api')!;
      expect(api.status).toBe('completed');
      expect(api.note).toContain('clashed with another part in src/shared.ts');
      // The review came last, after the rerun.
      expect(agents.calls.at(-1)!.request.agent).toBe('gemini');
    });

    it('stops with a notice when files changed in the project during the wave, and Resume carries on', async () => {
      const agents = timedAgents();
      const { runner } = harness({ runAgent: agents.runAgent, worktrees: fakeWorktrees({ skipped: ['src/ui/app.ts'] }).port });

      const run = await runner.start(teamInput(), 1);
      await waitFor(async () => (await statusOf(runner)) === 'paused');

      const paused = (await runner.list('project-1'))[0]!.workflow;
      expect(paused.notice).toContain('src/ui/app.ts');
      expect(paused.notice).toContain('git show abcdef1234:src/ui/app.ts');
      expect(agents.calls.some((call) => call.request.agent === 'gemini')).toBe(false);

      await runner.resume(run.workflow.id, 1);
      await waitFor(async () => (await statusOf(runner)) === 'completed');
      const finished = (await runner.list('project-1'))[0]!.workflow;
      expect(finished.notice).toBeUndefined();
      expect(agents.calls.filter((call) => call.request.agent === 'gemini')).toHaveLength(1);
    });

    it('runs the parts one at a time, and says why, when the project cannot be copied', async () => {
      const agents = timedAgents();
      const { runner } = harness({ runAgent: agents.runAgent, worktrees: fakeWorktrees({ unavailable: true }).port });

      await runner.start(teamInput(), 1);
      await waitFor(async () => (await statusOf(runner)) === 'completed');

      expect(agents.mostAtOnce()).toBe(1);
      expect(agents.calls.every((call) => call.cwd === undefined)).toBe(true);
      expect((await runner.list('project-1'))[0]!.workflow.notice).toContain('needs a git project with at least one commit');
    });

    it('keeps the work of parts that finished when another fails, and Resume reruns only the failed one', async () => {
      let apiAttempts = 0;
      const agents = timedAgents();
      const worktrees = fakeWorktrees();
      const { runner } = harness({
        worktrees: worktrees.port,
        runAgent: async (request, owner, options) => {
          if (request.agent === 'codex' && (apiAttempts += 1) === 1) {
            return { conversation: conversation(request.conversationId), status: 'failed', output: '', error: 'api blew up' };
          }
          return agents.runAgent(request, owner, options);
        },
      });

      const run = await runner.start(teamInput(), 1);
      await waitFor(async () => (await statusOf(runner)) === 'paused');

      const paused = (await runner.list('project-1'))[0]!.workflow;
      expect(paused.steps.map((step) => step.status)).toEqual(['completed', 'failed', 'pending']);
      // The frontend part's work was still merged; the failed part had nothing to merge.
      expect(worktrees.log.integrated).toEqual([[{ stepId: 'ui', commit: 'commit-ui' }]]);

      await runner.resume(run.workflow.id, 1);
      await waitFor(async () => (await statusOf(runner)) === 'completed');
      expect(agents.calls.filter((call) => call.request.agent === 'claude')).toHaveLength(1);
      expect(apiAttempts).toBe(2);
    });

    it('stops every part running side by side when the user presses Stop', async () => {
      const cancelled: string[] = [];
      const releases: Array<() => void> = [];
      const worktrees = fakeWorktrees();
      const { runner } = harness({
        worktrees: worktrees.port,
        runAgent: (request) => new Promise<AgentRunResult>((resolve) => {
          releases.push(() => resolve({ conversation: conversation(request.conversationId), status: 'failed', output: '', error: 'cancelled' }));
        }),
        cancelAgent: (conversationId) => {
          cancelled.push(conversationId);
          releases.splice(0).forEach((release) => release());
          return true;
        },
      });

      const run = await runner.start(teamInput(), 1);
      await waitFor(() => releases.length === 2);
      const stopped = await runner.stop(run.workflow.id);

      // The workflow's own conversation and both parts' conversations were each cancelled.
      expect(new Set(cancelled).size).toBe(3);
      expect(stopped.workflow.status).toBe('aborted');
      expect(worktrees.log.disposed).toBe(1);
    });

    it('pauses for the user when a security review in a side-by-side wave blocks', async () => {
      const agents = timedAgents((request) => (request.agent === 'claude' ? 'Found an exposed key.\nVERDICT: BLOCK - key in code' : 'ok'));
      const worktrees = fakeWorktrees();
      const { runner } = harness({ runAgent: agents.runAgent, worktrees: worktrees.port });

      await runner.start(teamInput({
        steps: [
          { id: 'api', agent: 'codex', prompt: 'Build the API', role: 'backend', access: 'edit' },
          { id: 'security', agent: 'claude', prompt: 'Security review', role: 'securityReviewer', access: 'read', gate: 'security', dependsOn: ['api'], autonomy: 'plan' },
          { id: 'review', agent: 'gemini', prompt: 'Code review', role: 'codeReviewer', access: 'read', dependsOn: ['api'], autonomy: 'plan' },
          { id: 'docs', agent: 'qwen', prompt: 'Write docs', role: 'docs', access: 'edit', dependsOn: ['security'] },
        ],
      }), 1);
      await waitFor(async () => (await statusOf(runner)) === 'paused');

      const workflow = (await runner.list('project-1'))[0]!.workflow;
      expect(workflow.steps.find((step) => step.id === 'security')!.verdict).toMatchObject({ result: 'block', reason: 'key in code' });
      expect(agents.calls.some((call) => call.request.agent === 'qwen')).toBe(false);
      // Both reviews ran side by side, and neither was committed: they only read.
      expect(worktrees.log.checkouts.sort()).toEqual(['review', 'security']);
      expect(worktrees.log.commits).toEqual([]);
    });

    it('leaves a workflow without the option exactly as before: one at a time, no copies', async () => {
      const agents = timedAgents();
      const worktrees = fakeWorktrees();
      const { runner } = harness({ runAgent: agents.runAgent, worktrees: worktrees.port });

      const { parallel: _off, ...sequential } = teamInput();
      await runner.start(sequential, 1);
      await waitFor(async () => (await statusOf(runner)) === 'completed');

      expect(agents.mostAtOnce()).toBe(1);
      expect(worktrees.log.prepared).toEqual([]);
    });
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
