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
  it('round-trips the last agent, route and execution mode', () => {
    const storage = memoryStorage();
    rememberAgentChoice({ agent: 'qwen', route: 'proxy', execution: 'api' }, storage);

    expect(rememberedAgentChoice(storage)).toEqual({ agent: 'qwen', route: 'proxy', execution: 'api' });
  });

  it('ignores a saved agent this build does not know', () => {
    expect(rememberedAgentChoice(memoryStorage({ 'kai.lastAgent': 'retired-cli' }))).toBeNull();
    expect(rememberedAgentChoice(memoryStorage({ 'kai.lastAgent': 'kimi', 'kai.lastRoute': 'bogus' })))
      .toEqual({ agent: 'kimi', route: 'direct', execution: 'cli' });
  });

  it('opens on the last composer pick, then the reopened conversation agent, then the Settings default', () => {
    const defaults = { agent: 'codex' as const, route: 'direct' as const, execution: 'cli' as const };
    const remembered = { agent: 'claude' as const, route: 'proxy' as const, execution: 'cli' as const };

    // The composer choice is intentional, so it beats the reopened conversation's historical route.
    expect(startupAgentChoice({ activeAgent: 'gemini', route: 'direct', execution: 'cli' }, remembered, defaults)).toEqual(remembered);
    expect(startupAgentChoice({ activeAgent: 'gemini', route: 'direct', execution: 'api' }, null, defaults))
      .toEqual({ agent: 'gemini', route: 'direct', execution: 'api' });
    expect(startupAgentChoice({ activeAgent: null, route: null, execution: null }, null, defaults)).toEqual(defaults);
    expect(startupAgentChoice(undefined, null, defaults)).toEqual(defaults);
  });
});
