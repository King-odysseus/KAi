import { createEventId, nowIso, type WorkbenchEvent } from '../core/events';
import type { AgentId } from '../core/types';

export interface CodexStreamEvent {
  type?: string;
  content?: string;
  delta?: string;
  message?: string;
  tool?: string;
  tool_input?: unknown;
  tool_output?: unknown;
  file?: string;
  diff?: string;
  edit_summary?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: string;
  [key: string]: unknown;
}

export function parseCodexJsonLine(
  line: string,
  taskId: string,
  agent: AgentId,
): WorkbenchEvent | null {
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

  // Text deltas from assistant/content/delta fields
  const textContent = event.delta || event.content || event.message;
  if (typeof textContent === 'string' && textContent.trim()) {
    return {
      id: createEventId(),
      type: 'text.delta',
      taskId,
      timestamp: nowIso(),
      agent,
      channel: 'assistant',
      text: textContent,
    };
  }

  // Tool calls
  if (event.type === 'tool_call' || event.type === 'tool_use' || event.tool) {
    return {
      id: createEventId(),
      type: 'tool.call',
      taskId,
      timestamp: nowIso(),
      agent,
      name: event.tool || event.type || 'unknown',
      status: event.type === 'tool_result' ? 'completed' : 'started',
      input: event.tool_input,
      output: event.tool_output,
    };
  }

  // File edits / diffs
  if (event.type === 'file_edit' || event.type === 'diff' || event.file) {
    return {
      id: createEventId(),
      type: 'diff.proposal',
      taskId,
      timestamp: nowIso(),
      agent,
      filePath: event.file || '',
      summary: event.edit_summary || event.message || 'File edit proposed',
      diff: event.diff,
    };
  }

  // Usage / cost
  if (event.usage) {
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

  // Errors
  if (event.error || event.type === 'error') {
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

  // Lifecycle events
  if (event.type === 'done' || event.type === 'complete' || event.type === 'exit') {
    return null; // handled by process exit code
  }

  // Raw fallback
  return {
    id: createEventId(),
    type: 'raw.fallback',
    taskId,
    timestamp: nowIso(),
    agent,
    sourceType: `codex.${event.type || 'unknown'}`,
    payload: parsed,
  };
}
