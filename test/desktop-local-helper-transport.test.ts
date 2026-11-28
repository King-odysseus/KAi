import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultSettings } from '../packages/contracts/src';

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../apps/desktop/src/main/model-transport', () => ({ modelFetch: transport.fetch }));

import { DesktopLearningTutor } from '../apps/desktop/src/main/learning-tutor';

describe('local helper model transport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    transport.fetch.mockReset();
  });

  it('waits past the shortened helper timeout on own hardware through modelFetch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Authentication credentials were not provided', { status: 401 })));
    transport.fetch.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 }));
    const settings = { ...createDefaultSettings(), gatewayOwnHardware: true, gatewayAwayUrl: 'https://relay.example/v1', gatewayCredentialId: 'provider.custom', gatewayHomeUrl: 'http://192.168.68.52:8000/v1', directApi: { ...createDefaultSettings().directApi, provider: 'openai-compatible' as const, baseUrl: 'https://relay.example/v1', credentialId: 'provider.custom' } };
    const onModelStatus = vi.fn();
    const tutor = new DesktopLearningTutor(
      { load: async () => settings },
      { isAvailable: () => true, get: async () => 'gateway-key' },
      async () => 'unused',
      undefined,
      20,
      onModelStatus,
    );
    transport.fetch.mockImplementation((_url: string, init: RequestInit) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 })), 75);
      init.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true });
    }));
    const value = await tutor.structuredRequest(
      { enabled: true, provider: 'openai-compatible', model: 'gateway/general', baseUrl: 'https://relay.example/v1', credentialId: 'provider.custom' },
      { feature: 'test helper', card: 'Prompt Guide' },
      { system: 'Return JSON.', user: 'Reply.' },
      'test',
      { type: 'object' },
      (content) => JSON.parse(content) as { ok: boolean },
    );
    expect(value).toEqual({ ok: true });
    expect(transport.fetch).toHaveBeenCalledOnce();
    expect(transport.fetch.mock.calls[0]?.[2]).toMatchObject({ host: 'own-hardware' });
    expect(transport.fetch.mock.calls[0]?.[2]?.onStatus).toBe(onModelStatus);
    expect(transport.fetch.mock.calls[0]?.[0]).toBe('http://192.168.68.52:8000/v1/chat/completions');
    expect(transport.fetch.mock.calls[0]?.[2]).toMatchObject({ host: 'own-hardware', statusRoot: 'http://192.168.68.52:8000', apiKey: 'gateway-key' });
  });

  it('routes image helper calls to gateway/vision', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Authentication credentials were not provided', { status: 401 })));
    transport.fetch.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'A quiet, warm palette.' } }] }), { status: 200 }));
    const settings = { ...createDefaultSettings(), gatewayOwnHardware: true, gatewayAwayUrl: 'https://relay.example/v1', gatewayCredentialId: 'provider.custom', gatewayHomeUrl: 'http://192.168.68.52:8000/v1', directApi: { ...createDefaultSettings().directApi, provider: 'openai-compatible' as const, baseUrl: 'https://relay.example/v1', credentialId: 'provider.custom' } };
    const tutor = new DesktopLearningTutor({ load: async () => settings }, { isAvailable: () => true, get: async () => 'gateway-key' }, async () => 'unused');
    await tutor.describeImages(
      { enabled: true, provider: 'openai-compatible', model: 'gateway/general', baseUrl: 'https://relay.example/v1', credentialId: 'provider.custom' },
      { feature: 'image guide', card: 'Prompt Guide' },
      { system: 'Describe.', user: 'What is the style?' },
      [{ mediaType: 'image/png', base64: 'AA==' }],
    );
    const body = JSON.parse(String(transport.fetch.mock.calls[0]?.[1]?.body)) as { model: string };
    expect(body.model).toBe('gateway/vision');
  });

  it('keeps the shortened request timeout for cloud helpers', async () => {
    const settings = createDefaultSettings();
    const tutor = new DesktopLearningTutor(
      { load: async () => settings },
      { isAvailable: () => true, get: async () => 'deepseek-key' },
      async () => 'unused',
      undefined,
      20,
    );
    transport.fetch.mockImplementation((_url: string, init: RequestInit) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 })), 75);
      init.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true });
    }));
    await expect(tutor.structuredRequest(
      { enabled: true, provider: 'deepseek', model: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com/v1', credentialId: 'provider.deepseek' },
      { feature: 'test helper', card: 'Prompt Guide' },
      { system: 'Return JSON.', user: 'Reply.' },
      'test',
      { type: 'object' },
      (content) => JSON.parse(content) as { ok: boolean },
    )).rejects.toThrow(/abort|timeout/i);
  });
});
