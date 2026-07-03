import { describe, expect, it } from 'vitest';
import { parseClaudeJsonLine } from '../src/adapters/claude-parser';

describe('parseClaudeJsonLine', () => {
  const taskId = 'task_1';
  const agent = 'claude' as const;

  it('parses assistant text into text.delta', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Hello, how can I help?' }],
      },
    });
    const result = parseClaudeJsonLine(line, taskId, agent);
    expect(result).toMatchObject({
      type: 'text.delta',
      channel: 'assistant',
      text: 'Hello, how can I help?',
    });
  });

  it('parses tool_use into tool.call', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          name: 'read_file',
          input: { path: '/src/app.ts' },
        }],
      },
    });
    const result = parseClaudeJsonLine(line, taskId, agent);
    expect(result).toMatchObject({
      type: 'tool.call',
      name: 'read_file',
      status: 'started',
      input: { path: '/src/app.ts' },
    });
  });

  it('parses usage into cost.update', () => {
    const line = JSON.stringify({
      type: 'message',
      usage: { input_tokens: 150, output_tokens: 80 },
    });
    const result = parseClaudeJsonLine(line, taskId, agent);
    expect(result).toMatchObject({
      type: 'cost.update',
      inputTokens: 150,
      outputTokens: 80,
    });
  });

  it('falls back to text.delta (raw) for non-JSON lines', () => {
    const result = parseClaudeJsonLine('just some plain text', taskId, agent);
    expect(result).toMatchObject({
      type: 'text.delta',
      channel: 'raw',
      text: 'just some plain text',
    });
  });

  it('suppresses system/ping events', () => {
    expect(parseClaudeJsonLine(JSON.stringify({ type: 'system' }), taskId, agent)).toBeNull();
    expect(parseClaudeJsonLine(JSON.stringify({ type: 'ping' }), taskId, agent)).toBeNull();
  });

  it('emits error events', () => {
    const line = JSON.stringify({
      type: 'error',
      error: { type: 'overloaded', message: 'Service overloaded' },
    });
    const result = parseClaudeJsonLine(line, taskId, agent);
    expect(result).toMatchObject({
      type: 'error',
      message: 'Service overloaded',
    });
  });

  it('raw-falls back for unrecognized JSON shapes', () => {
    const result = parseClaudeJsonLine(JSON.stringify({ type: 'unknown_thing', data: 42 }), taskId, agent);
    expect(result).toMatchObject({
      type: 'raw.fallback',
      sourceType: 'claude.unknown_thing',
    });
  });
});
