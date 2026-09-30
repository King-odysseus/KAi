import { describe, expect, it } from 'vitest';
import { withAnthropicPromptCaching } from '../apps/desktop/src/main/direct-provider-runtime';

const tools = [{ name: 'read_file' }, { name: 'run_command' }];
const messages = [{ role: 'user' as const, content: 'fix it' }];

describe('withAnthropicPromptCaching', () => {
  it('marks the system block, the last tool and the newest message on Anthropic', () => {
    const body = withAnthropicPromptCaching('https://api.anthropic.com', { messages, system: 'rules', tools });

    expect(body.system).toEqual([{ type: 'text', text: 'rules', cache_control: { type: 'ephemeral' } }]);
    expect(body.tools?.[0]).toEqual({ name: 'read_file' });
    expect(body.tools?.[1]).toEqual({ name: 'run_command', cache_control: { type: 'ephemeral' } });
    expect(body.messages[0]?.content).toEqual([{ type: 'text', text: 'fix it', cache_control: { type: 'ephemeral' } }]);
  });

  it('caches the last block of a tool-result message without mutating the input', () => {
    const history = [{ role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }];
    const body = withAnthropicPromptCaching('https://api.anthropic.com/v1', { messages: history, tools: [] });

    expect(body.messages[0]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: 'ok', cache_control: { type: 'ephemeral' } },
    ]);
    expect(history[0]?.content).toEqual([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]);
    expect(body.tools).toBeUndefined();
  });

  it('leaves compatible third-party endpoints untouched', () => {
    const body = withAnthropicPromptCaching('https://api.deepseek.com/anthropic', { messages, system: 'rules', tools });

    expect(body.system).toBe('rules');
    expect(JSON.stringify(body)).not.toContain('cache_control');
  });
});
