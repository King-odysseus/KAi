import { createEventId, nowIso, type WorkbenchEvent } from '../core/events';
import type { AgentId } from '../core/types';

export interface ClaudeStreamEvent {
  type?: string;
  message?: ClaudeMessage;
  usage?: ClaudeUsage;
  error?: { type?: string; message?: string };
  [key: string]: unknown;
}

interface ClaudeMessage {
  role?: string;
  content?: ClaudeContentBlock[];
  id?: string;
  model?: string;
  stop_reason?: string;
  usage?: ClaudeUsage;
}

interface ClaudeContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  id?: string;
  content?: string | ClaudeContentBlock[];
  [key: string]: unknown;
}

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export function parseClaudeJsonLine(
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

  const event = parsed as ClaudeStreamEvent;

  // Usage/cost — check before type-matching since usage can appear on any event
  if (event.usage) {
    return parseUsageEvent(event.usage, taskId, agent);
  }

  const evtType = event.type;

  // Assistant message with content blocks
  if (evtType === 'assistant' || evtType === 'message' || evtType === 'content_block_delta') {
    return parseAssistantEvent(event, taskId, agent);
  }

  // Fallback for messages with content but unusual type
  if (event.message?.content) {
    return parseAssistantEvent(event, taskId, agent);
  }

  // Error events
  if (event.error) {
    return {
      id: createEventId(),
      type: 'error',
      taskId,
      timestamp: nowIso(),
      agent,
      message: event.error.message || JSON.stringify(event.error),
      recoverable: true,
    };
  }

  // System / lifecycle
  if (evtType === 'system' || evtType === 'ping') {
    return null;
  }

  // Raw fallback for anything unrecognized
  return {
    id: createEventId(),
    type: 'raw.fallback',
    taskId,
    timestamp: nowIso(),
    agent,
    sourceType: `claude.${evtType || 'unknown'}`,
    payload: parsed,
  };
}

function parseAssistantEvent(event: ClaudeStreamEvent, taskId: string, agent: AgentId): WorkbenchEvent | null {
  const blocks = event.message?.content ?? [];
  if (blocks.length === 0) {
    return null;
  }

  for (const block of blocks) {
    if (block.type === 'text' && block.text?.trim()) {
      return {
        id: createEventId(),
        type: 'text.delta',
        taskId,
        timestamp: nowIso(),
        agent,
        channel: 'assistant',
        text: block.text,
      };
    }

    if (block.type === 'tool_use') {
      return {
        id: createEventId(),
        type: 'tool.call',
        taskId,
        timestamp: nowIso(),
        agent,
        name: block.name || 'unknown',
        status: 'started',
        input: block.input,
      };
    }
  }

  return null;
}

function parseUsageEvent(usage: ClaudeUsage, taskId: string, agent: AgentId): WorkbenchEvent {
  return {
    id: createEventId(),
    type: 'cost.update',
    taskId,
    timestamp: nowIso(),
    agent,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
  };
}
