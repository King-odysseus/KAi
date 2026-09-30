import { describe, expect, it } from 'vitest';
import { deepSeekAnthropicBaseUrl, endpointRejected } from '../apps/desktop/src/main/direct-provider-runtime';

describe('DeepSeek Anthropic-style endpoint', () => {
  it('is used for the official DeepSeek API only', () => {
    expect(deepSeekAnthropicBaseUrl({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com' })).toBe('https://api.deepseek.com/anthropic');
    expect(deepSeekAnthropicBaseUrl({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1/' })).toBe('https://api.deepseek.com/anthropic');
    expect(deepSeekAnthropicBaseUrl({ provider: 'deepseek', baseUrl: 'http://127.0.0.1:8083/v1' })).toBeUndefined();
    expect(deepSeekAnthropicBaseUrl({ provider: 'deepseek', baseUrl: 'not a url' })).toBeUndefined();
    expect(deepSeekAnthropicBaseUrl({ provider: 'openrouter', baseUrl: 'https://api.deepseek.com' })).toBeUndefined();
  });

  it('falls back only when the endpoint itself refused the call', () => {
    expect(endpointRejected('Provider request failed (404): Not Found')).toBe(true);
    expect(endpointRejected('Provider request failed (422): unsupported field')).toBe(true);
    expect(endpointRejected('Provider request failed (401): Authentication Fails')).toBe(false);
    expect(endpointRejected('Provider request failed (429): rate limit')).toBe(false);
    expect(endpointRejected('Provider request failed (402): Insufficient Balance')).toBe(false);
    expect(endpointRejected(undefined)).toBe(false);
  });
});
