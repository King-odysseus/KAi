import { createEventId, nowIso, type WorkbenchEvent } from '../core/events';
import type { AgentId } from '../core/types';
import type { StreamLineParser } from '../adapters/process-agent-adapter';

/**
 * Gemini CLI ACP (Agent Communication Protocol) JSON-line event shapes.
 *
 * Gemini CLI uses a variant of ACP with slightly different field names
 * compared to Qwen Code (e.g., "candidates"-style nesting for text,
 * "functionCall" instead of "tool_call").
 */
export interface GeminiStreamEvent {
  type?: string;
  delta?: string;
  text?: string;
  content?: string;
  message?: string;
  // Gemini-specific: sometimes wraps content in candidates array
  candidates?: GeminiCandidate[];
  // Tool calls
  functionCall?: GeminiFunctionCall;
  tool?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_arguments?: unknown;
  // File edits
  file?: string;
  path?: string;
  diff?: string;
  edit_summary?: string;
  summary?: string;
  description?: string;
  // Approval
  action?: string;
  title?: string;
  detail?: string;
  risk?: string;
  // Usage
  usage?: GeminiUsage;
  usageMetadata?: GeminiUsage;
  // Error
  error?: string | { message?: string; code?: number };
  [key: string]: unknown;
}

interface GeminiCandidate {
  content?: {
    parts?: GeminiPart[];
    role?: string;
  };
  finishReason?: string;
}

interface GeminiPart {
  text?: string;
  functionCall?: GeminiFunctionCall;
  functionResponse?: GeminiFunctionResponse;
}

interface GeminiFunctionCall {
  name?: string;
  args?: unknown;
}

interface GeminiFunctionResponse {
  name?: string;
  response?: unknown;
}

interface GeminiUsage {
  input_tokens?: number;
  output_tokens?: number;
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

/**
 * Parses a single JSON line from Gemini CLI's ACP output into a
 * WorkbenchEvent, or returns null to suppress the line.
 */
export const parseGeminiJsonLine: StreamLineParser = (
  line: string,
  taskId: string,
  agent: AgentId,
): WorkbenchEvent | WorkbenchEvent[] | null => {
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

  const event = parsed as GeminiStreamEvent;

  // Gemini candidates array — extract text from parts
  if (event.candidates && event.candidates.length > 0) {
    const candidate = event.candidates[0];
    if (candidate?.content?.parts) {
      for (const part of candidate.content.parts) {
        if (part.text?.trim()) {
          return {
            id: createEventId(),
            type: 'text.delta',
            taskId,
            timestamp: nowIso(),
            agent,
            channel: 'assistant',
            text: part.text,
          };
        }
        if (part.functionCall) {
          return {
            id: createEventId(),
            type: 'tool.call',
            taskId,
            timestamp: nowIso(),
            agent,
            name: part.functionCall.name || 'unknown',
            status: 'started',
            input: part.functionCall.args,
          };
        }
        if (part.functionResponse) {
          return {
            id: createEventId(),
            type: 'tool.call',
            taskId,
            timestamp: nowIso(),
            agent,
            name: part.functionResponse.name || 'unknown',
            status: 'completed',
            output: part.functionResponse.response,
          };
        }
      }
    }
  }

  // Text deltas from flat fields
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

  // Tool calls — Gemini uses functionCall
  if (event.functionCall) {
    return {
      id: createEventId(),
      type: 'tool.call',
      taskId,
      timestamp: nowIso(),
      agent,
      name: event.functionCall.name || 'unknown',
      status: 'started',
      input: event.functionCall.args,
    };
  }

  if (event.type === 'tool_call' || event.type === 'tool_use' || event.tool || event.tool_name) {
    return {
      id: createEventId(),
      type: 'tool.call',
      taskId,
      timestamp: nowIso(),
      agent,
      name: String(event.tool || event.tool_name || 'unknown'),
      status: 'started',
      input: event.tool_input || event.tool_arguments,
    };
  }

  // File edits
  if (event.type === 'diff' || event.type === 'file_edit' || event.type === 'edit') {
    return {
      id: createEventId(),
      type: 'diff.proposal',
      taskId,
      timestamp: nowIso(),
      agent,
      filePath: String(event.file || event.path || ''),
      summary: String(event.edit_summary || event.summary || event.description || 'File edit proposed'),
      diff: typeof event.diff === 'string' ? event.diff : undefined,
    };
  }

  // Approval
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

  // Usage / cost — Gemini may nest under usageMetadata
  const usageData = event.usage || event.usageMetadata;
  if (usageData) {
    return {
      id: createEventId(),
      type: 'cost.update',
      taskId,
      timestamp: nowIso(),
      agent,
      inputTokens:
        typeof usageData.input_tokens === 'number'
          ? usageData.input_tokens
          : typeof usageData.promptTokenCount === 'number'
            ? usageData.promptTokenCount
            : undefined,
      outputTokens:
        typeof usageData.output_tokens === 'number'
          ? usageData.output_tokens
          : typeof usageData.candidatesTokenCount === 'number'
            ? usageData.candidatesTokenCount
            : undefined,
    };
  }

  // Errors
  if (event.error) {
    const errMsg =
      typeof event.error === 'string'
        ? event.error
        : event.error.message || 'Gemini reported an error';
    return {
      id: createEventId(),
      type: 'error',
      taskId,
      timestamp: nowIso(),
      agent,
      message: errMsg,
      recoverable: true,
    };
  }

  // System / lifecycle — suppress noise
  if (
    event.type === 'system' ||
    event.type === 'ping' ||
    event.type === 'done' ||
    event.type === 'complete' ||
    event.type === 'init'
  ) {
    return null;
  }

  // Raw fallback
  return {
    id: createEventId(),
    type: 'raw.fallback',
    taskId,
    timestamp: nowIso(),
    agent,
    sourceType: `gemini.${String(event.type || 'unknown')}`,
    payload: parsed,
  };
};
