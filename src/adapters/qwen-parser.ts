import { createEventId, nowIso, type WorkbenchEvent } from '../core/events';
import type { AgentId } from '../core/types';
import type { StreamLineParser } from '../adapters/process-agent-adapter';

/**
 * Qwen Code ACP (Agent Communication Protocol) JSON-line event shapes.
 */
export interface QwenStreamEvent {
  type?: string;
  delta?: string;
  text?: string;
  content?: string;
  message?: string;
  tool?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_arguments?: unknown;
  file?: string;
  path?: string;
  diff?: string;
  summary?: string;
  description?: string;
  action?: string;
  title?: string;
  detail?: string;
  risk?: string;
  error?: string;
  usage?: QwenUsage;
  [key: string]: unknown;
}

interface QwenUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

/**
 * Parses a single JSON line from Qwen Code's ACP output into a
 * WorkbenchEvent, or returns null to suppress the line.
 */
export const parseQwenJsonLine: StreamLineParser = (
  line: string,
  taskId: string,
  agent: AgentId,
): WorkbenchEvent | null => {
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

  const event = parsed as QwenStreamEvent;

  // Tool results — check BEFORE text extraction since they may contain 'content' field
  if (event.type === 'tool_result') {
    return {
      id: createEventId(),
      type: 'tool.call',
      taskId,
      timestamp: nowIso(),
      agent,
      name: String(event.tool || event.tool_name || 'unknown'),
      status: 'completed',
      output: event.content || event.text,
    };
  }

  // Tool calls — Qwen uses tool, tool_name
  if (event.type === 'tool_call' || event.type === 'tool_use' || event.tool || event.tool_name) {
    return {
      id: createEventId(),
      type: 'tool.call',
      taskId,
      timestamp: nowIso(),
      agent,
      name: String(event.tool || event.tool_name || event.type || 'unknown'),
      status: 'started',
      input: event.tool_input || event.tool_arguments,
    };
  }

  // Text deltas — Qwen uses delta, text, content, or message
  const textContent = event.delta || event.text || event.content || event.message;
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

  // File edits / diffs
  if (event.type === 'diff' || event.type === 'file_edit' || event.type === 'edit') {
    return {
      id: createEventId(),
      type: 'diff.proposal',
      taskId,
      timestamp: nowIso(),
      agent,
      filePath: String(event.file || event.path || ''),
      summary: String(event.summary || event.description || 'File edit proposed'),
      diff: typeof event.diff === 'string' ? event.diff : undefined,
    };
  }

  // Approval / permission requests
  if (event.type === 'approval' || event.type === 'permission_request') {
    return {
      id: createEventId(),
      type: 'approval.request',
      taskId,
      timestamp: nowIso(),
      agent,
      title: String(event.title || event.action || 'Approval required'),
      detail: String(event.detail || event.description || ''),
      risk: (event.risk as 'low' | 'medium' | 'high') || 'medium',
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
      inputTokens: typeof event.usage.input_tokens === 'number' ? event.usage.input_tokens : undefined,
      outputTokens: typeof event.usage.output_tokens === 'number' ? event.usage.output_tokens : undefined,
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
      message: String(event.error || 'Qwen reported an error'),
      recoverable: true,
    };
  }

  // System / lifecycle — suppress noise
  if (event.type === 'system' || event.type === 'ping' || event.type === 'done' || event.type === 'init') {
    return null;
  }

  // Raw fallback for anything unrecognized
  return {
    id: createEventId(),
    type: 'raw.fallback',
    taskId,
    timestamp: nowIso(),
    agent,
    sourceType: `qwen.${String(event.type || 'unknown')}`,
    payload: parsed,
  };
};
