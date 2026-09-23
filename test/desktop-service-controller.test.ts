import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../packages/contracts/src';
import { cognitive1OverwatchEnvironment } from '../apps/desktop/src/main/service-controller';

describe('desktop C1 service controller', () => {
  it('maps desktop Overwatch settings to the C1 daemon environment', () => {
    const settings = createDefaultSettings();
    settings.cognitive1.overwatch = {
      enabled: true,
      provider: 'claude',
      baseUrl: 'https://api.anthropic.com',
      credentialId: 'cognitive1.overwatch.claude',
      model: 'claude-sonnet-4-5',
      autoRejectThreshold: 0.92,
    };

    expect(cognitive1OverwatchEnvironment(settings, 'vault-secret')).toEqual({
      COGNITIVE1_OVERWATCH_ENABLED: 'true',
      COGNITIVE1_OVERWATCH_PROVIDER: 'claude',
      COGNITIVE1_OVERWATCH_BASE_URL: 'https://api.anthropic.com',
      COGNITIVE1_OVERWATCH_MODEL: 'claude-sonnet-4-5',
      COGNITIVE1_OVERWATCH_AUTO_REJECT_THRESHOLD: '0.92',
      COGNITIVE1_OVERWATCH_API_KEY: 'vault-secret',
    });
  });

  it('does not inject an empty Overwatch credential into the daemon environment', () => {
    const settings = createDefaultSettings();
    const environment = cognitive1OverwatchEnvironment(settings, '');

    expect(environment.COGNITIVE1_OVERWATCH_ENABLED).toBe('false');
    expect(environment).not.toHaveProperty('COGNITIVE1_OVERWATCH_API_KEY');
  });

  it('maps OpenAI Overwatch settings to the C1 daemon environment', () => {
    const settings = createDefaultSettings();
    settings.cognitive1.overwatch = {
      enabled: true,
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      credentialId: 'cognitive1.overwatch',
      model: 'gpt-6-astra',
      autoRejectThreshold: 0.9,
    };

    expect(cognitive1OverwatchEnvironment(settings, 'openai-secret')).toMatchObject({
      COGNITIVE1_OVERWATCH_ENABLED: 'true',
      COGNITIVE1_OVERWATCH_PROVIDER: 'openai',
      COGNITIVE1_OVERWATCH_BASE_URL: 'https://api.openai.com/v1',
      COGNITIVE1_OVERWATCH_MODEL: 'gpt-6-astra',
      COGNITIVE1_OVERWATCH_API_KEY: 'openai-secret',
    });
  });
});
