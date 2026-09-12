import { describe, expect, it } from 'vitest';
import { buildClaudeArgs, buildCodexArgs, ProcessAgentAdapter } from '../src/adapters/process-agent-adapter';
import type { CommandInfo, ProcessChunk, ProcessResult, ProcessRunner } from '../src/adapters/process-runner';
import type { WorkbenchEvent } from '../src/core/events';

describe('prompt stdin arguments', () => {
  it('does not put prompts in Claude or Codex argv', () => {
    const request = {
      taskId: 'task_1',
      prompt: 'line one %PATH%\\nline two',
      route: 'direct' as const,
      autonomy: 'ask' as const,
    };

    expect(buildClaudeArgs(request)).toEqual([
      '-p', '--output-format', 'json', '--permission-mode', 'default',
    ]);
    expect(buildCodexArgs(request)).toContain('-');
    expect(buildCodexArgs(request)).not.toContain(request.prompt);
  });
});

describe('buildClaudeArgs', () => {
  // Verified against `claude --help`: --permission-mode choices are
  // acceptEdits, auto, bypassPermissions, default, dontAsk, plan.
  it.each([
    ['plan', 'plan'],
    ['ask', 'default'],
    ['custom', 'default'],
    ['autoEdit', 'acceptEdits'],
  ] as const)('maps %s autonomy to Claude %s permission mode', (autonomy, permissionMode) => {
    expect(buildClaudeArgs({
      taskId: 'task_1',
      prompt: 'prompt',
      route: 'direct',
      autonomy,
    })).toEqual(['-p', '--output-format', 'json', '--permission-mode', permissionMode]);
  });

  it('full mode adds --dangerously-skip-permissions alongside bypassPermissions', () => {
    expect(buildClaudeArgs({
      taskId: 'task_1', prompt: 'prompt', route: 'direct', autonomy: 'full',
    })).toEqual(['-p', '--output-format', 'json', '--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions']);
  });

  it('custom mode with workspaceEdit allowed maps to acceptEdits', () => {
    expect(buildClaudeArgs({
      taskId: 'task_1', prompt: 'prompt', route: 'direct', autonomy: 'custom',
      customAllowed: { workspaceEdit: true },
    })).toEqual(['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits']);
  });

  it('appends --resume when a session id is given', () => {
    expect(buildClaudeArgs({
      taskId: 'task_1', prompt: 'prompt', route: 'direct', autonomy: 'ask', resumeSessionId: 'abc-123',
    })).toEqual(['-p', '--output-format', 'json', '--permission-mode', 'default', '--resume', 'abc-123']);
  });
});

describe('buildCodexArgs', () => {
  // Verified against `codex exec --help`: --sandbox choices are read-only,
  // workspace-write, danger-full-access.
  it('uses read-only sandbox in plan mode', () => {
    expect(buildCodexArgs({
      taskId: 'task_1',
      prompt: 'inspect',
      route: 'direct',
      autonomy: 'plan',
      cwd: 'C:/repo'
    })).toEqual(['exec', '--json', '--sandbox', 'read-only', '--cd', 'C:/repo', '-']);
  });

  it('uses read-only sandbox in ask mode (no non-interactive approval channel yet)', () => {
    expect(buildCodexArgs({
      taskId: 'task_1', prompt: 'inspect', route: 'direct', autonomy: 'ask',
    })).toEqual(['exec', '--json', '--sandbox', 'read-only', '-']);
  });

  // Codex 0.153+ rejects `--profile` while config.toml still has a legacy
  // [profiles.<name>] table, so the proxy is selected purely by the top-level
  // model_provider/model keys. The args must therefore be route-independent.
  it('uses workspace-write sandbox in proxy autoEdit mode, without --profile', () => {
    expect(buildCodexArgs({
      taskId: 'task_1',
      prompt: 'edit',
      route: 'proxy',
      autonomy: 'autoEdit',
      cwd: 'C:/repo'
    })).toEqual(['exec', '--json', '--sandbox', 'workspace-write', '--cd', 'C:/repo', '-']);
  });

  it('produces the same args for direct and proxy routes', () => {
    const base = { taskId: 'task_1', prompt: 'edit', autonomy: 'autoEdit' as const, cwd: 'C:/repo' };
    expect(buildCodexArgs({ ...base, route: 'proxy' }))
      .toEqual(buildCodexArgs({ ...base, route: 'direct' }));
  });

  it('uses danger-full-access sandbox in full mode', () => {
    expect(buildCodexArgs({
      taskId: 'task_1', prompt: 'edit', route: 'direct', autonomy: 'full',
    })).toEqual(['exec', '--json', '--sandbox', 'danger-full-access', '-']);
  });

  it('resume uses its own flag set with no --sandbox/--cd/--profile', () => {
    expect(buildCodexArgs({
      taskId: 'task_1', prompt: 'continue', route: 'proxy', autonomy: 'ask', cwd: 'C:/repo', resumeSessionId: 'sess-1',
    })).toEqual(['exec', 'resume', 'sess-1', '--json', '-']);
  });
});

describe('ProcessAgentAdapter', () => {
  it('reports command availability from the runner', async () => {
    const adapter = new ProcessAgentAdapter({
      id: 'codex',
      displayName: 'Codex',
      command: 'codex',
      buildArgs: (request) => buildCodexArgs(request),
      runner: new FakeRunner({ available: true, version: 'codex 1.0.0' }, [])
    });

    await expect(adapter.getCapability()).resolves.toMatchObject({
      id: 'codex',
      available: true,
      version: 'codex 1.0.0'
    });
  });

  it('passes a multiline percent prompt through stdin unchanged', async () => {
    const runner = new FakeRunner(
      { available: true, version: 'codex 1.0.0' },
      [{ code: 0, signal: null }],
    );
    const adapter = new ProcessAgentAdapter({
      id: 'codex',
      displayName: 'Codex',
      command: 'codex',
      buildArgs: (request) => buildCodexArgs(request),
      runner,
    });
    const prompt = 'line one %PATH%\nline two';

    for await (const _event of adapter.run({ taskId: 'task_stdin', prompt, route: 'direct', autonomy: 'ask' })) {
      // Consume the run.
    }

    expect(runner.lastStdin).toBe(prompt);
  });

  it('maps stdout JSON and plain text into events', async () => {
    const adapter = new ProcessAgentAdapter({
      id: 'codex',
      displayName: 'Codex',
      command: 'codex',
      buildArgs: (request) => buildCodexArgs(request),
      runner: new FakeRunner(
        { available: true, version: 'codex 1.0.0' },
        [
          { stream: 'stdout', text: '{"message":"hello"}\n' },
          { stream: 'stdout', text: 'plain line\n' },
          { code: 0, signal: null }
        ]
      )
    });

    const events: WorkbenchEvent[] = [];
    for await (const event of adapter.run({ taskId: 'task_1', prompt: 'hi', route: 'direct', autonomy: 'ask' })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toContain('text.delta');
    expect(events.filter((event) => event.type === 'text.delta').map((event) => event.text)).toEqual(['hello', 'plain line']);
    expect(events.at(-1)).toMatchObject({ type: 'agent.lifecycle', status: 'completed' });
  });

  it('buffers a JSON line split across chunks', async () => {
    const adapter = new ProcessAgentAdapter({
      id: 'codex',
      displayName: 'Codex',
      command: 'codex',
      buildArgs: (request) => buildCodexArgs(request),
      parseLine: (line, taskId, agent) => ({
        id: 'split_event',
        type: 'text.delta',
        taskId,
        timestamp: '2026-07-03T00:00:00.000Z',
        agent,
        channel: 'assistant',
        text: JSON.parse(line).message as string,
      }),
      runner: new FakeRunner(
        { available: true, version: 'codex 1.0.0' },
        [
          { stream: 'stdout', text: '{"mes' },
          { stream: 'stdout', text: 'sage":"hello' },
          { stream: 'stdout', text: '"}\n' },
          { code: 0, signal: null },
        ],
      ),
    });

    const events: WorkbenchEvent[] = [];
    for await (const event of adapter.run({ taskId: 'task_split', prompt: 'hi', route: 'direct', autonomy: 'ask' })) {
      events.push(event);
    }

    expect(events.filter((event) => event.id === 'split_event')).toMatchObject([
      { type: 'text.delta', text: 'hello' },
    ]);
  });

  it('flushes an unterminated final line when the process exits', async () => {
    const adapter = new ProcessAgentAdapter({
      id: 'codex',
      displayName: 'Codex',
      command: 'codex',
      buildArgs: (request) => buildCodexArgs(request),
      parseLine: (line, taskId, agent) => ({
        id: 'final_event',
        type: 'text.delta',
        taskId,
        timestamp: '2026-07-03T00:00:00.000Z',
        agent,
        channel: 'assistant',
        text: line,
      }),
      runner: new FakeRunner(
        { available: true, version: 'codex 1.0.0' },
        [
          { stream: 'stdout', text: 'final line' },
          { code: 0, signal: null },
        ],
      ),
    });

    const events: WorkbenchEvent[] = [];
    for await (const event of adapter.run({ taskId: 'task_final', prompt: 'hi', route: 'direct', autonomy: 'ask' })) {
      events.push(event);
    }

    expect(events).toContainEqual(expect.objectContaining({ id: 'final_event', text: 'final line' }));
  });

  it('yields every event returned by a parser', async () => {
    const adapter = new ProcessAgentAdapter({
      id: 'codex',
      displayName: 'Codex',
      command: 'codex',
      buildArgs: (request) => buildCodexArgs(request),
      parseLine: (line, taskId, agent) => [
        {
          id: 'event_1',
          type: 'text.delta',
          taskId,
          timestamp: '2026-07-03T00:00:00.000Z',
          agent,
          channel: 'assistant',
          text: line,
        },
        {
          id: 'event_2',
          type: 'raw.fallback',
          taskId,
          timestamp: '2026-07-03T00:00:00.000Z',
          agent,
          sourceType: 'test',
          payload: line,
        },
      ],
      runner: new FakeRunner(
        { available: true, version: 'codex 1.0.0' },
        [
          { stream: 'stdout', text: 'parsed\\n' },
          { code: 0, signal: null },
        ],
      ),
    });

    const events: WorkbenchEvent[] = [];
    for await (const event of adapter.run({ taskId: 'task_parser', prompt: 'hi', route: 'direct', autonomy: 'ask' })) {
      events.push(event);
    }

    expect(events.filter((event) => event.id === 'event_1' || event.id === 'event_2').map((event) => event.id))
      .toEqual(['event_1', 'event_2']);
  });

  it('emits beforeRun events before process output', async () => {
    const adapter = new ProcessAgentAdapter({
      id: 'codex',
      displayName: 'Codex',
      command: 'codex',
      buildArgs: (request) => buildCodexArgs(request),
      beforeRun: async (request) => [{
        id: 'before',
        type: 'agent.lifecycle',
        taskId: request.taskId,
        timestamp: '2026-07-03T00:00:00.000Z',
        agent: 'codex',
        status: 'running',
        detail: 'prepared config'
      }],
      runner: new FakeRunner(
        { available: true, version: 'codex 1.0.0' },
        [
          { stream: 'stdout', text: 'ready\n' },
          { code: 0, signal: null }
        ]
      )
    });

    const events: WorkbenchEvent[] = [];
    for await (const event of adapter.run({ taskId: 'task_1', prompt: 'hi', route: 'proxy', autonomy: 'ask' })) {
      events.push(event);
    }

    expect(events[0]).toMatchObject({ detail: 'prepared config' });
    expect(events[1]).toMatchObject({ type: 'agent.lifecycle', status: 'starting' });
  });

  it('stops an active process run via AbortSignal', async () => {
    const runner = new AbortableRunner();
    const adapter = new ProcessAgentAdapter({
      id: 'codex',
      displayName: 'Codex',
      command: 'codex',
      buildArgs: (request) => buildCodexArgs(request),
      runner
    });

    const events: WorkbenchEvent[] = [];
    const consume = (async () => {
      for await (const event of adapter.run({ taskId: 'task_stop', prompt: 'wait', route: 'direct', autonomy: 'autoEdit' })) {
        events.push(event);
      }
    })();

    await runner.readyToAbort;
    await adapter.stop('task_stop');
    await consume;

    expect(events.at(-1)).toMatchObject({
      type: 'agent.lifecycle',
      status: 'paused',
      detail: 'Codex stopped by user.'
    });
  });
});

class FakeRunner implements ProcessRunner {
  lastStdin?: string;

  constructor(
    private readonly info: CommandInfo,
    private readonly chunks: Array<ProcessChunk | ProcessResult>
  ) {}

  async commandInfo(): Promise<CommandInfo> {
    return this.info;
  }

  async *run(_command: string, _args: string[], _cwd?: string, _signal?: AbortSignal, stdin?: string): AsyncIterable<ProcessChunk | ProcessResult> {
    this.lastStdin = stdin;
    for (const chunk of this.chunks) {
      yield chunk;
    }
  }
}

class AbortableRunner implements ProcessRunner {
  readonly started: Promise<void>;
  readonly readyToAbort: Promise<void>;
  private markStarted!: () => void;
  private markReadyToAbort!: () => void;

  constructor() {
    this.started = new Promise((resolve) => {
      this.markStarted = resolve;
    });
    this.readyToAbort = new Promise((resolve) => {
      this.markReadyToAbort = resolve;
    });
  }

  async commandInfo(): Promise<CommandInfo> {
    return { available: true, version: 'codex 1.0.0' };
  }

  async *run(_command: string, _args: string[], _cwd?: string, signal?: AbortSignal): AsyncIterable<ProcessChunk | ProcessResult> {
    this.markStarted();
    yield { stream: 'stdout', text: 'started\n' };
    await new Promise<void>((resolve) => {
      signal?.addEventListener('abort', () => resolve(), { once: true });
      this.markReadyToAbort();
    });
    yield { code: null, signal: 'SIGTERM' };
  }
}
