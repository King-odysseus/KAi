import { describe, expect, it } from 'vitest';
import { buildCodexArgs, ProcessAgentAdapter } from '../src/adapters/process-agent-adapter';
import type { CommandInfo, ProcessChunk, ProcessResult, ProcessRunner } from '../src/adapters/process-runner';
import type { WorkbenchEvent } from '../src/core/events';

describe('buildCodexArgs', () => {
  it('uses read-only sandbox in review mode', () => {
    expect(buildCodexArgs('codeproxy', {
      taskId: 'task_1',
      prompt: 'inspect',
      route: 'direct',
      autonomy: 'review',
      cwd: 'C:/repo'
    })).toEqual(['exec', '--json', '--sandbox', 'read-only', '--cd', 'C:/repo', 'inspect']);
  });

  it('uses workspace-write and profile in proxy auto mode', () => {
    expect(buildCodexArgs('codeproxy', {
      taskId: 'task_1',
      prompt: 'edit',
      route: 'proxy',
      autonomy: 'auto',
      cwd: 'C:/repo'
    })).toEqual(['exec', '--json', '--sandbox', 'workspace-write', '--cd', 'C:/repo', '--profile', 'codeproxy', 'edit']);
  });
});

describe('ProcessAgentAdapter', () => {
  it('reports command availability from the runner', async () => {
    const adapter = new ProcessAgentAdapter({
      id: 'codex',
      displayName: 'Codex',
      command: 'codex',
      buildArgs: (request) => buildCodexArgs(undefined, request),
      runner: new FakeRunner({ available: true, version: 'codex 1.0.0' }, [])
    });

    await expect(adapter.getCapability()).resolves.toMatchObject({
      id: 'codex',
      available: true,
      version: 'codex 1.0.0'
    });
  });

  it('maps stdout JSON and plain text into events', async () => {
    const adapter = new ProcessAgentAdapter({
      id: 'codex',
      displayName: 'Codex',
      command: 'codex',
      buildArgs: (request) => buildCodexArgs(undefined, request),
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
    for await (const event of adapter.run({ taskId: 'task_1', prompt: 'hi', route: 'direct', autonomy: 'review' })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toContain('text.delta');
    expect(events.filter((event) => event.type === 'text.delta').map((event) => event.text)).toEqual(['hello', 'plain line']);
    expect(events.at(-1)).toMatchObject({ type: 'agent.lifecycle', status: 'completed' });
  });

  it('yields every event returned by a parser', async () => {
    const adapter = new ProcessAgentAdapter({
      id: 'codex',
      displayName: 'Codex',
      command: 'codex',
      buildArgs: (request) => buildCodexArgs(undefined, request),
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
    for await (const event of adapter.run({ taskId: 'task_parser', prompt: 'hi', route: 'direct', autonomy: 'review' })) {
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
      buildArgs: (request) => buildCodexArgs(undefined, request),
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
    for await (const event of adapter.run({ taskId: 'task_1', prompt: 'hi', route: 'proxy', autonomy: 'review' })) {
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
      buildArgs: (request) => buildCodexArgs(undefined, request),
      runner
    });

    const events: WorkbenchEvent[] = [];
    const consume = (async () => {
      for await (const event of adapter.run({ taskId: 'task_stop', prompt: 'wait', route: 'direct', autonomy: 'auto' })) {
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
  constructor(
    private readonly info: CommandInfo,
    private readonly chunks: Array<ProcessChunk | ProcessResult>
  ) {}

  async commandInfo(): Promise<CommandInfo> {
    return this.info;
  }

  async *run(_command: string, _args: string[], _cwd?: string, _signal?: AbortSignal): AsyncIterable<ProcessChunk | ProcessResult> {
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
