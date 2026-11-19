import { describe, expect, it } from 'vitest';
import { architectSplitSchema, splitWorker, type AgentCapability, type ArchitectSplit, type RoleTarget } from '@kai/contracts';
import {
  NEW_TAB,
  adoptSplit,
  apiChoices,
  modelOf,
  readLastSplit,
  readStudioArchitectSplit,
  readStoredSplit,
  roleModelOptions,
  splitFor,
  pairingWarning,
  splitProblem,
  tabKeyFor,
  targetFromValue,
  targetOptions,
  targetValue,
  withModel,
  withRole,
  writeStoredSplit,
  CUSTOM_ROLE_MODEL,
  type SplitStorage,
} from '../apps/desktop/src/renderer/src/components/architect-settings';

function memory(): SplitStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } };
}

const CLAUDE: RoleTarget = { execution: 'cli', agent: 'claude', model: 'opus' };
const CODEX: RoleTarget = { execution: 'cli', agent: 'codex' };
const KIMI: RoleTarget = { execution: 'api', api: { provider: 'moonshot', model: 'kimi-k3' } };

const split = (overrides: Partial<ArchitectSplit> = {}): ArchitectSplit => ({ enabled: true, architect: CLAUDE, implementer: CODEX, fallback: null, ...overrides });

const capability = (id: AgentCapability['id'], available = true, reason?: string): AgentCapability => ({
  id, displayName: id[0]!.toUpperCase() + id.slice(1), available, state: available ? 'ready' : 'signed_out', command: id, signInCommand: `${id} login`,
  installUrl: 'https://example.com', supportsRoutes: ['direct'], supportsAutonomy: ['plan', 'full'], ...(reason ? { unavailableReason: reason } : {}),
});

describe('remembering the split', () => {
  it('keeps each tab\'s own choice, and keeps it across a reload', () => {
    const storage = memory();
    writeStoredSplit('conv-a', split(), 1, storage);
    writeStoredSplit('conv-b', split({ architect: CODEX, implementer: CLAUDE }), 1, storage);

    // A reload is a fresh read over the same storage.
    expect(readStoredSplit('conv-a', 1, storage)).toEqual(split());
    expect(readStoredSplit('conv-b', 1, storage)?.architect).toEqual(CODEX);
    expect(readStoredSplit('conv-c', 1, storage)).toBeUndefined();
  });

  it('keeps each window\'s choices apart', () => {
    const storage = memory();
    writeStoredSplit('conv-a', split(), 1, storage);
    writeStoredSplit('conv-a', split({ architect: KIMI }), 2, storage);
    expect(readStoredSplit('conv-a', 1, storage)?.architect).toEqual(CLAUDE);
    expect(readStoredSplit('conv-a', 2, storage)?.architect).toEqual(KIMI);
    expect(readLastSplit(1, storage)?.architect).toEqual(CLAUDE);
    expect(readLastSplit(2, storage)?.architect).toEqual(KIMI);
  });

  it('keeps an API role\'s own key and model exactly', () => {
    const storage = memory();
    const withKey: ArchitectSplit = split({ implementer: { execution: 'api', api: { provider: 'anthropic', credentialId: 'provider.anthropic-work', model: 'claude-opus-5-5' } } });
    writeStoredSplit('t', withKey, 1, storage);
    expect(readStoredSplit('t', 1, storage)).toEqual(withKey);
  });

  it('ignores corrupt or hand-edited storage instead of throwing', () => {
    const storage = memory();
    storage.data.set('kai.architect.tabs:window:1', '{not json');
    storage.data.set('kai.architect.last:window:1', JSON.stringify({ enabled: 'yes' }));
    expect(readStoredSplit('t', 1, storage)).toBeUndefined();
    expect(readLastSplit(1, storage)).toBeUndefined();
    storage.data.set('kai.architect.tabs:window:1', JSON.stringify({ t: { enabled: true, architect: { execution: 'cli' }, implementer: null, fallback: null } }));
    expect(readStoredSplit('t', 1, storage)).toBeUndefined();
  });

  it('works with storage locked down', () => {
    expect(() => writeStoredSplit('t', split(), 1, null)).not.toThrow();
    expect(readStoredSplit('t', 1, null)).toBeUndefined();
    expect(readLastSplit(1, null)).toBeUndefined();
    const throwing: SplitStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(() => writeStoredSplit('t', split(), 1, throwing)).not.toThrow();
    expect(readStoredSplit('t', 1, throwing)).toBeUndefined();
  });

  it('gives a new tab the last choice this window made, and a tab the person set keeps its own', () => {
    const storage = memory();
    writeStoredSplit('conv-a', split({ architect: KIMI }), 1, storage);
    const fresh = splitFor({ stored: readStoredSplit(tabKeyFor(null), 1, storage), last: readLastSplit(1, storage) });
    expect(fresh.architect).toEqual(KIMI);
    const own = splitFor({ stored: readStoredSplit('conv-a', 1, storage), last: readLastSplit(1, storage) });
    expect(own.architect).toEqual(KIMI);
    writeStoredSplit('conv-b', split({ architect: CODEX }), 1, storage);
    // The newest choice is the next new tab's start, but conv-a still has its own.
    expect(splitFor({ stored: readStoredSplit('conv-a', 1, storage) , last: readLastSplit(1, storage) }).architect).toEqual(KIMI);
    expect(splitFor({ last: readLastSplit(1, storage) }).architect).toEqual(CODEX);
  });

  it('uses the configured last active pair in Studio when the stored new-tab choice is disabled', () => {
    const storage = memory();
    writeStoredSplit(NEW_TAB, split({ enabled: false }), 1, storage);
    const configured = split({ participation: 'handsOn' });
    writeStoredSplit('configured-conversation', configured, 1, storage);

    expect(readStudioArchitectSplit(1, storage)).toEqual(configured);
  });

  it('puts the person\'s choice for this tab first, then the conversation\'s record, then the window\'s last', () => {
    const stored = split({ architect: KIMI });
    const recorded = split({ architect: CODEX });
    const last = split({ architect: CLAUDE });
    expect(splitFor({ stored, recorded, last }).architect).toEqual(KIMI);
    expect(splitFor({ recorded, last }).architect).toEqual(CODEX);
    expect(splitFor({ last }).architect).toEqual(CLAUDE);
    expect(splitFor({})).toEqual({ enabled: false, architect: null, implementer: null, fallback: null });
  });

  it('carries a new tab\'s choice over to its conversation once it has one', () => {
    const storage = memory();
    writeStoredSplit(NEW_TAB, split(), 1, storage);
    adoptSplit(NEW_TAB, 'conv-9', 1, storage);
    expect(readStoredSplit('conv-9', 1, storage)).toEqual(split());
    // An existing choice for that conversation is never overwritten.
    writeStoredSplit('conv-10', split({ architect: KIMI }), 1, storage);
    adoptSplit(NEW_TAB, 'conv-10', 1, storage);
    expect(readStoredSplit('conv-10', 1, storage)?.architect).toEqual(KIMI);
  });

  it('says what is missing before a run can start', () => {
    expect(splitProblem(split({ enabled: false, architect: null }))).toBeNull();
    expect(splitProblem(split({ architect: null, implementer: null }))).toMatch(/Architect and an Implementer/);
    expect(splitProblem(split({ architect: null }))).toBe('Choose an Architect.');
    expect(splitProblem(split({ implementer: null }))).toBe('Choose an Implementer.');
    expect(splitProblem(split())).toBeNull();
  });
});

describe('choosing a role', () => {
  it('turns a menu value into a target and back, keeping the model when the same agent is picked again', () => {
    expect(targetValue(CLAUDE)).toBe('cli:claude');
    expect(targetFromValue('cli:claude', CLAUDE)).toBe(CLAUDE);
    expect(targetFromValue('cli:codex', CLAUDE)).toEqual({ execution: 'cli', agent: 'codex' });
    expect(targetFromValue('', CLAUDE)).toBeNull();

    expect(targetValue(KIMI)).toBe('api:moonshot:provider.moonshot');
    expect(targetFromValue('api:moonshot:provider.moonshot', KIMI)).toBe(KIMI);
    // A second key for the same vendor is a different choice and drops the first one's model.
    expect(targetFromValue('api:moonshot:provider.moonshot.work', KIMI)).toEqual({ execution: 'api', api: { provider: 'moonshot', credentialId: 'provider.moonshot.work' } });
    // The provider's own key is left implicit, so the saved Settings key for it applies.
    expect(targetFromValue('api:anthropic:provider.anthropic', null)).toEqual({ execution: 'api', api: { provider: 'anthropic' } });
  });

  it('sets and reads the model for either kind of role', () => {
    expect(modelOf(withModel(CODEX, 'gpt-6.1-sol'))).toBe('gpt-6.1-sol');
    expect(modelOf(withModel(KIMI, 'kimi-k2.6'))).toBe('kimi-k2.6');
    expect(withModel(CLAUDE, '')).toEqual({ execution: 'cli', agent: 'claude' });
    expect(modelOf(withModel(KIMI, ''))).toBe('');
    expect(modelOf(null)).toBe('');
  });

  it('sets one role without touching the others', () => {
    const next = withRole(split(), 'fallback', KIMI);
    expect(next).toMatchObject({ architect: CLAUDE, implementer: CODEX, fallback: KIMI });
  });
});

describe('what the pickers offer', () => {
  const capabilities = [capability('qwen'), capability('claude'), capability('gemini', false, 'Sign in to Gemini'), capability('codex')];

  it('lists a provider once per saved key, so two accounts are two choices, and every local server', () => {
    const choices = apiChoices(['provider.anthropic', 'provider.anthropic-work', 'provider.moonshot']);
    const anthropic = choices.filter((choice) => choice.provider === 'anthropic');
    expect(anthropic.map((choice) => choice.credentialId)).toEqual(['provider.anthropic', 'provider.anthropic-work']);
    expect(anthropic[1]!.label).toBe('Anthropic Messages API (work)');
    expect(choices.some((choice) => choice.provider === 'moonshot')).toBe(true);
    for (const local of ['lmstudio', 'ollama', 'llamacpp', 'vllm']) expect(choices.find((choice) => choice.provider === local)).toMatchObject({ local: true });
    // No key, no entry: a provider the person has not set up is not offered as a dead end.
    expect(choices.some((choice) => choice.provider === 'openai')).toBe(false);
  });

  it('keeps a role visible after its key was removed, rather than silently swapping it', () => {
    const gone: RoleTarget = { execution: 'api', api: { provider: 'openai' } };
    const choices = apiChoices([], [gone]);
    expect(choices.find((choice) => choice.provider === 'openai')).toMatchObject({ keySaved: false });
    const options = targetOptions('implementer', { capabilities, credentialIds: [], current: [gone] });
    expect(options.find((option) => option.value === targetValue(gone))?.description).toMatch(/No key saved/);
  });

  it('puts the models that suit planning first for the Architect, and does not reorder the Implementer', () => {
    const credentialIds = ['provider.anthropic', 'provider.groq'];
    const architect = targetOptions('architect', { capabilities, credentialIds, current: [] });
    const cli = architect.filter((option) => option.group === 'CLI agents').map((option) => option.value);
    expect(cli.slice(0, 2).sort()).toEqual(['cli:claude', 'cli:codex']);
    const api = architect.filter((option) => option.group === 'API and local models').map((option) => option.value);
    expect(api.indexOf('api:anthropic:provider.anthropic')).toBeLessThan(api.indexOf('api:groq:provider.groq'));
    expect(architect.find((option) => option.value === 'cli:claude')?.description).toMatch(/Suited to planning/);

    const implementer = targetOptions('implementer', { capabilities, credentialIds, current: [] });
    expect(implementer.filter((option) => option.group === 'CLI agents').map((option) => option.value)).toEqual(['cli:qwen', 'cli:claude', 'cli:gemini', 'cli:codex']);
    expect(implementer.find((option) => option.value === 'cli:claude')?.description).toBeUndefined();
  });

  it('says why an agent cannot be used, without hiding it', () => {
    const options = targetOptions('implementer', { capabilities, credentialIds: [], current: [] });
    expect(options.find((option) => option.value === 'cli:gemini')?.description).toBe('Sign in to Gemini');
  });

  it('offers a CLI agent\'s own models, an API\'s live list when there is one, else the shipped list', () => {
    expect(roleModelOptions('implementer', CODEX, undefined).map((option) => option.value)).toContain('gpt-6.1-sol');
    const noModel = withModel(KIMI, '');
    const live = roleModelOptions('implementer', noModel, ['kimi-live-1', 'kimi-live-2']).map((option) => option.value);
    expect(live).toEqual(expect.arrayContaining(['kimi-live-1', 'kimi-live-2']));
    expect(live).not.toContain('kimi-k3');
    expect(roleModelOptions('implementer', noModel, undefined).map((option) => option.value)).toContain('kimi-k3');
    expect(roleModelOptions('implementer', noModel, []).map((option) => option.value)).toContain('kimi-k3');
    // A model already chosen stays in the list even when the provider's live list no longer carries it.
    expect(roleModelOptions('implementer', KIMI, ['kimi-live-1']).map((option) => option.value)).toContain('kimi-k3');
  });

  it('marks and sorts planning models for the Architect, and always offers a typed one', () => {
    const options = roleModelOptions('architect', { execution: 'api', api: { provider: 'google' } }, undefined);
    const names = options.map((option) => option.value);
    expect(names.indexOf('gemini-3.8-pro')).toBeLessThan(names.indexOf('gemini-3.8-flash'));
    expect(options.find((option) => option.value === 'gemini-3.8-pro')?.description).toBe('Suited to planning');
    expect(options.find((option) => option.value === 'gemini-3.8-flash')?.description).toBeUndefined();
    expect(names.at(-1)).toBe(CUSTOM_ROLE_MODEL);
  });

  it('keeps a typed model in the list, and calls a local server\'s default "whatever is loaded"', () => {
    const typed = roleModelOptions('implementer', withModel(CODEX, 'gpt-9-experimental'), undefined).map((option) => option.value);
    expect(typed).toContain('gpt-9-experimental');
    const local = roleModelOptions('implementer', { execution: 'api', api: { provider: 'ollama' } }, ['qwen2.5-coder', 'llama3.3']);
    expect(local[0]).toEqual({ value: '', label: 'Whatever is loaded' });
    expect(local.map((option) => option.value)).toEqual(expect.arrayContaining(['qwen2.5-coder', 'llama3.3']));
  });
});

describe('pairingWarning', () => {
  const on = (architect: RoleTarget, implementer: RoleTarget): ArchitectSplit => ({ enabled: true, architect, implementer, fallback: null });
  it('warns, without blocking, about a weak Architect or a local Implementer', () => {
    const strong: RoleTarget = { execution: 'cli', agent: 'claude', model: 'claude-opus-5-5' };
    const weak: RoleTarget = { execution: 'cli', agent: 'claude', model: 'claude-haiku-5-5' };
    const local: RoleTarget = { execution: 'api', api: { provider: 'lmstudio', model: 'qwen2.5-coder' } };
    expect(pairingWarning(on(strong, { execution: 'cli', agent: 'codex' }))).toBeNull();
    expect(pairingWarning(on(weak, { execution: 'cli', agent: 'codex' }))).toMatch(/Architect is not a model known for planning/);
    expect(pairingWarning(on(strong, local))).toMatch(/model on this computer/);
    expect(pairingWarning({ enabled: false, architect: weak, implementer: local, fallback: null })).toBeNull();
  });
});

describe('the Worker role', () => {
  const worker: RoleTarget = { execution: 'api', api: { provider: 'lmstudio', model: 'qwen3-coder-30b' } };
  const base: ArchitectSplit = { enabled: true, architect: { execution: 'cli', agent: 'claude' }, implementer: { execution: 'cli', agent: 'claude', model: 'sonnet' }, fallback: null };

  it('is optional: an older saved split without one is still a valid split', () => {
    expect(architectSplitSchema.safeParse(base).success).toBe(true);
    expect(architectSplitSchema.safeParse({ ...base, worker }).success).toBe(true);
    expect(architectSplitSchema.safeParse({ ...base, worker: null }).success).toBe(true);
  });

  it('is set through withRole, kept by the schema and named in the summary', () => {
    const next = withRole(base, 'worker', worker);
    expect(next.worker).toEqual(worker);
    expect(architectSplitSchema.parse(next).worker).toEqual(worker);
    expect(splitWorker(next)).toEqual(worker);
    expect(splitWorker({ ...next, enabled: false })).toBeNull();
    expect(splitWorker(base)).toBeNull();
    expect(withRole(next, 'worker', null).worker).toBeNull();
  });
});
