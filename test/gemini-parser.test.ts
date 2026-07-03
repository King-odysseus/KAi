import { describe, expect, it } from 'vitest';
import { parseGeminiJsonLine } from '../src/adapters/gemini-parser';

describe('parseGeminiJsonLine', () => {
  const taskId = 'task_1';
  const agent = 'gemini' as const;

  it('parses delta into text.delta', () => {
    const line = JSON.stringify({ delta: 'Here is the explanation you requested.' });
    const result = parseGeminiJsonLine(line, taskId, agent);
    expect(result).toMatchObject({
      type: 'text.delta',
      channel: 'assistant',
      text: 'Here is the explanation you requested.',
    });
  });

  it('parses text from candidates array', () => {
    const line = JSON.stringify({
      type: 'message',
      candidates: [
        {
          content: {
            parts: [{ text: 'This code could be improved by...' }],
            role: 'model',
          },
          finishReason: 'STOP',
        },
      ],
    });
    const result = parseGeminiJsonLine(line, taskId, agent);
    expect(result).toMatchObject({
      type: 'text.delta',
      channel: 'assistant',
      text: 'This code could be improved by...',
    });
  });

  it('parses functionCall from candidates into tool.call', () => {
    const line = JSON.stringify({
      type: 'message',
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: 'read_file',
                  args: { path: '/src/app.ts' },
                },
              },
            ],
            role: 'model',
          },
        },
      ],
    });
    const result = parseGeminiJsonLine(line, taskId, agent);
    expect(result).toMatchObject({
      type: 'tool.call',
      name: 'read_file',
      status: 'started',
      input: { path: '/src/app.ts' },
    });
  });

  it('parses functionResponse from candidates into tool.call completed', () => {
    const line = JSON.stringify({
      type: 'message',
      candidates: [
        {
          content: {
            parts: [
              {
                functionResponse: {
                  name: 'read_file',
                  response: { content: 'export function main() {}' },
                },
              },
            ],
          },
        },
      ],
    });
    const result = parseGeminiJsonLine(line, taskId, agent);
    expect(result).toMatchObject({
      type: 'tool.call',
      name: 'read_file',
      status: 'completed',
      output: { content: 'export function main() {}' },
    });
  });

  it('parses functionCall from top-level event', () => {
    const line = JSON.stringify({
      type: 'tool_call',
      functionCall: { name: 'write_file', args: { path: '/src/foo.ts', content: 'export {}' } },
    });
    const result = parseGeminiJsonLine(line, taskId, agent);
    expect(result).toMatchObject({
      type: 'tool.call',
      name: 'write_file',
      status: 'started',
    });
  });

  it('parses diff into diff.proposal', () => {
    const line = JSON.stringify({
      type: 'file_edit',
      file: '/src/bar.ts',
      edit_summary: 'Added type annotations',
      diff: '+  const x: number = 42;',
    });
    const result = parseGeminiJsonLine(line, taskId, agent);
    expect(result).toMatchObject({
      type: 'diff.proposal',
      filePath: '/src/bar.ts',
      summary: 'Added type annotations',
      diff: '+  const x: number = 42;',
    });
  });

  it('parses approval into approval.request', () => {
    const line = JSON.stringify({
      type: 'permission_request',
      action: 'delete_file',
      detail: 'Delete src/deprecated.ts',
      risk: 'high',
    });
    const result = parseGeminiJsonLine(line, taskId, agent);
    expect(result).toMatchObject({
      type: 'approval.request',
      title: 'delete_file',
      risk: 'high',
    });
  });

  it('parses usage into cost.update', () => {
    const line = JSON.stringify({
      type: 'usage',
      usage: { input_tokens: 500, output_tokens: 200 },
    });
    const result = parseGeminiJsonLine(line, taskId, agent);
    expect(result).toMatchObject({
      type: 'cost.update',
      inputTokens: 500,
      outputTokens: 200,
    });
  });

  it('parses usageMetadata (Gemini variant) into cost.update', () => {
    const line = JSON.stringify({
      type: 'message',
      usageMetadata: { promptTokenCount: 400, candidatesTokenCount: 180, totalTokenCount: 580 },
    });
    const result = parseGeminiJsonLine(line, taskId, agent);
    expect(result).toMatchObject({
      type: 'cost.update',
      inputTokens: 400,
      outputTokens: 180,
    });
  });

  it('falls back to text.delta (raw) for non-JSON lines', () => {
    const result = parseGeminiJsonLine('unstructured text', taskId, agent);
    expect(result).toMatchObject({
      type: 'text.delta',
      channel: 'raw',
      text: 'unstructured text',
    });
  });

  it('suppresses system/ping/done/complete/init events', () => {
    expect(parseGeminiJsonLine(JSON.stringify({ type: 'system' }), taskId, agent)).toBeNull();
    expect(parseGeminiJsonLine(JSON.stringify({ type: 'ping' }), taskId, agent)).toBeNull();
    expect(parseGeminiJsonLine(JSON.stringify({ type: 'done' }), taskId, agent)).toBeNull();
    expect(parseGeminiJsonLine(JSON.stringify({ type: 'complete' }), taskId, agent)).toBeNull();
    expect(parseGeminiJsonLine(JSON.stringify({ type: 'init' }), taskId, agent)).toBeNull();
  });

  it('emits error events from string', () => {
    const line = JSON.stringify({ type: 'error', error: 'API rate limit exceeded' });
    const result = parseGeminiJsonLine(line, taskId, agent);
    expect(result).toMatchObject({
      type: 'error',
      message: 'API rate limit exceeded',
    });
  });

  it('emits error events from object', () => {
    const line = JSON.stringify({
      type: 'error',
      error: { message: 'Invalid request', code: 400 },
    });
    const result = parseGeminiJsonLine(line, taskId, agent);
    expect(result).toMatchObject({
      type: 'error',
      message: 'Invalid request',
    });
  });

  it('raw-falls back for unrecognized JSON shapes', () => {
    const result = parseGeminiJsonLine(
      JSON.stringify({ type: 'gemini_custom', data: 77 }),
      taskId,
      agent,
    );
    expect(result).toMatchObject({
      type: 'raw.fallback',
      sourceType: 'gemini.gemini_custom',
    });
  });
});
