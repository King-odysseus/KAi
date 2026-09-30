import { describe, expect, it } from 'vitest';
import {
  rememberAnthropicToolArguments,
  rememberAnthropicToolCall,
  type PendingToolCall,
} from '../apps/desktop/src/main/direct-provider-runtime';

/** Plays the content-block events of a streamed reply into the pending calls, the way the run loop does. */
function play(events: Array<Record<string, unknown>>): PendingToolCall[] {
  const calls = new Map<string, PendingToolCall>();
  for (const event of events) {
    if (event.type === 'content_block_start') {
      const block = event.content_block as Record<string, unknown>;
      if (block.type === 'tool_use') rememberAnthropicToolCall(calls, block, event.index as number);
    } else if (event.type === 'content_block_delta') {
      const delta = event.delta as Record<string, unknown>;
      if (delta.type === 'input_json_delta') rememberAnthropicToolArguments(calls, event, delta.partial_json as string);
    }
  }
  return [...calls.values()];
}

describe('streamed Anthropic tool calls', () => {
  it('keeps the arguments when a text block comes before the call', () => {
    const [call] = play([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'I will commit.' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'run_command', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"git status"}' } },
    ]);
    expect(JSON.parse(call!.argumentsText)).toEqual({ command: 'git status' });
  });

  it('keeps each call\'s own arguments when several calls follow some text', () => {
    const calls = play([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'a', name: 'read_file', input: {} } },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'b', name: 'run_command', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } },
    ]);
    expect(calls.map((call) => JSON.parse(call.argumentsText))).toEqual([{ path: 'a.ts' }, { command: 'ls' }]);
  });

  it('accepts a call that arrives with its whole input and no fragments, or with no arguments at all', () => {
    const [whole] = play([{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'w', name: 'read_file', input: { path: 'x.ts' } } }]);
    expect(JSON.parse(whole!.argumentsText)).toEqual({ path: 'x.ts' });
    const [none] = play([{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'n', name: 'list_files', input: {} } }]);
    expect(none!.argumentsText).toBe('');
  });
});
