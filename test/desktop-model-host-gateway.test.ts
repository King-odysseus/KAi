import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultSettings, modelHostOf } from '../packages/contracts/src';
import { resolveGatewayAddress } from '../apps/desktop/src/main/gateway-address';

describe('gateway ownership and addressing', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('marks only an opted-in OpenAI-compatible gateway as own hardware', () => {
    const settings = { ...createDefaultSettings(), gatewayOwnHardware: true, directApi: { ...createDefaultSettings().directApi, provider: 'openai-compatible' as const, baseUrl: 'https://relay.example/v1' } };
    expect(modelHostOf({ provider: 'openai-compatible', baseUrl: 'https://relay.example/v1' }, settings)).toBe('own-hardware');
    expect(modelHostOf({ provider: 'openai-compatible', baseUrl: 'https://other.example/v1' }, settings)).toBe('cloud');
    expect(modelHostOf({ provider: 'openai-compatible', baseUrl: 'https://relay.example/v1' }, createDefaultSettings())).toBe('cloud');
  });

  it('recognises a saved gateway role while Direct API defaults to DeepSeek', async () => {
    const defaults = createDefaultSettings();
    const settings = {
      ...defaults,
      gatewayOwnHardware: true,
      gatewayAwayUrl: 'https://relay.example/v1',
      gatewayCredentialId: 'provider.gateway',
      directApi: { ...defaults.directApi, provider: 'deepseek' as const, baseUrl: 'https://api.deepseek.com/v1' },
    };
    const connection = { provider: 'openai-compatible' as const };
    expect(modelHostOf(connection, settings)).toBe('own-hardware');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('home gateway unavailable'); }));
    await expect(resolveGatewayAddress(connection, settings)).resolves.toEqual({ baseUrl: 'https://relay.example/v1', label: 'away' });
  });

  it('uses the home gateway when its quick health check succeeds', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      return new Response('Authentication credentials were not provided', { status: 401 });
    });
    vi.stubGlobal('fetch', fetch);
    const address = await resolveGatewayAddress(
      { provider: 'openai-compatible', baseUrl: 'https://relay.example/v1' },
      { ...createDefaultSettings(), gatewayOwnHardware: true, gatewayHomeUrl: 'http://192.168.68.52:8000/v1', directApi: { ...createDefaultSettings().directApi, provider: 'openai-compatible', baseUrl: 'https://relay.example/v1' } },
      'should-not-be-sent',
    );
    expect(address).toEqual({ baseUrl: 'http://192.168.68.52:8000/v1', label: 'home', statusRoot: 'http://192.168.68.52:8000' });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      'http://192.168.68.52:8000/v1/models',
      'http://192.168.68.52:8000/api/routing/queue/',
    ]);
  });

  it('keeps an own-hardware connection on Away when no Home address is configured', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const address = await resolveGatewayAddress(
      { provider: 'openai-compatible', baseUrl: 'https://relay.example/v1' },
      { ...createDefaultSettings(), gatewayOwnHardware: true, directApi: { ...createDefaultSettings().directApi, provider: 'openai-compatible', baseUrl: 'https://relay.example/v1' } },
    );
    expect(address).toEqual({ baseUrl: 'https://relay.example/v1', label: 'away' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('falls back to the configured Away relay when Home is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const address = await resolveGatewayAddress(
      { provider: 'openai-compatible', baseUrl: 'https://relay.example/v1' },
      { ...createDefaultSettings(), gatewayOwnHardware: true, gatewayHomeUrl: 'http://192.168.68.52:8000/v1', directApi: { ...createDefaultSettings().directApi, provider: 'openai-compatible', baseUrl: 'https://relay.example/v1' } },
    );
    expect(address).toEqual({ baseUrl: 'https://relay.example/v1', label: 'away' });
  });
});
