import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultSettings } from '../packages/contracts/src';
import {
  clearSearchCache,
  searchCredentialFor,
  searchWeb,
  testSearchSource,
  type SearchContext,
  type SearchCredentialPort,
} from '../apps/desktop/src/main/web-search';
import { WebToolRuntime } from '../apps/desktop/src/main/web-tools';

function settings(overrides: Partial<ReturnType<typeof createDefaultSettings>['webSearch']> = {}) {
  return { ...createDefaultSettings().webSearch, enabled: true, ...overrides };
}

function vault(values: Record<string, string>): SearchCredentialPort {
  return { get: async (id) => values[id] };
}

function context(overrides: Partial<ReturnType<typeof settings>> = {}, directApi?: SearchContext['directApi']): SearchContext {
  return { settings: settings(overrides), directApi };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

beforeEach(() => clearSearchCache());
afterEach(() => vi.unstubAllGlobals());

describe('external search sources', () => {
  it('asks SearXNG for JSON results and normalizes them', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      results: [
        { title: 'First', url: 'https://example.com/one', content: 'A snippet' },
        { title: 'Duplicate', url: 'https://example.com/one', content: 'ignored' },
        { title: 'Bad', url: 'file:///etc/passwd', content: 'ignored' },
      ],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const results = await searchWeb(context({ source: 'searxng', endpoint: 'http://127.0.0.1:8080' }), vault({}), 'docs query');

    expect(results).toEqual([{ title: 'First', url: 'https://example.com/one', snippet: 'A snippet' }]);
    const called = String(fetchMock.mock.calls[0][0]);
    expect(called).toContain('http://127.0.0.1:8080/search');
    expect(called).toContain('format=json');
  });

  it('sends the Brave key as a header, never in the URL', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      web: { results: [{ title: 'Brave hit', url: 'https://example.com/b', description: 'text' }] },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const results = await searchWeb(context({ source: 'brave' }), vault({ 'search.brave': 'brave-key' }), 'query');

    expect(results[0].title).toBe('Brave hit');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).not.toContain('brave-key');
    expect((init.headers as Record<string, string>)['X-Subscription-Token']).toBe('brave-key');
  });

  it('posts the Tavily request in the documented shape', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      results: [{ title: 'Tavily hit', url: 'https://example.com/t', content: 'text' }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    await searchWeb(context({ source: 'tavily' }), vault({ 'search.tavily': 'tavily-key' }), 'query');

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ api_key: 'tavily-key', query: 'query' });
  });

  it('reports a missing key with the credential that needs one', async () => {
    await expect(searchWeb(context({ source: 'brave' }), vault({}), 'query')).rejects.toThrow(/search\.brave/);
  });

  it('turns a rejected key into a readable message without leaking it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    const error = await searchWeb(context({ source: 'brave' }), vault({ 'search.brave': 'secret-value' }), 'query')
      .catch((caught: unknown) => caught as Error);
    expect(error.message).toContain('rejected the key');
    expect(error.message).not.toContain('secret-value');
  });

  it('serves an identical query from the cache', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [{ title: 'Cached', url: 'https://example.com/c', content: '' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const ctx = context({ source: 'searxng' });

    await searchWeb(ctx, vault({}), 'same query');
    await searchWeb(ctx, vault({}), 'same query');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('native search sources', () => {
  it('reuses the current Direct API key and address for the same provider', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      content: [{
        type: 'web_search_tool_result',
        content: [{ type: 'web_search_result', title: 'Anthropic hit', url: 'https://example.com/a', page_age: '1d' }],
      }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const directApi = { provider: 'anthropic' as const, credentialId: 'provider.anthropic.work', baseUrl: 'http://127.0.0.1:9999/v1' };
    const results = await searchWeb(context({ source: 'anthropic' }, directApi), vault({ 'provider.anthropic.work': 'anthropic-key' }), 'query');

    expect(results[0]).toMatchObject({ title: 'Anthropic hit', url: 'https://example.com/a' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:9999/v1/messages');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('anthropic-key');
    expect(JSON.parse(String(init.body)).tools[0]).toMatchObject({ type: 'web_search_20250305', name: 'web_search' });
  });

  it('falls back to the provider preset key when the model provider is different', () => {
    expect(searchCredentialFor('openai')).toBe('provider.openai');
    expect(searchCredentialFor('openai', 'custom.override')).toBe('custom.override');
    expect(searchCredentialFor('brave')).toBe('search.brave');
    expect(searchCredentialFor('searxng')).toBe('');
  });

  it('uses the current Moonshot standalone search endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      search_results: [{ title: 'Kimi hit', url: 'https://example.com/k', snippet: 'text', site_name: 'Example' }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const directApi = { provider: 'moonshot' as const, credentialId: 'provider.moonshot', baseUrl: 'https://api.moonshot.ai/v1' };
    const results = await searchWeb(context({ source: 'moonshot' }, directApi), vault({ 'provider.moonshot': 'kimi-key' }), 'query', 3);

    expect(results).toEqual([{ title: 'Kimi hit', url: 'https://example.com/k', snippet: 'text' }]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.moonshot.ai/v1/tools/search');
    expect(JSON.parse(String(init.body))).toEqual({ text_query: 'query', limit: 3 });
  });

  it('falls back to the retiring builtin only when the REST endpoint is absent', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({
        choices: [{
          message: {
            content: null,
            tool_calls: [{ id: 'call-1', type: 'builtin_function', function: { name: '$web_search', arguments: '{"search_id":"s1"}' } }],
          },
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        choices: [{ message: { content: '[{"title":"Kimi fallback","url":"https://example.com/f","snippet":"text"}]' } }],
      }));
    vi.stubGlobal('fetch', fetchMock);

    const directApi = { provider: 'moonshot' as const, credentialId: 'provider.moonshot', baseUrl: 'https://api.moonshot.ai/v1' };
    const results = await searchWeb(context({ source: 'moonshot' }, directApi), vault({ 'provider.moonshot': 'kimi-key' }), 'query');

    expect(results[0]).toMatchObject({ title: 'Kimi fallback', url: 'https://example.com/f' });
    const secondBody = JSON.parse(String((fetchMock.mock.calls[2] as unknown as [string, RequestInit])[1].body));
    expect(secondBody.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call-1', content: '{"search_id":"s1"}' });
  });

  it('confirms a native test only when the key is stored', async () => {
    const missing = await testSearchSource('zai', 'https://api.z.ai/api/paas/v4', '', vault({}));
    expect(missing.ok).toBe(false);

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      search_result: [{ title: 'Z.AI hit', link: 'https://example.com/z', content: 'text' }],
    })));
    const present = await testSearchSource('zai', 'https://api.z.ai/api/paas/v4', '', vault({ 'provider.zai': 'key' }));
    expect(present.ok).toBe(true);
    expect(present.titles).toEqual(['Z.AI hit']);
  });
});

describe('per-run search budget', () => {
  it('refuses a search beyond the run cap without calling the service', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [{ title: 'Hit', url: 'https://example.com/h', content: '' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const runtime = new WebToolRuntime(context({ source: 'searxng', maxSearchesPerRun: 1 }), vault({}));

    await runtime.search('first', undefined);
    await expect(runtime.search('second', undefined)).rejects.toThrow(/used its 1 web searches/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports which tools are available from the settings', () => {
    const runtime = new WebToolRuntime(context({ enabled: false, fetchEnabled: true }), vault({}));
    expect(runtime.availability()).toEqual({ search: false, fetch: true });
  });
});
