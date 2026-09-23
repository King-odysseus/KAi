import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../packages/contracts/src';
import {
  cognitive1OverwatchEnvironment,
  explainStartFailure,
  moveOffStandalonePort,
} from '../apps/desktop/src/main/service-controller';

describe('managed Cognitive1 port', () => {
  const taken = (...ports: number[]) => async (port: number) => !ports.includes(port);

  it('defaults to a port that does not clash with the standalone daemon', () => {
    expect(createDefaultSettings().cognitive1.endpoint).toBe('http://127.0.0.1:9877');
  });

  it('moves an old default endpoint to the next free port when the standalone daemon holds 9876', async () => {
    expect(await moveOffStandalonePort('http://127.0.0.1:9876', taken(9876))).toBe('http://127.0.0.1:9877');
    expect(await moveOffStandalonePort('http://127.0.0.1:9876', taken(9876, 9877, 9878))).toBe('http://127.0.0.1:9879');
  });

  it('leaves the endpoint alone when 9876 is free, or when the user chose another port', async () => {
    expect(await moveOffStandalonePort('http://127.0.0.1:9876', taken())).toBeNull();
    expect(await moveOffStandalonePort('http://127.0.0.1:9900', taken(9876, 9900))).toBeNull();
    expect(await moveOffStandalonePort('not a url', taken(9876))).toBeNull();
  });

  it('gives up cleanly when no nearby port is free', async () => {
    const everything = async () => false;
    expect(await moveOffStandalonePort('http://127.0.0.1:9876', everything)).toBeNull();
  });

  it('explains an address-in-use failure in plain words and passes other errors through', () => {
    const busy = new Error('listen EADDRINUSE: address already in use 127.0.0.1:9876');
    expect(explainStartFailure('cognitive1', 'http://127.0.0.1:9876', busy)).toBe(
      'Port 9876 is already in use by another program, so Cognitive1 could not start. Another copy may be running. Change the port in Settings or stop that program.',
    );
    expect(explainStartFailure('universalProxy', 'http://127.0.0.1:8082', busy)).toContain('the Universal Proxy could not start');
    expect(explainStartFailure('cognitive1', 'http://127.0.0.1:9877', new Error('boom'))).toBe('boom');
  });
});

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
