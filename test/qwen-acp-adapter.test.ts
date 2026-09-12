import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import type { CommandInfo, ProcessRunner } from '../src/adapters/process-runner';
import {
  QwenAcpAdapter,
  mapQwenSessionUpdate,
  qwenModeForAutonomy,
  type AcpSpawn,
} from '../src/adapters/qwen-acp-adapter';
import type { WorkbenchEvent } from '../src/core/events';

describe('Qwen ACP event mapping', () => {
  it('maps KAI autonomy modes to Qwen ACP modes', () => {
    expect(qwenModeForAutonomy('plan')).toBe('plan');
    expect(qwenModeForAutonomy('ask')).toBe('default');
    expect(qwenModeForAutonomy('autoEdit')).toBe('auto-edit');
    expect(qwenModeForAutonomy('full')).toBe('yolo');
    expect(qwenModeForAutonomy('custom')).toBe('default');
  });

  it('maps text, thoughts, tool calls and tool results', () => {
    expect(mapQwenSessionUpdate('task_1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'OK' },
    })[0]).toMatchObject({ type: 'text.delta', channel: 'assistant', text: 'OK' });

    expect(mapQwenSessionUpdate('task_1', {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Checking' },
    })[0]).toMatchObject({ type: 'text.delta', channel: 'summary', text: 'Checking' });

    expect(mapQwenSessionUpdate('task_1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_1',
      status: 'in_progress',
      title: 'ReadFile: package.json',
      kind: 'read',
      rawInput: { file_path: 'package.json' },
      _meta: { toolName: 'read_file' },
    })[0]).toMatchObject({
      type: 'tool.call',
      name: 'read_file',
      status: 'started',
      input: { file_path: 'package.json' },
    });

    expect(mapQwenSessionUpdate('task_1', {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'name: kai' } }],
      _meta: { toolName: 'read_file' },
    })[0]).toMatchObject({
      type: 'tool.call',
      name: 'read_file',
      status: 'completed',
      output: 'name: kai',
    });
  });
});

describe('QwenAcpAdapter', () => {
  it('runs the initialize/session/mode/prompt handshake and streams events', async () => {
    const process = new FakeAcpProcess({
      sessionId: 'session-1',
      currentMode: 'plan',
      promptEvents: [
        { method: 'session/update', params: { sessionId: 'session-1', update: {
          sessionUpdate: 'tool_call', toolCallId: 'call_1', status: 'in_progress',
          title: 'ReadFile: package.json', kind: 'read', rawInput: { file_path: 'package.json' },
          _meta: { toolName: 'read_file' },
        } } },
        { method: 'session/update', params: { sessionId: 'session-1', update: {
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' },
          _meta: { usage: { inputTokens: 42, outputTokens: 2, totalTokens: 44 } },
        } } },
      ],
      promptResult: { stopReason: 'end_turn' },
    });
    const adapter = new QwenAcpAdapter({
      command: 'qwen',
      runner: new FakeRunner(),
      spawn: process.asSpawn(),
    });

    const events: WorkbenchEvent[] = [];
    for await (const event of adapter.run(request('task_1'))) events.push(event);

    expect(events.filter((event) => event.type === 'text.delta').map((event) => event.text)).toEqual(['OK']);
    expect(process.methods).toEqual(['initialize', 'session/new', 'session/set_mode', 'session/prompt']);
    expect(process.sent.find((message) => message.method === 'session/set_mode')?.params).toMatchObject({
      sessionId: 'session-1',
      modeId: 'default',
    });
    expect(events.find((event) => event.type === 'cost.update')).toMatchObject({
      sessionId: 'session-1',
      inputTokens: 42,
      outputTokens: 2,
    });
    expect(events.at(-1)).toMatchObject({ type: 'agent.lifecycle', status: 'completed' });
  });

  it('loads a resumed session without replaying prior assistant text', async () => {
    const process = new FakeAcpProcess({
      sessionId: 'session-resume',
      currentMode: 'default',
      replayText: 'old reply',
      promptEvents: [{
        method: 'session/update',
        params: { sessionId: 'session-resume', update: {
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'new reply' },
        } },
      }],
      promptResult: { stopReason: 'end_turn' },
    });
    const adapter = new QwenAcpAdapter({
      command: 'qwen',
      runner: new FakeRunner(),
      spawn: process.asSpawn(),
    });

    const events: WorkbenchEvent[] = [];
    for await (const event of adapter.run(request('task_resume', 'session-resume'))) events.push(event);

    expect(process.methods).toEqual(['initialize', 'session/load', 'session/prompt']);
    expect(events.filter((event) => event.type === 'text.delta').map((event) => event.text)).toEqual(['new reply']);
  });

  it('answers an ACP permission request with the user decision', async () => {
    const process = new FakeAcpProcess({
      sessionId: 'session-permission',
      currentMode: 'default',
      permissionRequest: true,
      promptEvents: [],
      promptResult: { stopReason: 'end_turn' },
    });
    const adapter = new QwenAcpAdapter({
      command: 'qwen',
      runner: new FakeRunner(),
      spawn: process.asSpawn(),
    });

    const events: WorkbenchEvent[] = [];
    for await (const event of adapter.run(request('task_permission'))) {
      events.push(event);
      if (event.type === 'approval.request') {
        await adapter.respondToApproval('task_permission', event.id, 'always');
      }
    }

    expect(process.permissionResponse).toMatchObject({
      outcome: { outcome: 'selected', optionId: 'proceed_always' },
    });
    expect(events.filter((event) => event.type === 'text.delta').map((event) => event.text)).toEqual(['approved']);
    expect(events.at(-1)).toMatchObject({ type: 'agent.lifecycle', status: 'completed' });
  });
});

class FakeRunner implements ProcessRunner {
  commandInfo(): Promise<CommandInfo> {
    return Promise.resolve({ available: true, version: '0.15.10' });
  }

  async *run(): AsyncIterable<never> {
    // The ACP adapter uses its own bidirectional transport.
  }
}

interface FakeMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
}

interface FakeOptions {
  sessionId: string;
  currentMode: string;
  promptEvents: Array<{ method: string; params: Record<string, unknown> }>;
  promptResult: Record<string, unknown>;
  replayText?: string;
  permissionRequest?: boolean;
}

class FakeAcpProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly sent: FakeMessage[] = [];
  readonly methods: string[] = [];
  permissionResponse: unknown;
  private killed = false;
  private readonly spawn = (): this => this;
  readonly stdin = {
    write: (chunk: string): boolean => {
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) this.handle(JSON.parse(line) as FakeMessage);
      return true;
    },
    end: (): void => undefined,
  };

  constructor(private readonly options: FakeOptions) {
    super();
  }

  asSpawn(): AcpSpawn {
    return this.spawn;
  }

  kill(): boolean {
    if (!this.killed) {
      this.killed = true;
      this.emit('close', 0, null);
    }
    return true;
  }

  private handle(message: FakeMessage): void {
    this.sent.push(message);
    if (message.method) this.methods.push(message.method);
    if (message.id === 77) {
      this.permissionResponse = message.result;
      this.emitStdout({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: this.options.sessionId, update: {
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'approved' },
        } },
      });
      this.finishPrompt();
      return;
    }
    if (!message.id || !message.method) return;

    if (message.method === 'initialize') {
      this.respond(message.id, { protocolVersion: 1, agentInfo: { name: 'qwen-code', version: '0.15.10' } });
    } else if (message.method === 'session/new') {
      this.respond(message.id, {
        sessionId: this.options.sessionId,
        modes: { currentModeId: this.options.currentMode, availableModes: [] },
      });
    } else if (message.method === 'session/load') {
      if (this.options.replayText) {
        this.emitStdout({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: this.options.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: this.options.replayText } },
        } });
      }
      this.respond(message.id, { modes: { currentModeId: this.options.currentMode, availableModes: [] } });
    } else if (message.method === 'session/set_mode') {
      this.respond(message.id, {});
    } else if (message.method === 'session/prompt') {
      if (this.options.permissionRequest) {
        this.emitStdout({
          jsonrpc: '2.0',
          id: 77,
          method: 'session/request_permission',
          params: {
            sessionId: this.options.sessionId,
            options: [
              { optionId: 'proceed_once', kind: 'allow_once', name: 'Allow' },
              { optionId: 'proceed_always', kind: 'allow_always', name: 'Allow always' },
              { optionId: 'cancel', kind: 'reject_once', name: 'Reject' },
            ],
            toolCall: {
              toolCallId: 'call_permission',
              status: 'pending',
              title: 'Shell: npm test',
              kind: 'execute',
              rawInput: { command: 'npm test' },
            },
          },
        });
        return;
      }
      for (const event of this.options.promptEvents) this.emitStdout({ jsonrpc: '2.0', ...event });
      this.finishPrompt(message.id);
    }
  }

  private finishPrompt(id: number | string = 3): void {
    this.respond(id, this.options.promptResult);
  }

  private respond(id: number | string, result: unknown): void {
    setImmediate(() => {
      this.emitStdout({ jsonrpc: '2.0', id, result });
    });
  }

  private emitStdout(message: FakeMessage): void {
    this.stdout.emit('data', JSON.stringify(message) + '\n');
  }
}

function request(taskId: string, resumeSessionId?: string) {
  return {
    taskId,
    prompt: 'test prompt',
    route: 'direct' as const,
    autonomy: 'ask' as const,
    cwd: process.cwd(),
    resumeSessionId,
  };
}
