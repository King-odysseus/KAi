import { describe, expect, it } from 'vitest';
import {
  KEEP_RECENT_RESULTS,
  TRIM_TARGET_CHARS,
  TRIM_TRIGGER_CHARS,
  trimAnthropicToolResults,
  trimChatToolResults,
  trimGeminiToolResults,
} from '../apps/desktop/src/main/context-trimming';

const big = (label: string, size = 6_000): string => `${label} ${'x'.repeat(size)}`;

describe('trimming old tool results', () => {
  it('leaves a run alone while its tool results are small', () => {
    const messages = Array.from({ length: 12 }, (_, index) => ({ role: 'tool', content: big(`r${index}`, 500) }));
    expect(trimChatToolResults(messages)).toBe(0);
    expect(messages.every((message) => message.content?.startsWith('r') && message.content.length > 500)).toBe(true);
  });

  it('trims the oldest results down to the target and keeps the newest whole', () => {
    const messages = [
      { role: 'user', content: 'do the task' },
      ...Array.from({ length: 20 }, (_, index) => ({ role: 'tool', content: big(`result-${index}`) })),
    ];
    const before = messages.reduce((sum, message) => sum + (message.content?.length ?? 0), 0);
    expect(before).toBeGreaterThan(TRIM_TRIGGER_CHARS);
    const trimmed = trimChatToolResults(messages);
    expect(trimmed).toBeGreaterThan(0);
    const after = messages.reduce((sum, message) => sum + (message.content?.length ?? 0), 0);
    expect(after).toBeLessThanOrEqual(TRIM_TARGET_CHARS + 5_000);
    expect(messages[0]!.content).toBe('do the task');
    expect(messages[1]!.content).toContain('Earlier tool result trimmed');
    expect(messages[1]!.content).toContain('result-0');
    const newest = messages.slice(-KEEP_RECENT_RESULTS);
    expect(newest.every((message) => message.content!.length > 5_000)).toBe(true);
  });

  it('does nothing further on the next round, so a cached prompt stays valid', () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({ role: 'tool', content: big(`r${index}`) }));
    trimChatToolResults(messages);
    const snapshot = JSON.stringify(messages);
    expect(trimChatToolResults(messages)).toBe(0);
    expect(JSON.stringify(messages)).toBe(snapshot);
  });

  it('trims Anthropic tool_result blocks and Gemini functionResponse parts', () => {
    const anthropic = Array.from({ length: 20 }, (_, index) => ({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `t${index}`, content: big(`a${index}`) }],
    }));
    expect(trimAnthropicToolResults(anthropic)).toBeGreaterThan(0);
    expect((anthropic[0]!.content[0] as { content: string }).content).toContain('Earlier tool result trimmed');
    expect((anthropic[19]!.content[0] as { content: string }).content.length).toBeGreaterThan(5_000);

    const gemini = Array.from({ length: 20 }, (_, index) => ({
      role: 'user',
      parts: [{ functionResponse: { name: 'read_file', response: { text: big(`g${index}`) } } }],
    }));
    expect(trimGeminiToolResults(gemini)).toBeGreaterThan(0);
    expect(JSON.stringify(gemini[0]!.parts[0])).toContain('Earlier tool result trimmed');
    expect(JSON.stringify(gemini[19]!.parts[0]).length).toBeGreaterThan(5_000);
  });
});
