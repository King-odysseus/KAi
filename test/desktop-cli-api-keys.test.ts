import { describe, expect, it } from 'vitest';
import { CLI_API_KEY_ENV, cliApiKeyCredentialId, createDefaultSettings, DIRECT_PROVIDER_PRESETS } from '../packages/contracts/src';
import { cliApiKeyEnvironment } from '../apps/desktop/src/main/agent-runtime';
import { mergeSettingsUpdate } from '../apps/desktop/src/main/service-controller';

describe('CLI API keys', () => {
  it('hands a CLI its own key through the variable it reads, in that run only', () => {
    const base = { PATH: 'p' };
    expect(cliApiKeyEnvironment('claude', ' sk-ant-1 ', base)).toMatchObject({ PATH: 'p', ANTHROPIC_API_KEY: 'sk-ant-1' });
    expect(cliApiKeyEnvironment('codex', 'sk-oai', base)).toMatchObject({ OPENAI_API_KEY: 'sk-oai', CODEX_API_KEY: 'sk-oai' });
    expect(cliApiKeyEnvironment('gemini', 'g-key', base)).toMatchObject({ GEMINI_API_KEY: 'g-key' });
    expect(base).toEqual({ PATH: 'p' });
  });

  it('drops a leftover proxy address or token so the key goes to the vendor', () => {
    const stale = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8082/a/claude', ANTHROPIC_AUTH_TOKEN: 'proxy-token', OPENAI_BASE_URL: 'http://127.0.0.1:8082/a/codex/v1' };
    const claude = cliApiKeyEnvironment('claude', 'k', stale)!;
    expect(claude.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(claude.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(cliApiKeyEnvironment('codex', 'k', stale)!.OPENAI_BASE_URL).toBeUndefined();
  });

  it('gives Kimi Code a provider for the run, on the endpoint its key belongs to', () => {
    expect(cliApiKeyEnvironment('kimi', 'k', {})).toMatchObject({ KIMI_MODEL_API_KEY: 'k', KIMI_MODEL_NAME: 'kimi-for-coding', KIMI_MODEL_PROVIDER_TYPE: 'kimi', KIMI_MODEL_BASE_URL: 'https://api.kimi.com/coding/v1' });
    expect(cliApiKeyEnvironment('kimi', 'k', {}, 'kimi-k2.6')).toMatchObject({ KIMI_MODEL_NAME: 'kimi-k2.6', KIMI_MODEL_BASE_URL: 'https://api.moonshot.ai/v1' });
  });

  it('does nothing for a blank key or a CLI that does not take one', () => {
    expect(cliApiKeyEnvironment('claude', '   ', {})).toBeNull();
    expect(cliApiKeyEnvironment('qwen', 'k', {})).toBeNull();
    expect(Object.keys(CLI_API_KEY_ENV).sort()).toEqual(['claude', 'codex', 'gemini', 'kimi']);
  });

  it('keeps each CLI key in its own vault entry', () => {
    expect(cliApiKeyCredentialId('claude')).toBe('cli.claude.apikey');
    expect(cliApiKeyCredentialId('gemini')).not.toBe(cliApiKeyCredentialId('codex'));
  });

  it('is off until switched on, and the switch is saved with the settings', () => {
    const settings = createDefaultSettings();
    expect(settings.cliApiKeys).toEqual({});
    expect(mergeSettingsUpdate(settings, { cliApiKeys: { claude: true } }).cliApiKeys).toEqual({ claude: true });
    expect(mergeSettingsUpdate({ ...settings, cliApiKeys: { claude: true } }, { cliApiKeys: {} }).cliApiKeys).toEqual({});
  });

  it('offers the newer Claude models in the Direct API list', () => {
    expect(DIRECT_PROVIDER_PRESETS.anthropic.models).toEqual(expect.arrayContaining(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']));
  });
});
