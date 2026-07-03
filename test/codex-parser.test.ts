import { describe, expect, it } from 'vitest';
import { parseCodexJsonLine } from '../src/adapters/codex-parser';

describe('parseCodexJsonLine', () => {
  const taskId = 'task_1';
  const agent = 'codex' as const;

  it('parses delta into text.delta', () => {
    const line = JSON.stringify({ delta: 'Here is the fix for your code.' });
    const result = parseCodexJsonLine(line, taskId, agent);
    expect(result).toMatchObject({
      type: 'text.delta',
      channel: 'assistant',
      text: 'Here is the fix for your code.',
    });
  });

  it('parses content into text.delta', () => {
    const line = JSON.stringify({ type: 'assistant', content: 'Sure, let me look at that.' });
    const result = parseCodexJsonLine(line, taskId, agent);
    expect(result).toMatchObject({
      type: 'text.delta',
      channel: 'assistant',
      text: 'Sure, let me look at that.',
    });
  });

  it('parses tool_call into tool.call', () => {
    const line = JSON.stringify({
      type: 'tool_call',
      tool: 'write_file',
      tool_input: { path: '/src/app.ts', content: 'export {}' },
    });
    const result = parseCodexJsonLine(line, taskId, agent);
    expect(result).toMatchObject({
      type: 'tool.call',
      name: 'write_file',
      status: 'started',
    });
  });

  it('parses file_edit into diff.proposal', () => {
    const line = JSON.stringify({
      type: 'file_edit',
      file: '/src/app.ts',
      edit_summary: 'Added export statement',
      diff: '+export {}',
    });
    const result = parseCodexJsonLine(line, taskId, agent);
    expect(result).toMatchObject({
      type: 'diff.proposal',
      filePath: '/src/app.ts',
      summary: 'Added export statement',
      diff: '+export {}',
    });
  });

  it('parses usage into cost.update', () => {
    const line = JSON.stringify({
      type: 'usage',
      usage: { input_tokens: 200, output_tokens: 100 },
    });
    const result = parseCodexJsonLine(line, taskId, agent);
    expect(result).toMatchObject({
      type: 'cost.update',
      inputTokens: 200,
      outputTokens: 100,
    });
  });

  it('falls back to text.delta (raw) for non-JSON lines', () => {
    const result = parseCodexJsonLine('plain text output', taskId, agent);
    expect(result).toMatchObject({
      type: 'text.delta',
      channel: 'raw',
      text: 'plain text output',
    });
  });

  it('suppresses done/complete/exit lifecycle events', () => {
    expect(parseCodexJsonLine(JSON.stringify({ type: 'done' }), taskId, agent)).toBeNull();
    expect(parseCodexJsonLine(JSON.stringify({ type: 'complete' }), taskId, agent)).toBeNull();
  });

  it('emits error events', () => {
    const line = JSON.stringify({ type: 'error', error: 'Model unavailable' });
    const result = parseCodexJsonLine(line, taskId, agent);
    expect(result).toMatchObject({
      type: 'error',
      message: 'Model unavailable',
    });
  });

  it('raw-falls back for unrecognized JSON shapes', () => {
    const result = parseCodexJsonLine(JSON.stringify({ type: 'custom_event', data: 99 }), taskId, agent);
    expect(result).toMatchObject({
      type: 'raw.fallback',
      sourceType: 'codex.custom_event',
    });
  });
});
