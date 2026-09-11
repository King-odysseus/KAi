import { createEventId, nowIso, type WorkbenchEvent } from '../core/events';
import type { AgentCapability, AgentId } from '../core/types';
import type { AgentAdapter, AgentRunRequest } from './agent-adapter';
import { isProcessResult, NodeProcessRunner, type ProcessRunner } from './process-runner';

export type StreamLineParser = (
  line: string,
  taskId: string,
  agent: AgentId,
) => WorkbenchEvent | WorkbenchEvent[] | null;

export interface ProcessAgentAdapterOptions {
  id: AgentId;
  displayName: string;
  command: string;
  buildArgs: (request: AgentRunRequest) => string[];
  beforeRun?: (request: AgentRunRequest) => Promise<WorkbenchEvent[]>;
  parseLine?: StreamLineParser;
  supportsApprovals?: boolean;
  supportsMcp?: boolean;
  runner?: ProcessRunner;
}

export class ProcessAgentAdapter implements AgentAdapter {
  readonly id: AgentId;
  private readonly displayName: string;
  private readonly command: string;
  private readonly buildArgs: (request: AgentRunRequest) => string[];
  private readonly beforeRun?: (request: AgentRunRequest) => Promise<WorkbenchEvent[]>;
  private readonly parseLine?: StreamLineParser;
  private readonly supportsApprovals: boolean;
  private readonly supportsMcp: boolean;
  private readonly runner: ProcessRunner;
  private readonly activeRuns = new Map<string, AbortController>();

  constructor(options: ProcessAgentAdapterOptions) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.command = options.command;
    this.buildArgs = options.buildArgs;
    this.beforeRun = options.beforeRun;
    this.parseLine = options.parseLine;
    this.supportsApprovals = options.supportsApprovals ?? false;
    this.supportsMcp = options.supportsMcp ?? false;
    this.runner = options.runner ?? new NodeProcessRunner();
  }

  async getCapability(): Promise<AgentCapability> {
    const info = await this.runner.commandInfo(this.command);
    return {
      id: this.id,
      displayName: this.displayName,
      available: info.available,
      version: info.version,
      unavailableReason: info.available ? undefined : info.detail || `${this.command} was not found.`,
      supportsRoutes: ['direct', 'proxy'],
      supportsAutonomy: ['review', 'auto', 'custom'],
      supportsTools: true,
      supportsApprovals: this.supportsApprovals,
      supportsDiffs: true,
      supportsMcp: this.supportsMcp,
      requiredConfigKeys: [],
    };
  }

  async *run(request: AgentRunRequest): AsyncIterable<WorkbenchEvent> {
    const capability = await this.getCapability();
    if (!capability.available) {
      yield this.errorEvent(request.taskId, `${this.displayName} unavailable: ${capability.unavailableReason || 'command missing'}`);
      return;
    }

    for (const event of await this.beforeRun?.(request) ?? []) {
      yield event;
    }

    const args = this.buildArgs(request);
    const controller = new AbortController();
    const carry = new Map<'stdout' | 'stderr', string>([
      ['stdout', ''],
      ['stderr', ''],
    ]);
    this.activeRuns.set(request.taskId, controller);
    yield this.lifecycle(request.taskId, 'starting', `${this.displayName} starting with ${request.route}/${request.autonomy}`);

    try {
      for await (const chunk of this.runner.run(this.command, args, request.cwd, controller.signal, request.prompt)) {
        if (isProcessResult(chunk)) {
          yield* this.mapOutput(request, carry.get('stdout') || '', 'stdout');
          yield* this.mapOutput(request, carry.get('stderr') || '', 'stderr');
          carry.set('stdout', '');
          carry.set('stderr', '');
          if (controller.signal.aborted) {
            yield this.lifecycle(request.taskId, 'paused', `${this.displayName} stopped by user.`);
          } else if (chunk.code === 0) {
            yield this.lifecycle(request.taskId, 'completed', `${this.displayName} completed.`);
          } else {
            yield this.errorEvent(
              request.taskId,
              `${this.displayName} exited with code ${chunk.code ?? 'unknown'}${chunk.signal ? ` (${chunk.signal})` : ''}.`,
            );
          }
          continue;
        }

        const buffered = `${carry.get(chunk.stream) || ''}${chunk.text}`;
        const parts = buffered.split(/\r?\n/);
        carry.set(chunk.stream, parts.pop() || '');
        yield* this.mapOutput(request, parts.join('\n'), chunk.stream);
      }
    } finally {
      this.activeRuns.delete(request.taskId);
    }
  }

  async stop(taskId?: string): Promise<void> {
    if (taskId) {
      this.activeRuns.get(taskId)?.abort();
      return;
    }

    for (const controller of this.activeRuns.values()) {
      controller.abort();
    }
  }

  private *mapOutput(request: AgentRunRequest, text: string, stream: 'stdout' | 'stderr'): Iterable<WorkbenchEvent> {
    const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
    for (const line of lines) {
      if (stream === 'stderr') {
        yield {
          id: createEventId(),
          type: 'raw.fallback',
          taskId: request.taskId,
          timestamp: nowIso(),
          agent: this.id,
          sourceType: `${this.id}.stderr`,
          payload: line,
        };
        continue;
      }

      if (this.parseLine) {
        const events = this.parseLine(line, request.taskId, this.id);
        if (events) {
          yield* Array.isArray(events) ? events : [events];
        }
        continue;
      }

      // Generic fallback parsing when no agent-specific parser is provided
      yield* this.genericParse(line, request);
    }
  }

  private *genericParse(line: string, request: AgentRunRequest): Iterable<WorkbenchEvent> {
    const parsed = tryParseJson(line);
    if (parsed) {
      const textEvent = extractText(parsed);
      if (textEvent) {
        yield {
          id: createEventId(),
          type: 'text.delta',
          taskId: request.taskId,
          timestamp: nowIso(),
          agent: this.id,
          channel: 'assistant',
          text: textEvent,
        };
      } else {
        yield {
          id: createEventId(),
          type: 'raw.fallback',
          taskId: request.taskId,
          timestamp: nowIso(),
          agent: this.id,
          sourceType: `${this.id}.json`,
          payload: parsed,
        };
      }
    } else {
      yield {
        id: createEventId(),
        type: 'text.delta',
        taskId: request.taskId,
        timestamp: nowIso(),
        agent: this.id,
        channel: 'assistant',
        text: line,
      };
    }
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

export function buildCodexArgs(profile: string | undefined, request: AgentRunRequest): string[] {
  const sandbox = request.autonomy === 'review' ? 'read-only' : 'workspace-write';
  const args = ['exec', '--json', '--sandbox', sandbox];
  if (request.cwd) {
    args.push('--cd', request.cwd);
  }
  if (request.route === 'proxy' && profile) {
    args.push('--profile', profile);
  }
  args.push('-');
  return args;
}

export function buildClaudeArgs(request: AgentRunRequest): string[] {
  // Non-streaming JSON mode: 3-5x faster through the proxy than stream-json --verbose.
  // The parser handles 'result' type events from --output-format json.
  const permissionMode = request.autonomy === 'auto' ? 'acceptEdits' : 'default';
  return ['-p', '--output-format', 'json', '--permission-mode', permissionMode];
}

function tryParseJson(line: string): unknown | undefined {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function extractText(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['text', 'message', 'delta', 'content']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate;
    }
  }
  return undefined;
}
