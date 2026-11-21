import { describe, expect, it } from 'vitest';
import { isLoopbackUrl, isOwnNetworkApi, isPrivateNetworkUrl } from '@kai/contracts';

describe('a server on the person\'s own network', () => {
  it('counts a private address as their own', () => {
    for (const url of ['http://192.168.68.70:8000/v1', 'http://10.0.0.5/v1', 'http://172.16.4.2:11434', 'http://172.31.255.1', 'http://169.254.1.1', 'http://localhost:1234/v1', 'http://127.0.0.1:8080', 'http://[::1]:8080/v1', 'http://nas.local:9000', 'http://gateway.lan/v1', 'http://gateway:8000/v1', 'http://[fd12:3456::1]/v1']) {
      expect(isPrivateNetworkUrl(url), url).toBe(true);
    }
  });

  it('never counts a public address, so a paid cloud API is never taken for a local one', () => {
    for (const url of ['https://api.openai.com/v1', 'https://api.anthropic.com', 'http://8.8.8.8/v1', 'http://172.15.0.1', 'http://172.32.0.1', 'https://gateway.example.com/v1', 'http://203.0.113.9:8000']) {
      expect(isPrivateNetworkUrl(url), url).toBe(false);
    }
  });

  it('is false when there is no address or it cannot be read', () => {
    expect(isPrivateNetworkUrl(undefined)).toBe(false);
    expect(isPrivateNetworkUrl('')).toBe(false);
    expect(isPrivateNetworkUrl('not a url')).toBe(false);
  });

  it('tells this computer from the rest of the network', () => {
    expect(isLoopbackUrl('http://localhost:1234')).toBe(true);
    expect(isLoopbackUrl('http://127.0.0.1:1234')).toBe(true);
    expect(isLoopbackUrl('http://192.168.1.2:1234')).toBe(false);
  });

  it('counts a keyless local provider, or any provider at a private address', () => {
    expect(isOwnNetworkApi({ provider: 'ollama' })).toBe(true);
    expect(isOwnNetworkApi({ provider: 'openai-compatible', baseUrl: 'http://192.168.68.70:8000/v1' })).toBe(true);
    expect(isOwnNetworkApi({ provider: 'openai-compatible', baseUrl: 'https://gateway.example.com/v1' })).toBe(false);
    expect(isOwnNetworkApi({ provider: 'openai' })).toBe(false);
  });
});
