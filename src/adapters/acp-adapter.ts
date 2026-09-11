import { createEventId, nowIso, type WorkbenchEvent } from '../core/events';
import type { AgentCapability, AgentId } from '../core/types';
import type { AgentAdapter, AgentRunRequest } from './agent-adapter';
import { NodeProcessRunner, type ProcessRunner, isProcessResult } from './process-runner';
import type { StreamLineParser } from './process-agent-adapter';

export interface AcpAdapterOptions {
  id: AgentId;
  displayName: string;
  command: string;
  acpArgs?: string[];
  /** Optional pluggable parser. Falls back to generic ACP parsing if not provided. */
  parseLine?: StreamLineParser;
}

/**
 * ACP (Agent Communication Protocol) adapter for Qwen Code and Gemini CLI.
 *
 * Both expose an ACP interface (a standardised JSON-line protocol). This
 * adapter wraps the agent process and maps its output into the unified
 * WorkbenchEvent model.
 *
 * Supports optional pluggable {@link StreamLineParser} injection for
 * agent-specific parsing, matching the ProcessAgentAdapter pattern.
 * When no parser is provided, a built-in generic ACP parser handles
 * common shapes.
 */
export class AcpAgentAdapter implements AgentAdapter {
  readonly id: AgentId;
  private readonly displayName: string;
  private readonly command: string;
  private readonly acpArgs: string[];
  private readonly parseLine?: StreamLineParser;
  private readonly runner: ProcessRunner;
  private readonly activeRuns = new Map<string, AbortController>();

  constructor(options: AcpAdapterOptions, runner?: ProcessRunner) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.command = options.command;
    this.acpArgs = options.acpArgs ?? ['--acp'];
    this.parseLine = options.parseLine;
    this.runner = runner ?? new NodeProcessRunner();
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
      supportsAutonomy: ['review', 'auto', 'custom'],
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
      yield this.errorEvent(
        request.taskId,
        `${this.displayName} unavailable: ${capability.unavailableReason || 'command missing'}`,
      );
      return;
    }

    const controller = new AbortController();
    const carry = new Map<'stdout' | 'stderr', string>([
      ['stdout', ''],
      ['stderr', ''],
    ]);
    this.activeRuns.set(request.taskId, controller);

    yield this.lifecycle(request.taskId, 'starting', `${this.displayName} starting with ACP`);

    try {
      for await (const chunk of this.runner.run(this.command, this.acpArgs, request.cwd, controller.signal, request.prompt)) {
        if (isProcessResult(chunk)) {
          yield* this.parseOutput(request, carry.get('stdout') || '', 'stdout');
          yield* this.parseOutput(request, carry.get('stderr') || '', 'stderr');
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
        yield* this.parseOutput(request, parts.join('\n'), chunk.stream);
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

  private *parseOutput(
    request: AgentRunRequest,
    text: string,
    stream: 'stdout' | 'stderr',
  ): Iterable<WorkbenchEvent> {
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

      // Use the pluggable parser if provided
      if (this.parseLine) {
        const events = this.parseLine(line, request.taskId, this.id);
        if (events) {
          yield* Array.isArray(events) ? events : [events];
        }
        continue;
      }

      // Fall back to generic ACP parsing
      yield* this.genericAcpParse(line, request);
    }
  }

  private *genericAcpParse(
    line: string,
    request: AgentRunRequest,
  ): Iterable<WorkbenchEvent> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      yield {
        id: createEventId(),
        type: 'text.delta',
        taskId: request.taskId,
        timestamp: nowIso(),
        agent: this.id,
        channel: 'assistant',
        text: line,
      };
      return;
    }

    if (!parsed || typeof parsed !== 'object') return;
    const event = parsed as Record<string, unknown>;

    // ACP text delta
    const textContent = event.delta || event.text || event.content || event.message;
    if (typeof textContent === 'string' && textContent.trim()) {
      yield {
        id: createEventId(),
        type: 'text.delta',
        taskId: request.taskId,
        timestamp: nowIso(),
        agent: this.id,
        channel: 'assistant',
        text: textContent,
      };
      return;
    }

    // ACP tool call
    if (event.type === 'tool_call' || event.tool) {
      yield {
        id: createEventId(),
        type: 'tool.call',
        taskId: request.taskId,
        timestamp: nowIso(),
        agent: this.id,
        name: String(event.tool || event.name || 'unknown'),
        status: (event.status as 'started' | 'completed' | 'failed') || 'started',
        input: event.input || event.arguments,
      };
      return;
    }

    // ACP diff
    if (event.type === 'diff' || event.type === 'file_edit') {
      yield {
        id: createEventId(),
        type: 'diff.proposal',
        taskId: request.taskId,
        timestamp: nowIso(),
        agent: this.id,
        filePath: String(event.file || event.path || ''),
        summary: String(event.summary || event.description || 'File edit proposed'),
        diff: typeof event.diff === 'string' ? event.diff : undefined,
      };
      return;
    }

    // ACP approval
    if (event.type === 'approval' || event.type === 'permission_request') {
      yield {
        id: createEventId(),
        type: 'approval.request',
        taskId: request.taskId,
        timestamp: nowIso(),
        agent: this.id,
        title: String(event.title || event.action || 'Approval required'),
        detail: String(event.detail || event.description || ''),
        risk: (event.risk as 'low' | 'medium' | 'high') || 'medium',
      };
      return;
    }

    // ACP error
    if (event.type === 'error' || event.error) {
      yield {
        id: createEventId(),
        type: 'error',
        taskId: request.taskId,
        timestamp: nowIso(),
        agent: this.id,
        message: String(event.error || event.message || 'ACP error'),
        recoverable: true,
      };
      return;
    }

    // ACP cost
    if (event.type === 'usage' || event.usage) {
      const usage = (event.usage || event) as Record<string, unknown>;
      yield {
        id: createEventId(),
        type: 'cost.update',
        taskId: request.taskId,
        timestamp: nowIso(),
        agent: this.id,
        inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined,
        outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined,
      };
      return;
    }

    // ACP lifecycle — suppress noisy system events
    if (event.type === 'system' || event.type === 'ping' || event.type === 'done') {
      return;
    }

    // Raw fallback
    yield {
      id: createEventId(),
      type: 'raw.fallback',
      taskId: request.taskId,
      timestamp: nowIso(),
      agent: this.id,
      sourceType: `acp.${String(event.type || 'unknown')}`,
      payload: parsed,
    };
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
