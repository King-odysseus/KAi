import * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { listProviderModels, mergeLocalModels, parseModelIds } from '../apps/desktop/src/main/provider-models';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('local model memory', () => {
  const at = '2026-01-01T00:00:00.000Z';
  it('adds a new local model to the remembered ones instead of replacing them', () => {
    const live = { provider: 'lmstudio' as const, models: ['new-model'], source: 'live' as const, fetchedAt: at, error: null };
    const result = mergeLocalModels(live, ['old-a', 'old-b']);
    expect(result.catalog.models).toEqual(['new-model', 'old-a', 'old-b']);
    expect(result.remembered).toEqual(['new-model', 'old-a', 'old-b']);
  });

  it('keeps the remembered models when the server is stopped, and does not remember the bundled guesses', () => {
    const preset = { provider: 'ollama' as const, models: ['qwen2.5-coder'], source: 'preset' as const, fetchedAt: at, error: 'not reachable' };
    const result = mergeLocalModels(preset, ['qwen3-coder:30b']);
    expect(result.catalog.models).toEqual(['qwen3-coder:30b']);
    expect(result.remembered).toEqual(['qwen3-coder:30b']);
  });

  it('falls back to the bundled list when nothing has been remembered yet', () => {
    const preset = { provider: 'ollama' as const, models: ['qwen2.5-coder'], source: 'preset' as const, fetchedAt: at, error: 'not reachable' };
    expect(mergeLocalModels(preset, []).catalog.models).toEqual(['qwen2.5-coder']);
  });
});

describe('desktop provider model catalogs', () => {
  it('normalizes common OpenAI-compatible model list response shapes', () => {
    expect(parseModelIds({ data: [{ id: 'z-model' }, { id: 'a-model' }, { id: 'a-model' }] })).toEqual([
      'a-model',
      'z-model',
    ]);
    expect(parseModelIds({ models: [{ name: 'model-b' }, 'model-a'] })).toEqual(['model-a', 'model-b']);
    expect(parseModelIds({ data: [{ model: 'model-c' }] })).toEqual(['model-c']);
  });

  it('loads live provider models without exposing the credential', async () => {
    const requests: Array<{ url?: string; authorization?: string }> = [];
    const server = http.createServer((request, response) => {
      requests.push({ url: request.url, authorization: request.headers.authorization });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'vendor/new-model' }, { id: 'vendor/stable-model' }] }));
    });
    const baseUrl = await listen(server);

    const catalog = await listProviderModels({
      provider: 'openrouter',
      baseUrl,
      credentialId: 'provider.openrouter',
    }, {
      get: async () => 'secret-that-must-not-leak',
    });

    expect(catalog).toMatchObject({
      provider: 'openrouter',
      source: 'live',
      error: null,
      models: ['vendor/new-model', 'vendor/stable-model'],
    });
    expect(requests).toEqual([{
      url: '/models',
      authorization: 'Bearer secret-that-must-not-leak',
    }]);
    expect(JSON.stringify(catalog)).not.toContain('secret-that-must-not-leak');
  });

  it('falls back to the bundled catalog when the credential is missing', async () => {
    const catalog = await listProviderModels({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      credentialId: 'provider.deepseek',
    }, {
      get: async () => undefined,
    });

    expect(catalog.source).toBe('preset');
    expect(catalog.error).toMatch(/save a credential/i);
    expect(catalog.models).toContain('deepseek-v4-pro');
  });

  it('reads LM Studio loaded context from its own models API', async () => {
    const requests: string[] = [];
    const server = http.createServer((request, response) => {
      requests.push(request.url ?? '');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(request.url === '/v1/models'
        ? { data: [{ id: 'qwen-local' }] }
        : { data: [{ id: 'qwen-local', loaded_context_length: 65_536, max_context_length: 262_144 }] }));
    });
    const baseUrl = `${await listen(server)}/v1`;
    const catalog = await listProviderModels({ provider: 'lmstudio', baseUrl, credentialId: 'provider.lmstudio' }, { get: async () => undefined });
    expect(requests).toEqual(['/v1/models', '/api/v0/models']);
    expect(catalog.contextLengths).toEqual({ 'qwen-local': 65_536 });
  });
});

async function listen(server: http.Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind to a TCP port.');
  return `http://127.0.0.1:${address.port}`;
}
