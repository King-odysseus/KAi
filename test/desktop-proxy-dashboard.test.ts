import { describe, expect, it } from 'vitest';
import {
  agentCredentialId,
  agentProviderKey,
  applyAgentModel,
  applyAgentProvider,
  applyMainPreset,
  dualProviderMap,
  dualRoutePreview,
  type ProxySettings,
} from '../apps/desktop/src/renderer/src/components/proxy-dashboard-data';

function settings(update: Partial<ProxySettings> = {}): ProxySettings {
  return {
    enabled: true,
    port: 8083,
    targetBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-flash',
    credentialId: 'provider.deepseek',
    modelMap: {},
    providers: {},
    agentRoutes: {},
    dualApiEnabled: false,
    modelRouting: true,
    kimiConfig: { enabled: false, baseUrl: 'https://api.kimi.com/coding/v1', defaultModel: 'kimi-for-coding' },
    qwenConfig: { enabled: false, baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-coder-plus', configModel: 'qwen-proxy' },
    codexConfig: { enabled: false, baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-6-astra', configModel: 'gpt-5.5' },
    ...update,
  } as ProxySettings;
}

describe('proxy dashboard agent cards', () => {
  it('treats Claude Code as the main provider, as the extension does', () => {
    const draft = settings();
    expect(agentProviderKey(draft, 'claude')).toBe('deepseek');
    expect(agentCredentialId(draft, 'claude')).toBe('provider.deepseek');
    const next = applyAgentProvider(draft, 'claude', 'openai');
    expect(next.targetBaseUrl).toBe('https://api.openai.com/v1');
    expect(next.defaultModel).toBe('gpt-6-astra');
    expect(next.credentialId).toBe('provider.openai');
    expect(next.modelMap['claude-opus-5']).toBe('gpt-6-astra');
  });

  it('switches other agents between the main provider and their own backend', () => {
    const draft = settings();
    expect(agentProviderKey(draft, 'qwen')).toBe('main');
    const routed = applyAgentProvider(draft, 'qwen', 'qwen_dashscope');
    expect(routed.qwenConfig).toMatchObject({ enabled: true, baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-coder-plus' });
    expect(agentProviderKey(routed, 'qwen')).toBe('qwen_dashscope');
    expect(agentCredentialId(routed, 'qwen')).toBe('agent.qwen');
    expect(applyAgentProvider(routed, 'qwen', 'main').qwenConfig.enabled).toBe(false);
  });

  it('keeps the Codex relay model when a preset is chosen', () => {
    const next = applyAgentProvider(settings(), 'codex', 'deepseek');
    expect(next.codexConfig).toMatchObject({ enabled: true, baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-flash', configModel: 'gpt-5.5' });
  });

  it('writes a model choice to whichever upstream the agent uses', () => {
    expect(applyAgentModel(settings(), 'kimi', 'deepseek-v4-pro').defaultModel).toBe('deepseek-v4-pro');
    const own = settings({ kimiConfig: { enabled: true, baseUrl: 'https://api.moonshot.ai/v1', defaultModel: 'kimi-k2.6' } });
    const next = applyAgentModel(own, 'kimi', 'moonshot-v1-128k');
    expect(next.kimiConfig.defaultModel).toBe('moonshot-v1-128k');
    expect(next.defaultModel).toBe('deepseek-flash');
  });

  it('leaves the model and map alone for an unknown preset', () => {
    const draft = settings();
    expect(applyMainPreset(draft, 'nope')).toBe(draft);
  });
});

describe('proxy dashboard dual API preview', () => {
  it('routes by model name only when Dual API is on', () => {
    const providers = {
      anthropic: { baseUrl: 'https://api.anthropic.com', credentialId: 'provider.anthropic', format: 'anthropic' as const, defaultModel: '', modelMap: dualProviderMap('anthropic', 'claude-sonnet-5') },
      openai: { baseUrl: 'https://api.openai.com/v1', credentialId: 'provider.openai', format: 'openai' as const, defaultModel: '', modelMap: dualProviderMap('openai', 'gpt-5.6-sol') },
    };
    const off = dualRoutePreview(settings({ providers }));
    expect(off.every((row) => row.sent === '—')).toBe(true);

    const on = dualRoutePreview(settings({ providers, dualApiEnabled: true, agentRoutes: { qwen: 'anthropic' } }));
    const byAgent = Object.fromEntries(on.map((row) => [row.agent, row]));
    expect(byAgent.claude).toMatchObject({ destination: 'Anthropic (model rule)', sent: 'claude-opus-5' });
    expect(byAgent.codex).toMatchObject({ destination: 'OpenAI (model rule)', sent: 'gpt-5.6-sol' });
    expect(byAgent.qwen).toMatchObject({ destination: 'Anthropic (pinned)', sent: 'claude-sonnet-5' });
    expect(byAgent.kimi?.sent).toBe('—');
  });
});
