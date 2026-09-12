import { createEventId, nowIso, type WorkbenchEvent } from '../core/events';
import type { AgentId } from '../core/types';

/**
 * `codex exec --json` event shapes, verified against real output from
 * `codex exec --json --sandbox read-only "<prompt>"` (codex-cli 0.153.4):
 *
 *   {"type":"thread.started","thread_id":"01a090b5-c6d2-7063-9bbc-bf9170a80787"}
 *   {"type":"turn.started"}
 *   {"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"...","aggregated_output":"","exit_code":null,"status":"in_progress"}}
 *   {"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"...","aggregated_output":"...","exit_code":0,"status":"completed"}}
 *   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"..."}}
 *   {"type":"turn.completed","usage":{"input_tokens":9856,"cached_input_tokens":0,"cache_write_input_tokens":9853,"output_tokens":11,"reasoning_output_tokens":0}}
 *
 * This is a materially different shape from the flat delta/tool_input
 * fields the previous version of this parser expected — none of those
 * matched real output, so every Codex reply fell through to raw.fallback.
 * Item types beyond agent_message/command_execution (a file edit item, for
 * instance) haven't been observed directly; they fall through to
 * raw.fallback rather than guessing field names, same as any other
 * unrecognized shape.
 */
export interface CodexItem {
  id?: string;
  type?: string; // 'agent_message' | 'command_execution' | 'reasoning' | ...
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  changes?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

export interface CodexStreamEvent {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: CodexUsage;
  error?: string;
  [key: string]: unknown;
}

export function parseCodexJsonLine(
  line: string,
  taskId: string,
  agent: AgentId,
): WorkbenchEvent | WorkbenchEvent[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return {
      id: createEventId(),
      type: 'text.delta',
      taskId,
      timestamp: nowIso(),
      agent,
      channel: 'raw',
      text: line,
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const event = parsed as CodexStreamEvent;

  // Session id, needed for `codex exec resume <id>` — carried on a
  // cost.update event the same way Claude's parser carries session_id,
  // since sessionId is the field the rest of KAI already reads for this.
  if (event.type === 'thread.started' && event.thread_id) {
    return {
      id: createEventId(),
      type: 'cost.update',
      taskId,
      timestamp: nowIso(),
      agent,
      sessionId: event.thread_id,
    };
  }

  // Errors
  if (event.type === 'error' || event.error) {
    return {
      id: createEventId(),
      type: 'error',
      taskId,
      timestamp: nowIso(),
      agent,
      message: event.error || 'Codex reported an error',
      recoverable: true,
    };
  }

  const item = event.item;

  if (item?.type === 'agent_message') {
    if (event.type === 'item.completed' && typeof item.text === 'string' && item.text.trim()) {
      return {
        id: createEventId(),
        type: 'text.delta',
        taskId,
        timestamp: nowIso(),
        agent,
        channel: 'assistant',
        text: item.text,
      };
    }
    return null; // item.started for agent_message carries no text yet
  }

  if (item?.type === 'reasoning') {
    if (event.type === 'item.completed' && typeof item.text === 'string' && item.text.trim()) {
      return {
        id: createEventId(),
        type: 'text.delta',
        taskId,
        timestamp: nowIso(),
        agent,
        channel: 'summary',
        text: item.text,
      };
    }
    return null;
  }

  if (item?.type === 'command_execution') {
    if (event.type === 'item.started') {
      return {
        id: createEventId(),
        type: 'tool.call',
        taskId,
        timestamp: nowIso(),
        agent,
        name: 'command_execution',
        status: 'started',
        input: item.command,
      };
    }
    if (event.type === 'item.completed') {
      return {
        id: createEventId(),
        type: 'tool.call',
        taskId,
        timestamp: nowIso(),
        agent,
        name: 'command_execution',
        status: item.exit_code === 0 ? 'completed' : 'failed',
        input: item.command,
        output: item.aggregated_output,
      };
    }
  }

  if (item?.type === 'file_change') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    return changes.flatMap((change) => {
      const rawPath = typeof change.path === 'string' ? change.path : undefined;
      if (!rawPath) return [];
      const kind = typeof change.kind === 'string' ? change.kind : 'update';
      const action = kind === 'add' ? 'created' : kind === 'delete' ? 'deleted' : 'edited';
      return [{
        id: createEventId(),
        type: 'file.change' as const,
        taskId,
        timestamp: nowIso(),
        agent,
        path: rawPath,
        action,
        added: typeof change.added === 'number' ? change.added : undefined,
        removed: typeof change.removed === 'number' ? change.removed : undefined,
      }];
    });
  }

  // Usage/cost at the end of a turn
  if (event.type === 'turn.completed' && event.usage) {
    return {
      id: createEventId(),
      type: 'cost.update',
      taskId,
      timestamp: nowIso(),
      agent,
      inputTokens: event.usage.input_tokens,
      outputTokens: event.usage.output_tokens,
    };
  }

  // Lifecycle noise — handled by process exit code, nothing to show
  if (event.type === 'turn.started' || event.type === 'turn.completed') {
    return null;
  }

  // Raw fallback for anything unrecognized (including item types we
  // haven't observed and confirmed the field shape of yet)
  return {
    id: createEventId(),
    type: 'raw.fallback',
    taskId,
    timestamp: nowIso(),
    agent,
    sourceType: `codex.${event.type || item?.type || 'unknown'}`,
    payload: parsed,
  };
}
