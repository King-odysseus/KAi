import { describe, expect, it } from 'vitest';
import { MODEL_TEAM_KEY, hasModelTeam, readModelTeam, startingTargets, writeModelTeam } from '../apps/desktop/src/renderer/src/model-team';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
    data,
  };
}

const claude = { execution: 'cli' as const, agent: 'claude' as const, model: 'opus' };
const qwen = { execution: 'api' as const, api: { provider: 'ollama' as const, model: 'qwen3-coder' } };
const settings = (provider: string, saved: Record<string, string[]> = {}) => ({
  directApi: { enabled: true, provider, model: 'gateway/coding', baseUrl: provider === 'openai' ? 'https://api.openai.com/v1' : 'http://192.168.1.20:8080/v1', credentialId: 'provider.local' },
  savedLocalModels: saved,
}) as never;

describe('the saved Model team', () => {
  it('starts empty', () => {
    expect(readModelTeam(memoryStorage())).toEqual({ coach: null, builder: null });
    expect(hasModelTeam(readModelTeam(memoryStorage()))).toBe(false);
  });

  it('saves and reads both roles back', () => {
    const storage = memoryStorage();
    expect(writeModelTeam({ coach: claude, builder: qwen }, storage)).toBe(true);
    expect(readModelTeam(storage)).toEqual({ coach: claude, builder: qwen });
  });

  it('forgets the team when both roles are cleared', () => {
    const storage = memoryStorage();
    writeModelTeam({ coach: claude, builder: qwen }, storage);
    writeModelTeam({ coach: null, builder: null }, storage);
    expect(storage.data.has(MODEL_TEAM_KEY)).toBe(false);
  });

  it('ignores a value that does not parse, and keeps the half that does', () => {
    expect(readModelTeam(memoryStorage({ [MODEL_TEAM_KEY]: 'not json' }))).toEqual({ coach: null, builder: null });
    expect(readModelTeam(memoryStorage({ [MODEL_TEAM_KEY]: JSON.stringify({ coach: { execution: 'nonsense' }, builder: qwen }) }))).toEqual({ coach: null, builder: qwen });
  });

  it('survives a storage that throws', () => {
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    expect(readModelTeam(broken)).toEqual({ coach: null, builder: null });
    expect(writeModelTeam({ coach: claude, builder: null }, broken)).toBe(false);
    expect(readModelTeam(null)).toEqual({ coach: null, builder: null });
  });
});

describe('who a new plan starts with', () => {
  it('uses the saved team before anything else', () => {
    const storage = memoryStorage();
    writeModelTeam({ coach: claude, builder: qwen }, storage);
    expect(startingTargets(settings('lmstudio'), storage)).toEqual({ coach: claude, builder: qwen });
  });

  it('falls back to the local model in Settings when no Builder is saved', () => {
    const storage = memoryStorage();
    writeModelTeam({ coach: claude, builder: null }, storage);
    const targets = startingTargets(settings('lmstudio'), storage);
    expect(targets.coach).toEqual(claude);
    expect(targets.builder).toMatchObject({ execution: 'api', api: { provider: 'lmstudio', model: 'gateway/coding' } });
  });

  it('leaves the Builder empty when nothing local is set up, so the agent in use builds', () => {
    expect(startingTargets(settings('openai'), memoryStorage())).toEqual({ coach: null, builder: null });
  });
});

describe('a new crew with the saved team', () => {
  it('puts the Coach on the Lead and the Builder on the builders, and leaves every other role alone', async () => {
    const { createDefaultCrewConfig } = await import('@kai/contracts');
    const { withTeamOnCrew } = await import('../apps/desktop/src/renderer/src/model-team');
    const base = createDefaultCrewConfig('codex', 'codex');
    const next = withTeamOnCrew(base, { coach: claude, builder: qwen });
    const lead = next.roles.find((role) => role.kind === 'lead')!;
    const builder = next.roles.find((role) => role.kind === 'builder')!;
    expect(lead).toMatchObject({ execution: 'cli', agent: 'claude', model: 'opus' });
    expect(builder).toMatchObject({ execution: 'api', api: { provider: 'ollama', model: 'qwen3-coder' }, model: 'qwen3-coder' });
    const others = next.roles.filter((role) => role.kind !== 'lead' && role.kind !== 'builder');
    expect(others).toEqual(base.roles.filter((role) => role.kind !== 'lead' && role.kind !== 'builder'));
  });

  it('does nothing for a role with no saved choice', async () => {
    const { createDefaultCrewConfig } = await import('@kai/contracts');
    const { withTeamOnCrew } = await import('../apps/desktop/src/renderer/src/model-team');
    const base = createDefaultCrewConfig('claude', 'codex');
    expect(withTeamOnCrew(base, { coach: null, builder: null })).toEqual(base);
  });

  it('drops a leftover API connection when a role moves to a CLI agent', async () => {
    const { createDefaultCrewConfig, crewConfigSchema } = await import('@kai/contracts');
    const { withTeamOnCrew } = await import('../apps/desktop/src/renderer/src/model-team');
    const base = createDefaultCrewConfig('claude', 'codex');
    const local = withTeamOnCrew(base, { coach: null, builder: qwen });
    const back = withTeamOnCrew(local, { coach: null, builder: claude });
    const builder = back.roles.find((role) => role.kind === 'builder')!;
    expect(builder.api).toBeUndefined();
    expect(builder.execution).toBe('cli');
    expect(() => crewConfigSchema.parse(back)).not.toThrow();
  });
});
