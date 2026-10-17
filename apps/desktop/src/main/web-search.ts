import {
  directProviderPreset,
  nativeSearchProvider,
  searchCredentialId,
  webSearchResultSchema,
  type ProviderId,
  type WebSearchResult,
  type WebSearchSettings,
  type WebSearchSource,
  type WebSearchTestResult,
} from '@kai/contracts';

/** The part of the credential vault a search source needs. */
export interface SearchCredentialPort {
  get(id: string): Promise<string | undefined>;
}

/** The model connection a native source borrows its key and address from. */
export interface SearchDirectApi {
  provider: ProviderId;
  credentialId: string;
  baseUrl: string;
}

export interface SearchContext {
  settings: WebSearchSettings;
  directApi?: SearchDirectApi;
}

/**
 * A small, cheap model per native provider, used only for the search call. Search does not need the model the
 * user chose for the conversation, and spending the large model's tokens on a lookup would be wasteful.
 */
const NATIVE_SEARCH_MODELS: Readonly<Record<string, string>> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-5.6-luna',
  google: 'gemini-3.8-flash',
  moonshot: 'kimi-k2.6',
  zai: 'glm-4.7',
};

interface CacheEntry {
  at: number;
  results: WebSearchResult[];
}

const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 200;
const cache = new Map<string, CacheEntry>();

/** The credential a source uses: the override when set, the current Direct API key, or the provider's own key. */
export function searchCredentialFor(source: WebSearchSource, override = '', directApi?: SearchDirectApi): string {
  const trimmed = override.trim();
  if (trimmed) return trimmed;
  const provider = nativeSearchProvider(source);
  if (provider) {
    if (directApi?.provider === provider) return directApi.credentialId;
    return directProviderPreset(provider).credentialId;
  }
  return searchCredentialId(source);
}

/** The address a native source calls: the current Direct API address when it is the same provider, else the preset. */
function nativeBaseUrl(provider: ProviderId, directApi?: SearchDirectApi): string {
  return directApi?.provider === provider ? directApi.baseUrl : directProviderPreset(provider).defaultBaseUrl;
}

/**
 * Search the web through the configured source. External sources call a search service; native sources make one
 * small call to that provider's API using the same kind of key the provider already has. Either way the model
 * receives a plain list of sources, so search works with any model.
 */
export async function searchWeb(
  context: SearchContext,
  credentials: SearchCredentialPort,
  query: string,
  limit = context.settings.results,
  signal?: AbortSignal,
): Promise<WebSearchResult[]> {
  const settings = context.settings;
  if (!settings.enabled) throw new Error('Web search is switched off in Settings.');
  const source = settings.source;
  const count = Math.max(1, Math.min(limit, settings.results));

  const cacheKey = `${source}:${count}:${query.trim().toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.results;

  const credentialId = searchCredentialFor(source, settings.credentialId, context.directApi);
  const apiKey = credentialId ? await readCredential(credentials, credentialId) : '';
  const timeout = AbortSignal.timeout(settings.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const results = source === 'searxng'
    ? await searchSearxng(settings.endpoint, query, count, combined)
    : source === 'brave'
      ? await searchBrave(apiKey, credentialId, query, count, combined)
      : source === 'tavily'
        ? await searchTavily(apiKey, credentialId, query, count, combined)
        : await searchNative(source, nativeBaseUrl(nativeSearchProvider(source)!, context.directApi), apiKey, credentialId, query, count, combined);

  remember(cacheKey, results);
  return results;
}

/** Exercises one source without starting a model run. */
export async function testSearchSource(
  source: WebSearchSource,
  endpoint: string,
  credentialOverride: string,
  credentials: SearchCredentialPort,
  directApi?: SearchDirectApi,
  timeoutMs = 15_000,
): Promise<WebSearchTestResult> {
  const credentialId = searchCredentialFor(source, credentialOverride, directApi);
  let apiKey: string;
  try {
    apiKey = credentialId ? await readCredential(credentials, credentialId) : '';
  } catch (error) {
    return { ok: false, detail: messageOf(error), titles: [] };
  }

  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const results = source === 'searxng'
      ? await searchSearxng(endpoint, 'KAI search test', 3, signal)
      : source === 'brave'
        ? await searchBrave(apiKey, credentialId, 'KAI search test', 3, signal)
        : source === 'tavily'
          ? await searchTavily(apiKey, credentialId, 'KAI search test', 3, signal)
          : await searchNative(source, nativeBaseUrl(nativeSearchProvider(source)!, directApi), apiKey, credentialId, 'KAI search test', 3, signal);
    return {
      ok: true,
      detail: results.length
        ? `${results.length} result${results.length === 1 ? '' : 's'} returned.`
        : 'The service answered but returned no results.',
      titles: results.map((result) => result.title).slice(0, 5),
    };
  } catch (error) {
    return { ok: false, detail: messageOf(error), titles: [] };
  }
}

/** Clears the in-memory cache. Tests use it; the app never needs to. */
export function clearSearchCache(): void {
  cache.clear();
}

function remember(key: string, results: WebSearchResult[]): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), results });
}

async function readCredential(credentials: SearchCredentialPort, id: string): Promise<string> {
  const value = await credentials.get(id);
  if (!value?.trim()) throw new Error(`No key is stored for ${id}. Save it in the Web search card or the Direct API card.`);
  return value.trim();
}

// ---------------------------------------------------------------------------------------------------------------
// External search services

async function searchSearxng(endpoint: string, query: string, limit: number, signal: AbortSignal): Promise<WebSearchResult[]> {
  const base = endpoint.replace(/\/+$/, '');
  const url = new URL(`${base}/search`);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('language', 'en');

  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  if (!response.ok) {
    if (response.status === 403 || response.status === 404) {
      throw new Error(`SearXNG answered ${response.status} at ${endpoint}. Enable the JSON format in its settings.yml (search.formats: [html, json]).`);
    }
    throw new Error(`SearXNG answered ${response.status}${await responseDetail(response)}`);
  }
  const body = await response.json() as { results?: unknown };
  return normalizeResults(body.results, limit);
}

async function searchBrave(
  apiKey: string,
  credentialId: string,
  query: string,
  limit: number,
  signal: AbortSignal,
): Promise<WebSearchResult[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(limit));
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
    signal,
  });
  if (!response.ok) throw searchServiceError('Brave', response.status, credentialId, await responseDetail(response));
  const body = await response.json() as { web?: { results?: unknown } };
  return normalizeResults(body.web?.results, limit);
}

async function searchTavily(
  apiKey: string,
  credentialId: string,
  query: string,
  limit: number,
  signal: AbortSignal,
): Promise<WebSearchResult[]> {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: limit, search_depth: 'basic', include_answer: false }),
    signal,
  });
  if (!response.ok) throw searchServiceError('Tavily', response.status, credentialId, await responseDetail(response));
  const body = await response.json() as { results?: unknown };
  return normalizeResults(body.results, limit);
}

// ---------------------------------------------------------------------------------------------------------------
// Native provider search: one small non-streaming call to the provider that owns the search tool

async function searchNative(
  source: WebSearchSource,
  baseUrl: string,
  apiKey: string,
  credentialId: string,
  query: string,
  limit: number,
  signal: AbortSignal,
): Promise<WebSearchResult[]> {
  if (source === 'anthropic') return searchAnthropic(baseUrl, apiKey, credentialId, query, limit, signal);
  if (source === 'openai') return searchOpenai(baseUrl, apiKey, credentialId, query, limit, signal);
  if (source === 'google') return searchGoogle(baseUrl, apiKey, credentialId, query, limit, signal);
  if (source === 'moonshot') return searchMoonshot(baseUrl, apiKey, credentialId, query, limit, signal);
  if (source === 'zai') return searchZai(baseUrl, apiKey, credentialId, query, limit, signal);
  throw new Error(`Unknown search source: ${source}.`);
}

async function searchAnthropic(
  baseUrl: string,
  apiKey: string,
  credentialId: string,
  query: string,
  limit: number,
  signal: AbortSignal,
): Promise<WebSearchResult[]> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      model: NATIVE_SEARCH_MODELS.anthropic,
      max_tokens: 1_024,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: limit }],
      messages: [{ role: 'user', content: `Search the web for: ${query}` }],
    }),
    signal,
  });
  if (!response.ok) throw searchServiceError('Anthropic', response.status, credentialId, await responseDetail(response));
  const body = await response.json() as { content?: unknown };
  const results: WebSearchResult[] = [];
  for (const block of Array.isArray(body.content) ? body.content : []) {
    if (!block || typeof block !== 'object') continue;
    const record = block as Record<string, unknown>;
    if (record.type === 'web_search_tool_result') {
      for (const item of Array.isArray(record.content) ? record.content : []) {
        if (!item || typeof item !== 'object') continue;
        const hit = item as Record<string, unknown>;
        if (hit.type !== 'web_search_result') continue;
        results.push(resultOf(hit.title, hit.url, firstString(hit.page_age, '')));
      }
    }
    if (record.type === 'text' && Array.isArray(record.citations)) {
      for (const citation of record.citations) {
        if (!citation || typeof citation !== 'object') continue;
        const hit = citation as Record<string, unknown>;
        results.push(resultOf(hit.title, hit.url, firstString(hit.cited_text)));
      }
    }
  }
  return normalizeResults(results, limit);
}

async function searchOpenai(
  baseUrl: string,
  apiKey: string,
  credentialId: string,
  query: string,
  limit: number,
  signal: AbortSignal,
): Promise<WebSearchResult[]> {
  const ask = (tool: string) => fetch(`${baseUrl.replace(/\/+$/, '')}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      model: NATIVE_SEARCH_MODELS.openai,
      input: `Search the web for: ${query}`,
      tools: [{ type: tool }],
      max_output_tokens: 1_024,
    }),
    signal,
  });

  let response = await ask('web_search');
  if (!response.ok && (response.status === 400 || response.status === 404)) {
    response = await ask('web_search_preview');
  }
  if (!response.ok) throw searchServiceError('OpenAI', response.status, credentialId, await responseDetail(response));
  const body = await response.json() as { output?: unknown };
  const results: WebSearchResult[] = [];
  for (const item of Array.isArray(body.output) ? body.output : []) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (record.type !== 'message' || !Array.isArray(record.content)) continue;
    for (const part of record.content) {
      if (!part || typeof part !== 'object') continue;
      const content = part as Record<string, unknown>;
      if (content.type !== 'output_text' || !Array.isArray(content.annotations)) continue;
      const text = firstString(content.text);
      for (const annotation of content.annotations) {
        if (!annotation || typeof annotation !== 'object') continue;
        const citation = annotation as Record<string, unknown>;
        if (citation.type !== 'url_citation') continue;
        const start = typeof citation.start_index === 'number' ? citation.start_index : 0;
        const end = typeof citation.end_index === 'number' ? citation.end_index : start + 300;
        results.push(resultOf(citation.title, citation.url, text.slice(start, end)));
      }
    }
  }
  return normalizeResults(results, limit);
}

async function searchGoogle(
  baseUrl: string,
  apiKey: string,
  credentialId: string,
  query: string,
  limit: number,
  signal: AbortSignal,
): Promise<WebSearchResult[]> {
  const model = NATIVE_SEARCH_MODELS.google;
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: `Search the web for: ${query}` }] }],
      tools: [{ google_search: {} }],
      generationConfig: { maxOutputTokens: 1_024 },
    }),
    signal,
  });
  if (!response.ok) throw searchServiceError('Google', response.status, credentialId, await responseDetail(response));
  const body = await response.json() as {
    candidates?: Array<{ groundingMetadata?: { groundingChunks?: unknown; groundingSupports?: unknown } }>;
  };
  const meta = body.candidates?.[0]?.groundingMetadata;
  const snippets = new Map<string, string>();
  for (const support of Array.isArray(meta?.groundingSupports) ? meta.groundingSupports : []) {
    if (!support || typeof support !== 'object') continue;
    const record = support as Record<string, unknown>;
    const segment = record.segment && typeof record.segment === 'object' ? record.segment as Record<string, unknown> : undefined;
    const text = firstString(segment?.text);
    for (const index of Array.isArray(record.groundingChunkIndices) ? record.groundingChunkIndices : []) {
      if (typeof index === 'number' && text && !snippets.has(String(index))) snippets.set(String(index), text);
    }
  }
  const results: WebSearchResult[] = [];
  const chunks = Array.isArray(meta?.groundingChunks) ? meta.groundingChunks : [];
  chunks.forEach((chunk: unknown, index: number) => {
    if (!chunk || typeof chunk !== 'object') return;
    const web = (chunk as Record<string, unknown>).web;
    if (!web || typeof web !== 'object') return;
    const record = web as Record<string, unknown>;
    results.push(resultOf(record.title, record.uri, snippets.get(String(index)) ?? ''));
  });
  return normalizeResults(results, limit);
}

async function searchMoonshot(
  baseUrl: string,
  apiKey: string,
  credentialId: string,
  query: string,
  limit: number,
  signal: AbortSignal,
): Promise<WebSearchResult[]> {
  const base = baseUrl.replace(/\/+$/, '');
  // The standalone search API is the current one: POST /v1/tools/search, billed per call, no chat model involved.
  const response = await fetch(`${base}/tools/search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ text_query: query, limit }),
    signal,
  });
  if (response.ok) {
    const body = await response.json() as { search_results?: unknown };
    // An empty list is a real answer. Do not quietly fall back to the retired chat tool when it simply found nothing.
    return normalizeResults(body.search_results, limit);
  }
  // The `$web_search` builtin retires on 2026-10-20. Keep it only for an address or plan that does not expose the
  // REST endpoint yet; every other failure is reported as itself.
  if (response.status !== 404 && response.status !== 405) {
    throw searchServiceError('Moonshot', response.status, credentialId, await responseDetail(response));
  }
  return searchMoonshotBuiltin(base, apiKey, credentialId, query, limit, signal);
}

/** The retiring chat-completions flow, kept as a fallback for plans without the standalone search endpoint. */
async function searchMoonshotBuiltin(
  baseUrl: string,
  apiKey: string,
  credentialId: string,
  query: string,
  limit: number,
  signal: AbortSignal,
): Promise<WebSearchResult[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const tools = [{ type: 'builtin_function', function: { name: '$web_search' } }];
  const messages: Array<Record<string, unknown>> = [{
    role: 'user',
    content: `Search the web for: ${query}\n\nAfter searching, reply with a JSON array of the sources you used, in the form [{"title":"…","url":"…","snippet":"…"}]. Reply with the JSON array only.`,
  }];

  const send = (body: Record<string, unknown>) => fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ model: NATIVE_SEARCH_MODELS.moonshot, tools, ...body }),
    signal,
  });

  let response = await send({ messages });
  if (!response.ok) throw searchServiceError('Moonshot', response.status, credentialId, await responseDetail(response));

  let body = await response.json() as {
    choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown } }>;
  };
  const first = body.choices?.[0]?.message;
  const toolCall = Array.isArray(first?.tool_calls) ? first.tool_calls[0] : undefined;
  if (toolCall && typeof toolCall === 'object') {
    const call = toolCall as Record<string, unknown>;
    const fn = call.function && typeof call.function === 'object' ? call.function as Record<string, unknown> : undefined;
    if (fn?.name === '$web_search') {
      // Moonshot runs the search itself: the arguments must be echoed back verbatim as the tool result.
      const echoed = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {});
      messages.push({ role: 'assistant', content: first?.content ?? null, tool_calls: first?.tool_calls });
      messages.push({ role: 'tool', tool_call_id: call.id, name: '$web_search', content: echoed });
      response = await send({ messages });
      if (!response.ok) throw searchServiceError('Moonshot', response.status, credentialId, await responseDetail(response));
      body = await response.json() as typeof body;
    }
  }

  const content = firstString(body.choices?.[0]?.message?.content);
  return parseJsonLinks(content, limit);
}

async function searchZai(
  baseUrl: string,
  apiKey: string,
  credentialId: string,
  query: string,
  limit: number,
  signal: AbortSignal,
): Promise<WebSearchResult[]> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/web_search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ search_engine: 'search_std', search_query: query, count: limit }),
    signal,
  });
  if (!response.ok) {
    if (response.status === 404 || response.status === 405) {
      throw new Error('This Z.AI address does not expose the search endpoint. Use the standard api.z.ai address, or choose another search source.');
    }
    throw searchServiceError('Z.AI', response.status, credentialId, await responseDetail(response));
  }
  const body = await response.json() as { search_result?: unknown };
  return normalizeResults(body.search_result, limit);
}

// ---------------------------------------------------------------------------------------------------------------
// Shared parsing

/** Extracts a JSON array of links from a model reply, tolerating a fenced block or a sentence around it. */
function parseJsonLinks(content: string, limit: number): WebSearchResult[] {
  const candidates = [
    content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1],
    content.match(/(\[[\s\S]*\])/)?.[1],
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const results = normalizeResults(parsed, limit);
      if (results.length) return results;
    } catch {
      // Try the next candidate.
    }
  }
  // Last resort: markdown links, which models reliably produce even when they ignore the JSON instruction.
  const links: Array<{ title: string; url: string; snippet: string }> = [];
  const pattern = /\[([^\]]{1,300})\]\((https?:\/\/[^\s)]+)\)/g;
  for (let match = pattern.exec(content); match; match = pattern.exec(content)) {
    links.push({ title: match[1], url: match[2], snippet: '' });
    if (links.length >= limit) break;
  }
  return normalizeResults(links, limit);
}

function resultOf(title: unknown, url: unknown, snippet: unknown): WebSearchResult {
  const parsed = webSearchResultSchema.safeParse({
    title: firstString(title).slice(0, 500) || firstString(url).slice(0, 500),
    url: firstString(url),
    snippet: firstString(snippet).slice(0, 2_000),
  });
  return parsed.success ? parsed.data : { title: '', url: '', snippet: '' };
}

function normalizeResults(value: unknown, limit: number): WebSearchResult[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const results: WebSearchResult[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const title = firstString(record.title, record.name);
    const url = firstString(record.url, record.link, record.href, record.uri);
    if (!title || !url) continue;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    const key = parsed.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    const parsedResult = webSearchResultSchema.safeParse({
      title: title.slice(0, 500),
      url: key,
      snippet: firstString(record.content, record.description, record.snippet, record.cited_text).slice(0, 2_000),
    });
    if (parsedResult.success) results.push(parsedResult.data);
    if (results.length >= limit) break;
  }
  return results;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function searchServiceError(service: string, status: number, credentialId: string, detail: string): Error {
  if (status === 401 || status === 403) return new Error(`${service} rejected the key stored for ${credentialId}.`);
  if (status === 429) return new Error(`${service} is rate-limiting this key. Try again shortly or lower the per-run cap.`);
  return new Error(`${service} answered ${status}${detail}`);
}

async function responseDetail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim().replace(/\s+/g, ' ');
    return text ? `: ${text.slice(0, 300)}` : '';
  } catch {
    return '';
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return 'The search service did not answer before the timeout.';
    return error.message;
  }
  return 'The search request failed.';
}
