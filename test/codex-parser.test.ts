import { describe, expect, it } from 'vitest';
import { parseCodexJsonLine } from '../src/adapters/codex-parser';

// Fixtures below are copied verbatim from a real `codex exec --json
// --sandbox read-only "<prompt>"` run (codex-cli 0.153.4) — see
// codex-parser.ts's module doc for the exact captured session.
describe('parseCodexJsonLine', () => {
  const taskId = 'task_1';
  const agent = 'codex' as const;

  it('parses thread.started into a cost.update carrying the session id', () => {
    const line = '{"type":"thread.started","thread_id":"01a090b5-c6d2-7063-9bbc-bf9170a80787"}';
    const result = parseCodexJsonLine(line, taskId, agent);
    expect(result).toMatchObject({
      type: 'cost.update',
      sessionId: '01a090b5-c6d2-7063-9bbc-bf9170a80787',
    });
  });

  it('suppresses turn.started', () => {
    expect(parseCodexJsonLine('{"type":"turn.started"}', taskId, agent)).toBeNull();
  });

  it('parses an item.completed agent_message into text.delta', () => {
    const line = '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Hi! How can I help?"}}';
    const result = parseCodexJsonLine(line, taskId, agent);
    expect(result).toMatchObject({
      type: 'text.delta',
      channel: 'assistant',
      text: 'Hi! How can I help?',
    });
  });

  it('parses item.started command_execution into a started tool.call', () => {
    const line = '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"ls","aggregated_output":"","exit_code":null,"status":"in_progress"}}';
    const result = parseCodexJsonLine(line, taskId, agent);
    expect(result).toMatchObject({
      type: 'tool.call',
      name: 'command_execution',
      status: 'started',
      input: 'ls',
    });
  });

  it('parses item.completed command_execution (exit 0) into a completed tool.call with output', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_1', type: 'command_execution', command: 'ls', aggregated_output: 'a.ts\nb.ts\n', exit_code: 0, status: 'completed' },
    });
    const result = parseCodexJsonLine(line, taskId, agent);
    expect(result).toMatchObject({
      type: 'tool.call',
      name: 'command_execution',
      status: 'completed',
      input: 'ls',
      output: 'a.ts\nb.ts\n',
    });
  });

  it('parses item.completed command_execution with a non-zero exit code as failed', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_2', type: 'command_execution', command: 'false', aggregated_output: '', exit_code: 1, status: 'completed' },
    });
    const result = parseCodexJsonLine(line, taskId, agent);
    expect(result).toMatchObject({ type: 'tool.call', status: 'failed' });
  });

  it('parses turn.completed usage into cost.update', () => {
    const line = '{"type":"turn.completed","usage":{"input_tokens":20714,"cached_input_tokens":9860,"cache_write_input_tokens":10635,"output_tokens":230,"reasoning_output_tokens":28}}';
    const result = parseCodexJsonLine(line, taskId, agent);
    expect(result).toMatchObject({
      type: 'cost.update',
      inputTokens: 20714,
      outputTokens: 230,
    });
  });

  it('parses an item.completed reasoning item into a summary-channel text.delta', () => {
    const line = JSON.stringify({ type: 'item.completed', item: { id: 'item_3', type: 'reasoning', text: 'Checking the file first.' } });
    const result = parseCodexJsonLine(line, taskId, agent);
    expect(result).toMatchObject({ type: 'text.delta', channel: 'summary', text: 'Checking the file first.' });
  });

  it('falls back to text.delta (raw) for non-JSON lines', () => {
    const result = parseCodexJsonLine('plain text output', taskId, agent);
    expect(result).toMatchObject({
      type: 'text.delta',
      channel: 'raw',
      text: 'plain text output',
    });
  });

  it('emits error events', () => {
    const line = JSON.stringify({ type: 'error', error: 'Model unavailable' });
    const result = parseCodexJsonLine(line, taskId, agent);
    expect(result).toMatchObject({
      type: 'error',
      message: 'Model unavailable',
    });
  });

  it('parses item.completed file_change entries into file.change events', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_9',
        type: 'file_change',
        changes: [
          { path: 'src/a.ts', kind: 'update', added: 12, removed: 3 },
          { path: 'src/new.ts', kind: 'add', added: 7, removed: 0 },
        ],
      },
    });
    const result = parseCodexJsonLine(line, taskId, agent);
    expect(result).toEqual([
      expect.objectContaining({ type: 'file.change', path: 'src/a.ts', action: 'edited', added: 12, removed: 3 }),
      expect.objectContaining({ type: 'file.change', path: 'src/new.ts', action: 'created', added: 7, removed: 0 }),
    ]);
  });

  it('raw-falls back for unrecognized item types', () => {
    const result = parseCodexJsonLine(JSON.stringify({ type: 'item.completed', item: { id: 'item_9', type: 'unknown_item' } }), taskId, agent);
    expect(result).toMatchObject({ type: 'raw.fallback', sourceType: 'codex.item.completed' });
  });

  it('raw-falls back for unrecognized JSON shapes', () => {
    const result = parseCodexJsonLine(JSON.stringify({ type: 'custom_event', data: 99 }), taskId, agent);
    expect(result).toMatchObject({
      type: 'raw.fallback',
      sourceType: 'codex.custom_event',
    });
  });
});
