import { spawn } from 'child_process';
import { createEventId, nowIso, type ApprovalRequestEvent, type CostUpdateEvent, type TextDeltaEvent, type ToolCallEvent, type WorkbenchEvent } from '../core/events';
import type { AgentCapability, AgentId, AutonomyMode } from '../core/types';
import type { AgentAdapter, AgentRunRequest, ApprovalResponse } from './agent-adapter';
import { NodeProcessRunner, type ProcessRunner } from './process-runner';

type JsonRpcId = number | string;

interface AcpProcess {
  stdin: {
    write(chunk: string): boolean;
    end(): void;
  };
  stdout: {
    on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  };
  stderr: {
    on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  };
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type AcpSpawn = (
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; windowsHide?: boolean; shell?: boolean },
) => AcpProcess;

export interface QwenAcpAdapterOptions {
  command: string;
  displayName?: string;
  runner?: ProcessRunner;
  spawn?: AcpSpawn;
}

interface RpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

interface PermissionOption {
  optionId: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
  name?: string;
}

interface PendingPermission {
  requestId: JsonRpcId;
  options: PermissionOption[];
}

interface ActiveRun {
  controller: AbortController;
  client: AcpJsonRpcClient;
  sessionId?: string;
  pendingPermissions: Map<string, PendingPermission>;
  killTimer?: NodeJS.Timeout;
}

type QueuedEvent =
  | { kind: 'update'; sessionId: string; update: Record<string, unknown> }
  | { kind: 'permission'; requestId: JsonRpcId; params: Record<string, unknown> }
  | { kind: 'stderr'; text: string }
  | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null };

interface PromptOutcome {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: Error;
}

class AsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(value: T) => void> = [];

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(value);
      return;
    }
    this.values.push(value);
  }

  shift(): Promise<T> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve(value);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  drain(): T[] {
    return this.values.splice(0);
  }
}

class AcpJsonRpcClient {
  private child: AcpProcess | null = null;
  private buffer = '';
  private nextId = 0;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private exitEmitted = false;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly cwd: string | undefined,
    private readonly spawnProcess: AcpSpawn,
    private readonly handlers: {
      notification?: (method: string, params: unknown) => void;
      request?: (id: JsonRpcId, method: string, params: unknown) => void;
      stderr?: (text: string) => void;
      exit?: (code: number | null, signal: NodeJS.Signals | null) => void;
    },
  ) {}

  start(): void {
    this.child = this.spawnProcess(this.command, this.args, {
      cwd: this.cwd,
      env: process.env,
      shell: process.platform === 'win32',
      windowsHide: true,
    });

    this.child.stdout.on('data', (chunk) => {
      this.onStdout(chunk);
    });
    this.child.stderr.on('data', (chunk) => {
      this.handlers.stderr?.(chunk.toString());
    });
    this.child.on('error', (error) => {
      this.failAll(error);
    });
    this.child.on('close', (code, signal) => {
      this.emitExit(code, signal);
    });
  }

  request(method: string, params: unknown, timeoutMs: number | null = 30_000): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === null
        ? undefined
        : setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`Qwen ACP request timed out: ${method}`));
          }, timeoutMs);
      timer?.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  kill(): void {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      // The process may already have closed its stdin.
    }
    try {
      child.kill();
    } catch {
      // The process may already be gone.
    }
  }

  private write(message: RpcMessage): void {
    if (!this.child) throw new Error('Qwen ACP process is not running.');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  private onStdout(chunk: Buffer | string): void {
    this.buffer += chunk.toString();
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let message: RpcMessage;
      try {
        message = JSON.parse(trimmed) as RpcMessage;
      } catch {
        this.handlers.stderr?.(trimmed);
        continue;
      }
      this.handleMessage(message);
    }
  }

  private handleMessage(message: RpcMessage): void {
    if (message.id !== undefined && message.method) {
      this.handlers.request?.(message.id, message.method, message.params);
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (message.error !== undefined) {
        pending.reject(new Error(formatRpcError(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method) {
      this.handlers.notification?.(message.method, message.params);
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitEmitted) return;
    this.exitEmitted = true;
    const detail = `Qwen ACP process exited${code === null ? '' : ` with code ${code}`}${signal ? ` (${signal})` : ''}.`;
    this.failAll(new Error(detail));
    this.handlers.exit?.(code, signal);
  }
}

export class QwenAcpAdapter implements AgentAdapter {
  readonly id: AgentId = 'qwen';
  private readonly displayName: string;
  private readonly command: string;
  private readonly runner: ProcessRunner;
  private readonly spawnProcess: AcpSpawn;
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(options: QwenAcpAdapterOptions) {
    this.displayName = options.displayName ?? 'Qwen Code';
    this.command = options.command;
    this.runner = options.runner ?? new NodeProcessRunner();
    this.spawnProcess = options.spawn ?? defaultSpawn;
  }

  async getCapability(): Promise<AgentCapability> {
    const info = await this.runner.commandInfo(this.command);
    return {
      id: this.id,
      displayName: this.displayName,
      available: info.available,
      version: info.version,
      unavailableReason: info.available
        ? undefined
        : info.detail || `${this.command} not found. Install ${this.displayName} to enable.`,
      supportsRoutes: ['direct', 'proxy'],
      supportsAutonomy: ['plan', 'ask', 'autoEdit', 'full', 'custom'],
      supportsTools: true,
      supportsApprovals: true,
      supportsDiffs: true,
      supportsMcp: true,
      requiredConfigKeys: [],
    };
  }

  async *run(request: AgentRunRequest): AsyncIterable<WorkbenchEvent> {
    const capability = await this.getCapability();
    if (!capability.available) {
      yield this.errorEvent(request.taskId, `${this.displayName} unavailable: ${capability.unavailableReason || 'command missing'}`);
      return;
    }

    const controller = new AbortController();
    const queue = new AsyncQueue<QueuedEvent>();
    const pendingPermissions = new Map<string, PendingPermission>();
    let acceptUpdates = false;
    let latestUsage: { inputTokens?: number; outputTokens?: number } | undefined;
    const client = new AcpJsonRpcClient(
      this.command,
      ['--acp'],
      request.cwd,
      this.spawnProcess,
      {
        notification: (method, params) => {
          if (method !== 'session/update' || !acceptUpdates) return;
          const record = asRecord(params);
          const update = asRecord(record?.update);
          const sessionId = typeof record?.sessionId === 'string' ? record.sessionId : '';
          if (!update || !sessionId) return;
          const usage = extractUsage(update);
          if (usage) latestUsage = usage;
          queue.push({ kind: 'update', sessionId, update });
        },
        request: (id, method, params) => {
          if (method !== 'session/request_permission') {
            client.respond(id, { error: { code: -32601, message: `Unsupported client method: ${method}` } });
            return;
          }
          queue.push({ kind: 'permission', requestId: id, params: asRecord(params) ?? {} });
        },
        stderr: (text) => {
          const trimmed = text.trim();
          if (trimmed) queue.push({ kind: 'stderr', text: trimmed });
        },
        exit: (code, signal) => {
          queue.push({ kind: 'exit', code, signal });
        },
      },
    );

    const active: ActiveRun = { controller, client, pendingPermissions };
    this.activeRuns.set(request.taskId, active);
    const cwd = request.cwd || process.cwd();
    const onAbort = () => {
      if (active.sessionId) {
        try {
          client.notify('session/cancel', { sessionId: active.sessionId });
        } catch {
          // Best effort during shutdown.
        }
      }
      for (const permission of pendingPermissions.values()) {
        try {
          client.respond(permission.requestId, { outcome: { outcome: 'cancelled' } });
        } catch {
          // Best effort during shutdown.
        }
      }
      active.killTimer = setTimeout(() => {
        client.kill();
      }, 2000);
      active.killTimer.unref();
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });

    yield this.lifecycle(request.taskId, 'starting', `${this.displayName} starting with ACP`);

    try {
      client.start();
      await client.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: 'kai-agent-workbench', version: '0.3.0' },
      });

      const sessionResult = asRecord(request.resumeSessionId
        ? await client.request('session/load', { sessionId: request.resumeSessionId, cwd, mcpServers: [] })
        : await client.request('session/new', { cwd, mcpServers: [] }));
      const sessionId = typeof sessionResult?.sessionId === 'string' ? sessionResult.sessionId : request.resumeSessionId;
      if (!sessionId) throw new Error('Qwen ACP did not return a session id.');
      active.sessionId = sessionId;

      const mode = qwenModeForAutonomy(request.autonomy);
      const currentMode = asRecord(sessionResult?.modes)?.currentModeId;
      if (currentMode !== mode) {
        await client.request('session/set_mode', { sessionId, modeId: mode });
      }

      acceptUpdates = true;
      const promptPromise = client.request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: request.prompt }] },
        null,
      ).then(
        (result): PromptOutcome => ({ ok: true, result: asRecord(result) }),
        (error: unknown): PromptOutcome => ({ ok: false, error: error instanceof Error ? error : new Error(String(error)) }),
      );

      let outcome: PromptOutcome | undefined;
      let failed = false;
      while (!outcome && !failed) {
        const next = await Promise.race([
          queue.shift().then((event) => ({ kind: 'queued' as const, event })),
          promptPromise.then((prompt) => ({ kind: 'prompt' as const, prompt })),
        ]);
        if (next.kind === 'prompt') {
          outcome = next.prompt;
          for (const event of queue.drain()) {
            const mapped = this.mapQueuedEvent(request.taskId, active, event);
            for (const item of mapped.events) yield item;
            if (mapped.failed) failed = true;
          }
          break;
        }
        const mapped = this.mapQueuedEvent(request.taskId, active, next.event);
        for (const event of mapped.events) yield event;
        if (mapped.failed) failed = true;
      }

      if (controller.signal.aborted) {
        yield this.lifecycle(request.taskId, 'paused', `${this.displayName} stopped by user.`);
      } else if (failed || !outcome?.ok) {
        yield this.errorEvent(request.taskId, outcome?.error?.message || 'Qwen ACP process exited before completing the prompt.');
        yield this.lifecycle(request.taskId, 'failed', `${this.displayName} failed.`);
      } else {
        const usage = extractPromptUsage(outcome.result) ?? latestUsage;
        const cost: CostUpdateEvent = {
          id: createEventId(),
          type: 'cost.update',
          taskId: request.taskId,
          timestamp: nowIso(),
          agent: this.id,
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
          sessionId,
        };
        yield cost;
        yield this.lifecycle(request.taskId, 'completed', `${this.displayName} completed.`);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        yield this.lifecycle(request.taskId, 'paused', `${this.displayName} stopped by user.`);
      } else {
        yield this.errorEvent(request.taskId, error instanceof Error ? error.message : String(error));
        yield this.lifecycle(request.taskId, 'failed', `${this.displayName} failed.`);
      }
    } finally {
      controller.signal.removeEventListener('abort', onAbort);
      if (active.killTimer) clearTimeout(active.killTimer);
      this.activeRuns.delete(request.taskId);
      client.kill();
    }
  }

  stop(taskId?: string): Promise<void> {
    if (taskId) {
      this.activeRuns.get(taskId)?.controller.abort();
      return Promise.resolve();
    }
    for (const run of this.activeRuns.values()) run.controller.abort();
    return Promise.resolve();
  }

  respondToApproval(taskId: string, eventId: string, response: ApprovalResponse): Promise<void> {
    const active = this.activeRuns.get(taskId);
    const pending = active?.pendingPermissions.get(eventId);
    if (!active || !pending) return Promise.resolve();
    active.pendingPermissions.delete(eventId);

    const option = selectPermissionOption(pending.options, response);
    if (!option) {
      active.client.respond(pending.requestId, { outcome: { outcome: 'cancelled' } });
      return Promise.resolve();
    }
    active.client.respond(pending.requestId, {
      outcome: { outcome: 'selected', optionId: option.optionId },
    });
    return Promise.resolve();
  }

  private mapQueuedEvent(
    taskId: string,
    active: ActiveRun,
    queued: QueuedEvent,
  ): { events: WorkbenchEvent[]; failed: boolean } {
    if (queued.kind === 'update') return { events: mapQwenSessionUpdate(taskId, queued.update), failed: false };
    if (queued.kind === 'stderr') {
      return {
        events: [{
          id: createEventId(),
          type: 'raw.fallback',
          taskId,
          timestamp: nowIso(),
          agent: this.id,
          sourceType: 'qwen.stderr',
          payload: queued.text,
        }],
        failed: false,
      };
    }
    if (queued.kind === 'exit') {
      return {
        events: [this.errorEvent(taskId, `Qwen ACP process exited${queued.code === null ? '' : ` with code ${queued.code}`}${queued.signal ? ` (${queued.signal})` : ''}.`)],
        failed: true,
      };
    }

    const toolCall = asRecord(asRecord(queued.params)?.toolCall) ?? {};
    const event = qwenApprovalEvent(taskId, queued.requestId, toolCall);
    active.pendingPermissions.set(event.id, {
      requestId: queued.requestId,
      options: extractPermissionOptions(queued.params),
    });
    return { events: [event], failed: false };
  }

  private lifecycle(
    taskId: string,
    status: 'starting' | 'running' | 'paused' | 'completed' | 'failed',
    detail: string,
  ): WorkbenchEvent {
    return {
      id: createEventId(),
      type: 'agent.lifecycle',
      taskId,
      timestamp: nowIso(),
      agent: this.id,
      status,
      detail,
    };
  }

  private errorEvent(taskId: string, message: string): WorkbenchEvent {
    return {
      id: createEventId(),
      type: 'error',
      taskId,
      timestamp: nowIso(),
      agent: this.id,
      message,
      recoverable: true,
    };
  }
}

export function qwenModeForAutonomy(autonomy: AutonomyMode): string {
  switch (autonomy) {
    case 'plan':
      return 'plan';
    case 'autoEdit':
      return 'auto-edit';
    case 'full':
      return 'yolo';
    case 'ask':
    case 'custom':
    default:
      return 'default';
  }
}

export function mapQwenSessionUpdate(taskId: string, update: Record<string, unknown>): WorkbenchEvent[] {
  const kind = asString(update.sessionUpdate);
  const content = asRecord(update.content);

  if (kind === 'agent_message_chunk') {
    const text = typeof content?.text === 'string' ? content.text : '';
    return text ? [qwenTextEvent(taskId, text, 'assistant')] : [];
  }
  if (kind === 'agent_thought_chunk') {
    const text = typeof content?.text === 'string' ? content.text : '';
    return text ? [qwenTextEvent(taskId, text, 'summary')] : [];
  }
  if (kind === 'tool_call' || kind === 'tool_call_update') {
    const toolName = asString(asRecord(update._meta)?.toolName)
      || asString(update.title)
      || asString(update.kind)
      || 'qwen_tool';
    const status = update.status === 'completed'
      ? 'completed'
      : update.status === 'failed'
        ? 'failed'
        : update.status === 'in_progress' || update.status === 'pending'
          ? 'started'
          : 'updated';
    const event: ToolCallEvent = {
      id: createEventId(),
      type: 'tool.call',
      taskId,
      timestamp: nowIso(),
      agent: 'qwen',
      name: toolName,
      status,
      input: update.rawInput,
      output: update.rawOutput ?? qwenToolOutput(update.content),
    };
    return [event];
  }
  if (kind === 'plan') {
    const entries = Array.isArray(update.entries) ? update.entries : [];
    const text = entries
      .map((entry) => {
        const record = asRecord(entry);
        return record ? `- [${asString(record.status, 'pending')}] ${asString(record.content)}` : '';
      })
      .filter(Boolean)
      .join('\n');
    return text ? [qwenTextEvent(taskId, text, 'summary')] : [];
  }
  if (kind === 'available_commands_update' || kind === 'current_mode_update' || kind === 'config_option_update' || kind === 'session_info_update' || kind === 'usage_update' || kind === 'user_message_chunk') {
    return [];
  }
  return [{
    id: createEventId(),
    type: 'raw.fallback',
    taskId,
    timestamp: nowIso(),
    agent: 'qwen',
    sourceType: `qwen.${kind || 'unknown'}`,
    payload: update,
  }];
}

function qwenTextEvent(taskId: string, text: string, channel: TextDeltaEvent['channel']): TextDeltaEvent {
  return {
    id: createEventId(),
    type: 'text.delta',
    taskId,
    timestamp: nowIso(),
    agent: 'qwen',
    channel,
    text,
  };
}

function qwenApprovalEvent(
  taskId: string,
  requestId: JsonRpcId,
  toolCall: Record<string, unknown>,
): ApprovalRequestEvent {
  const toolName = asString(asRecord(toolCall._meta)?.toolName)
    || asString(toolCall.title)
    || asString(toolCall.kind)
    || 'Qwen tool';
  const rawInput = toolCall.rawInput;
  const detail = typeof rawInput === 'string'
    ? rawInput
    : rawInput !== undefined
      ? JSON.stringify(rawInput)
      : asString(toolCall.title) || `Permission request ${String(requestId)}`;
  return {
    id: createEventId('approval'),
    type: 'approval.request',
    taskId,
    timestamp: nowIso(),
    agent: 'qwen',
    title: toolName,
    detail,
    risk: qwenToolRisk(asString(toolCall.kind)),
  };
}

function qwenToolRisk(kind: string): ApprovalRequestEvent['risk'] {
  if (kind === 'delete' || kind === 'move') return 'high';
  if (kind === 'edit' || kind === 'execute') return 'medium';
  return 'low';
}

function qwenToolOutput(content: unknown): unknown {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    const record = asRecord(item);
    const nested = asRecord(record?.content);
    if (typeof nested?.text === 'string') parts.push(nested.text);
    else if (typeof record?.text === 'string') parts.push(record.text);
  }
  return parts.length ? parts.join('\n') : undefined;
}

function extractPermissionOptions(params: Record<string, unknown>): PermissionOption[] {
  if (!Array.isArray(params.options)) return [];
  return params.options
    .map((value) => {
      const option = asRecord(value);
      if (!option || typeof option.optionId !== 'string') return undefined;
      const kind = asString(option.kind);
      if (kind !== 'allow_once' && kind !== 'allow_always' && kind !== 'reject_once' && kind !== 'reject_always') return undefined;
      const parsed: PermissionOption = {
        optionId: option.optionId,
        kind,
        name: typeof option.name === 'string' ? option.name : undefined,
      };
      return parsed;
    })
    .filter((option): option is PermissionOption => option !== undefined);
}

function selectPermissionOption(options: PermissionOption[], response: ApprovalResponse): PermissionOption | undefined {
  if (response === 'always') {
    return options.find((option) => option.kind === 'allow_always')
      || options.find((option) => option.kind === 'allow_once');
  }
  if (response === 'deny') {
    return options.find((option) => option.kind === 'reject_once')
      || options.find((option) => option.kind === 'reject_always');
  }
  return options.find((option) => option.kind === 'allow_once')
    || options.find((option) => option.kind === 'allow_always');
}

function extractUsage(update: Record<string, unknown>): { inputTokens?: number; outputTokens?: number } | undefined {
  const usage = asRecord(asRecord(update._meta)?.usage);
  if (!usage) return undefined;
  return {
    inputTokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : undefined,
    outputTokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : undefined,
  };
}

function extractPromptUsage(result: Record<string, unknown> | undefined): { inputTokens?: number; outputTokens?: number } | undefined {
  const usage = asRecord(result?.usage);
  if (!usage) return undefined;
  return {
    inputTokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : undefined,
    outputTokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : undefined,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function formatRpcError(error: unknown): string {
  const record = asRecord(error);
  if (!record) return String(error);
  const message = typeof record.message === 'string' ? record.message : 'Qwen ACP request failed.';
  return typeof record.code === 'number' ? `${message} (${record.code})` : message;
}

const defaultSpawn: AcpSpawn = (command, args, options) => {
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: options.shell,
    windowsHide: options.windowsHide,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
};
