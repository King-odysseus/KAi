import { describe, expect, it } from 'vitest';
import { parseQwenJsonLine } from '../src/adapters/qwen-parser';

describe('parseQwenJsonLine', () => {
  const taskId = 'task_1';
  const agent = 'qwen' as const;

  it('parses delta into text.delta', () => {
    const line = JSON.stringify({ delta: 'Here is the proposed change.' });
    const result = parseQwenJsonLine(line, taskId, agent);
    expect(result).toMatchObject({
      type: 'text.delta',
      channel: 'assistant',
      text: 'Here is the proposed change.',
    });
  });

  it('parses text field into text.delta', () => {
    const line = JSON.stringify({ type: 'message', text: 'Let me analyze this code.' });
    const result = parseQwenJsonLine(line, taskId, agent);
    expect(result).toMatchObject({
      type: 'text.delta',
      channel: 'assistant',
      text: 'Let me analyze this code.',
    });
  });

  it('parses tool_call into tool.call', () => {
    const line = JSON.stringify({
      type: 'tool_call',
      tool: 'search_code',
      tool_input: { query: 'UserService', path: '/src' },
    });
    const result = parseQwenJsonLine(line, taskId, agent);
    expect(result).toMatchObject({
      type: 'tool.call',
      name: 'search_code',
      status: 'started',
      input: { query: 'UserService', path: '/src' },
    });
  });

  it('parses tool_result into tool.call with completed status', () => {
    const line = JSON.stringify({
      type: 'tool_result',
      tool: 'search_code',
      content: 'Found 3 matches in UserService.ts',
    });
    const result = parseQwenJsonLine(line, taskId, agent);
    expect(result).toMatchObject({
      type: 'tool.call',
      name: 'search_code',
      status: 'completed',
      output: 'Found 3 matches in UserService.ts',
    });
  });

  it('parses diff into diff.proposal', () => {
    const line = JSON.stringify({
      type: 'diff',
      file: '/src/utils.ts',
      summary: 'Refactored helper functions',
      diff: '@@ -1,3 +1,5 @@\n export function foo() {}\n+export function bar() {}',
    });
    const result = parseQwenJsonLine(line, taskId, agent);
    expect(result).toMatchObject({
      type: 'diff.proposal',
      filePath: '/src/utils.ts',
      summary: 'Refactored helper functions',
    });
  });

  it('parses approval into approval.request', () => {
    const line = JSON.stringify({
      type: 'approval',
      title: 'Edit workspace file',
      detail: 'Modify src/config.ts',
      risk: 'medium',
    });
    const result = parseQwenJsonLine(line, taskId, agent);
    expect(result).toMatchObject({
      type: 'approval.request',
      title: 'Edit workspace file',
      detail: 'Modify src/config.ts',
      risk: 'medium',
    });
  });

  it('parses usage into cost.update', () => {
    const line = JSON.stringify({
      type: 'usage',
      usage: { input_tokens: 300, output_tokens: 150 },
    });
    const result = parseQwenJsonLine(line, taskId, agent);
    expect(result).toMatchObject({
      type: 'cost.update',
      inputTokens: 300,
      outputTokens: 150,
    });
  });

  it('falls back to text.delta (raw) for non-JSON lines', () => {
    const result = parseQwenJsonLine('some plain text output', taskId, agent);
    expect(result).toMatchObject({
      type: 'text.delta',
      channel: 'raw',
      text: 'some plain text output',
    });
  });

  it('suppresses system/ping/done/init events', () => {
    expect(parseQwenJsonLine(JSON.stringify({ type: 'system' }), taskId, agent)).toBeNull();
    expect(parseQwenJsonLine(JSON.stringify({ type: 'ping' }), taskId, agent)).toBeNull();
    expect(parseQwenJsonLine(JSON.stringify({ type: 'done' }), taskId, agent)).toBeNull();
    expect(parseQwenJsonLine(JSON.stringify({ type: 'init' }), taskId, agent)).toBeNull();
  });

  it('emits error events', () => {
    const line = JSON.stringify({ type: 'error', error: 'Model overloaded' });
    const result = parseQwenJsonLine(line, taskId, agent);
    expect(result).toMatchObject({
      type: 'error',
      message: 'Model overloaded',
    });
  });

  it('raw-falls back for unrecognized JSON shapes', () => {
    const result = parseQwenJsonLine(
      JSON.stringify({ type: 'qwen_special', data: 42 }),
      taskId,
      agent,
    );
    expect(result).toMatchObject({
      type: 'raw.fallback',
      sourceType: 'qwen.qwen_special',
    });
  });
});
