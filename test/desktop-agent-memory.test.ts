import { describe, expect, it } from 'vitest';
import {
  rememberAgentChoice,
  rememberedAgentChoice,
  startupAgentChoice,
} from '../apps/desktop/src/renderer/src/agent-memory';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe('remembered agent choice', () => {
  it('round-trips the last CLI agent and route', () => {
    const storage = memoryStorage();
    rememberAgentChoice({ agent: 'qwen', route: 'proxy' }, storage);

    expect(rememberedAgentChoice(storage)).toEqual({ agent: 'qwen', route: 'proxy' });
  });

  it('ignores a saved agent this build does not know', () => {
    expect(rememberedAgentChoice(memoryStorage({ 'kai.lastAgent': 'retired-cli' }))).toBeNull();
    expect(rememberedAgentChoice(memoryStorage({ 'kai.lastAgent': 'kimi', 'kai.lastRoute': 'bogus' })))
      .toEqual({ agent: 'kimi', route: 'direct' });
  });

  it('opens on the reopened conversation agent, then the last pick, then the Settings default', () => {
    const defaults = { agent: 'codex' as const, route: 'direct' as const };
    const remembered = { agent: 'claude' as const, route: 'proxy' as const };

    expect(startupAgentChoice({ activeAgent: 'gemini', route: 'direct' }, remembered, defaults))
      .toEqual({ agent: 'gemini', route: 'direct' });
    expect(startupAgentChoice({ activeAgent: null, route: null }, remembered, defaults)).toEqual(remembered);
    expect(startupAgentChoice(undefined, null, defaults)).toEqual(defaults);
  });
});
