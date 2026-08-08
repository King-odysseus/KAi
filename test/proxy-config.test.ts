import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the vscode module — only ConfigurationTarget.Global is used as a runtime value.
vi.mock('vscode', () => ({
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
}));

import { resolveProxyConfig, toProxyServerConfig, migrateLegacyProxySecrets } from '../src/config/proxy-config';
import type { SecretStore } from '../src/config/secret-store';

// ---- helpers ----

/** Build a minimal mock of vscode.WorkspaceConfiguration */
function mockConfig(overrides: Record<string, unknown> = {}): any {
  const store = new Map(Object.entries(overrides));
  return {
    get: vi.fn((key: string, defaultValue: unknown) => {
      if (store.has(key)) return store.get(key);
      return defaultValue;
    }),
    update: vi.fn(),
    inspect: vi.fn(),
    has: vi.fn((key: string) => store.has(key)),
  };
}

/** Build a minimal mock of SecretStore */
function mockSecretStore(keys: Record<string, string> = {}): SecretStore {
  const store = new Map(Object.entries(keys));
  return {
    // per-agent methods (unused in proxy-config tests)
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    loadIntoEnv: vi.fn(),
    status: vi.fn(),

    // upstream/provider methods
    getUpstreamKey: vi.fn(async () => store.get('kai.proxy.upstreamKey') ?? undefined),
    setUpstreamKey: vi.fn(async (value: string) => { store.set('kai.proxy.upstreamKey', value); }),
    deleteUpstreamKey: vi.fn(async () => { store.delete('kai.proxy.upstreamKey'); }),

    getCodexBackendKey: vi.fn(async () => store.get('kai.proxy.codexBackendKey') ?? undefined),
    setCodexBackendKey: vi.fn(async (value: string) => { store.set('kai.proxy.codexBackendKey', value); }),

    getQwenBackendKey: vi.fn(async () => store.get('kai.proxy.qwenBackendKey') ?? undefined),
    setQwenBackendKey: vi.fn(async (value: string) => { store.set('kai.proxy.qwenBackendKey', value); }),

    secretStorageGet: vi.fn(async (key: string) => store.get(key) ?? undefined),
    secretStorageSet: vi.fn(async (key: string, value: string) => { store.set(key, value); }),

    proxyKeyStatus: vi.fn(async () => ({
      upstream: store.has('kai.proxy.upstreamKey'),
      codexBackend: store.has('kai.proxy.codexBackendKey'),
      qwenBackend: store.has('kai.proxy.qwenBackendKey'),
    })),
  } as unknown as SecretStore;
}

// ---- resolveProxyConfig ----

describe('resolveProxyConfig', () => {
  it('reads targetBaseUrl from kai.proxy.* as primary', async () => {
    const kaiCfg = mockConfig({ 'proxy.targetBaseUrl': 'https://api.example.com' });
    const legacyCfg = mockConfig({ targetBaseUrl: 'https://api.deepseek.com' });
    const secrets = mockSecretStore();

    const result = await resolveProxyConfig(kaiCfg, legacyCfg, secrets);
    expect(result.targetBaseUrl).toBe('https://api.example.com');
  });

  it('falls back to claudeProxy when kai.proxy is empty', async () => {
    const kaiCfg = mockConfig({ 'proxy.targetBaseUrl': '' });
    const legacyCfg = mockConfig({ targetBaseUrl: 'https://api.legacy.com' });
    const secrets = mockSecretStore();

    const result = await resolveProxyConfig(kaiCfg, legacyCfg, secrets);
    expect(result.targetBaseUrl).toBe('https://api.legacy.com');
  });

  it('uses default when both namespaces are empty', async () => {
    const kaiCfg = mockConfig({});
    const legacyCfg = mockConfig({});
    const secrets = mockSecretStore();

    const result = await resolveProxyConfig(kaiCfg, legacyCfg, secrets);
    expect(result.targetBaseUrl).toBe('https://api.deepseek.com');
    expect(result.defaultModel).toBe('deepseek-chat');
  });

  it('resolves API key from SecretStorage', async () => {
    const kaiCfg = mockConfig({});
    const legacyCfg = mockConfig({});
    const secrets = mockSecretStore({
      'kai.proxy.upstreamKey': 'sk-secret-stored',
    });

    const result = await resolveProxyConfig(kaiCfg, legacyCfg, secrets);
    expect(result.apiKey).toBe('sk-secret-stored');
  });

  it('falls back to legacy claudeProxy.apiKey when SecretStorage is empty', async () => {
    const kaiCfg = mockConfig({});
    const legacyCfg = mockConfig({ apiKey: 'sk-legacy-plain' });
    const secrets = mockSecretStore();

    const result = await resolveProxyConfig(kaiCfg, legacyCfg, secrets);
    expect(result.apiKey).toBe('sk-legacy-plain');
  });

  it('falls back to legacy claudeProxy.apiKeys when no single key', async () => {
    const kaiCfg = mockConfig({});
    const legacyCfg = mockConfig({
      apiKey: '',
      apiKeys: { 'https://api.deepseek.com': 'sk-from-map' },
    });
    const secrets = mockSecretStore();

    const result = await resolveProxyConfig(kaiCfg, legacyCfg, secrets);
    expect(result.apiKey).toBe('sk-from-map');
  });

  it('merges routing flags from both namespaces', async () => {
    const kaiCfg = mockConfig({ 'proxy.routeClaudeCode': true });
    const legacyCfg = mockConfig({ routeCodex: true });
    const secrets = mockSecretStore();

    const result = await resolveProxyConfig(kaiCfg, legacyCfg, secrets);
    expect(result.routing.routeClaudeCode).toBe(true);
    expect(result.routing.routeCodex).toBe(true);
  });

  it('resolves codex agent backend config', async () => {
    const kaiCfg = mockConfig({
      'proxy.codexConfig': {
        enabled: true,
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: 'gpt-5.5',
        configModel: 'gpt-5.5',
      },
    });
    const legacyCfg = mockConfig({});
    const secrets = mockSecretStore({
      'kai.proxy.codexBackendKey': 'sk-codex-secret',
    });

    const result = await resolveProxyConfig(kaiCfg, legacyCfg, secrets);
    expect(result.codexConfig.enabled).toBe(true);
    expect(result.codexConfig.baseUrl).toBe('https://api.openai.com/v1');
    expect(result.codexConfig.apiKey).toBe('sk-codex-secret');
    expect(result.codexConfig.configModel).toBe('gpt-5.5');
  });

  it('falls back to legacy codexConfig apiKey when no SecretStorage key', async () => {
    const kaiCfg = mockConfig({});
    const legacyCfg = mockConfig({
      codexConfig: { enabled: true, baseUrl: 'https://x.ai/v1', apiKey: 'sk-legacy-codex', defaultModel: 'grok' },
    });
    const secrets = mockSecretStore();

    const result = await resolveProxyConfig(kaiCfg, legacyCfg, secrets);
    expect(result.codexConfig.apiKey).toBe('sk-legacy-codex');
    expect(result.codexConfig.baseUrl).toBe('https://x.ai/v1');
  });

  it('kai.proxy.* values override claudeProxy.* when both are set', async () => {
    const kaiCfg = mockConfig({
      'proxy.targetBaseUrl': 'https://kai-primary.example.com',
      'proxy.defaultModel': 'kai-model',
      'proxy.codexConfig': { enabled: true, baseUrl: 'https://kai-codex.example.com' },
    });
    const legacyCfg = mockConfig({
      targetBaseUrl: 'https://legacy.example.com',
      defaultModel: 'legacy-model',
      codexConfig: { enabled: false, baseUrl: 'https://legacy-codex.example.com' },
    });
    const secrets = mockSecretStore();

    const result = await resolveProxyConfig(kaiCfg, legacyCfg, secrets);
    expect(result.targetBaseUrl).toBe('https://kai-primary.example.com');
    expect(result.defaultModel).toBe('kai-model');
    expect(result.codexConfig.baseUrl).toBe('https://kai-codex.example.com');
  });
});

// ---- toProxyServerConfig ----

describe('toProxyServerConfig', () => {
  it('converts resolved config to ProxyServerConfig shape', () => {
    const resolved = {
      port: 8082,
      targetBaseUrl: 'https://api.example.com',
      apiKey: 'sk-test',
      defaultModel: 'test-model',
      modelMap: { 'claude-opus': 'mapped-model' },
      codexConfig: {
        enabled: true,
        baseUrl: 'https://codex.example.com/v1',
        apiKey: 'sk-codex',
        defaultModel: 'codex-model',
        configModel: 'gpt-5.5',
      },
      qwenConfig: {
        enabled: false,
        baseUrl: '',
        apiKey: '',
        defaultModel: '',
      },
      routing: { routeClaudeCode: true, routeCodex: false },
    };

    const result = toProxyServerConfig(resolved);
    expect(result.port).toBe(8082);
    expect(result.targetBaseUrl).toBe('https://api.example.com');
    expect(result.apiKey).toBe('sk-test');
    expect(result.codexConfig).toEqual({
      enabled: true,
      baseUrl: 'https://codex.example.com/v1',
      apiKey: 'sk-codex',
      defaultModel: 'codex-model',
    });
  });

  it('omits codexConfig from proxy config when not enabled', () => {
    const resolved = {
      port: 8082,
      targetBaseUrl: 'https://api.example.com',
      apiKey: 'sk-test',
      defaultModel: 'test-model',
      modelMap: {},
      codexConfig: {
        enabled: false,
        baseUrl: 'https://codex.example.com/v1',
        apiKey: 'sk-codex',
        defaultModel: 'codex-model',
        configModel: 'gpt-5.5',
      },
      qwenConfig: {
        enabled: false,
        baseUrl: '',
        apiKey: '',
        defaultModel: '',
      },
      routing: { routeClaudeCode: false, routeCodex: false },
    };

    const result = toProxyServerConfig(resolved);
    expect(result.codexConfig).toBeUndefined();
  });
});

// ---- migrateLegacyProxySecrets ----

describe('migrateLegacyProxySecrets', () => {
  it('migrates claudeProxy.apiKey to SecretStorage', async () => {
    const kaiCfg = mockConfig({});
    const legacyCfg = mockConfig({ apiKey: 'sk-legacy-migrate' });
    const secrets = mockSecretStore();

    const result = await migrateLegacyProxySecrets(legacyCfg, kaiCfg, secrets);

    expect(result.migrated).toContain('claudeProxy.apiKey');
    expect(secrets.setUpstreamKey).toHaveBeenCalledWith('sk-legacy-migrate');
    expect(legacyCfg.update).toHaveBeenCalledWith('apiKey', '', expect.anything());
  });

  it('skips migration when SecretStorage already has a key', async () => {
    const kaiCfg = mockConfig({});
    const legacyCfg = mockConfig({ apiKey: 'sk-legacy-migrate' });
    const secrets = mockSecretStore({
      'kai.proxy.upstreamKey': 'sk-already-stored',
    });

    const result = await migrateLegacyProxySecrets(legacyCfg, kaiCfg, secrets);

    expect(result.migrated).not.toContain('claudeProxy.apiKey');
    expect(secrets.setUpstreamKey).not.toHaveBeenCalled();
    // Still clears the legacy plaintext key
    expect(legacyCfg.update).toHaveBeenCalledWith('apiKey', '', expect.anything());
  });

  it('migrates claudeProxy.codexConfig.apiKey to SecretStorage', async () => {
    const kaiCfg = mockConfig({});
    const legacyCfg = mockConfig({
      codexConfig: {
        enabled: true,
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-codex-legacy',
        defaultModel: 'gpt-5.5',
      },
    });
    const secrets = mockSecretStore();

    const result = await migrateLegacyProxySecrets(legacyCfg, kaiCfg, secrets);

    expect(result.migrated).toContain('claudeProxy.codexConfig.apiKey');
    expect(secrets.secretStorageSet).toHaveBeenCalledWith('kai.proxy.codexBackendKey', 'sk-codex-legacy');
    // Should clear apiKey from the config object while preserving other fields
    expect(legacyCfg.update).toHaveBeenCalledWith(
      'codexConfig',
      expect.not.objectContaining({ apiKey: expect.anything() }),
      expect.anything(),
    );
  });

  it('migrates kai.proxy.apiKey to SecretStorage if present', async () => {
    const kaiCfg = mockConfig({ 'proxy.apiKey': 'sk-kai-plain' });
    const legacyCfg = mockConfig({});
    const secrets = mockSecretStore();

    const result = await migrateLegacyProxySecrets(legacyCfg, kaiCfg, secrets);

    expect(result.migrated).toContain('kai.proxy.apiKey');
    expect(secrets.setUpstreamKey).toHaveBeenCalledWith('sk-kai-plain');
  });

  it('returns empty migrated list when nothing to migrate', async () => {
    const kaiCfg = mockConfig({});
    const legacyCfg = mockConfig({ apiKey: '', apiKeys: {} });
    const secrets = mockSecretStore();

    const result = await migrateLegacyProxySecrets(legacyCfg, kaiCfg, secrets);
    expect(result.migrated).toEqual([]);
  });
});
