import {
  directProviderPreset,
  isLocalProvider,
  providerModelCatalogSchema,
  type ProviderId,
  type ProviderModelCatalog,
} from '@kai/contracts';

interface CredentialPort {
  get(id: string): Promise<string | undefined>;
}

export async function listProviderModels(
  request: { provider: ProviderId; baseUrl: string; credentialId: string },
  credentials: CredentialPort,
  timeoutMs = 15_000,
): Promise<ProviderModelCatalog> {
  const preset = directProviderPreset(request.provider);
  const fallback = (error: string): ProviderModelCatalog => providerModelCatalogSchema.parse({
    provider: request.provider,
    models: [...preset.models],
    source: 'preset',
    fetchedAt: new Date().toISOString(),
    error,
  });

  let apiKey: string | undefined;
  try {
    apiKey = await credentials.get(request.credentialId);
  } catch (error) {
    return fallback(`The stored credential could not be read: ${messageOf(error)}`);
  }
  if (!apiKey && request.provider !== 'openrouter' && !isLocalProvider(request.provider) && !isLocalEndpoint(request.baseUrl)) {
    return fallback(`Save a credential for ${request.credentialId} before refreshing this provider's models.`);
  }

  try {
    const response = await fetch(modelsUrl(request.provider, request.baseUrl), {
      method: 'GET',
      headers: modelsHeaders(request.provider, apiKey),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return fallback(`The provider model list request failed (${response.status})${await responseDetail(response)}`);
    }
    const body = await response.json() as unknown;
    const models = parseModelIds(body);
    if (models.length === 0) return fallback('The provider returned an empty model list.');
    let contextLengths = parseModelContexts(body, request.provider !== 'openai-compatible');
    if (request.provider === 'lmstudio') {
      const studioContexts = await fetchLmStudioContexts(request.baseUrl, timeoutMs);
      contextLengths = { ...contextLengths, ...studioContexts };
    }
    return providerModelCatalogSchema.parse({
      provider: request.provider,
      models,
      source: 'live',
      fetchedAt: new Date().toISOString(),
      error: null,
      ...(Object.keys(contextLengths).length ? { contextLengths } : {}),
    });
  } catch (error) {
    if (isLocalProvider(request.provider)) {
      return fallback(`${preset.displayName} is not reachable at ${request.baseUrl}. Start its server and make sure a model is installed, then refresh. (${messageOf(error)})`);
    }
    return fallback(`The provider model list could not be refreshed: ${messageOf(error)}`);
  }
}

async function fetchLmStudioContexts(baseUrl: string, timeoutMs: number): Promise<Record<string, number>> {
  try {
    const origin = new URL(baseUrl).origin;
    const response = await fetch(`${origin}/api/v0/models`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return {};
    return parseModelContexts(await response.json(), true);
  } catch {
    return {};
  }
}

/**
 * A local server only lists what is loaded or installed right now, so a refresh used to replace the list and drop
 * every model that was not there at that moment. Local providers keep what they have seen: the answer is the
 * remembered models plus whatever the server returned, and a live answer adds to the remembered list.
 */
export function mergeLocalModels(
  catalog: ProviderModelCatalog,
  remembered: readonly string[],
): { catalog: ProviderModelCatalog; remembered: string[] } {
  const union = (...lists: readonly (readonly string[])[]): string[] =>
    [...new Set(lists.flat())].sort((left, right) => left.localeCompare(right));
  const fixed = catalog.provider === 'openai-compatible' ? directProviderPreset(catalog.provider).models : [];
  const seen = catalog.source === 'live' ? union(remembered, catalog.models, fixed) : union(remembered, fixed);
  // An unreachable server answers with the bundled preset; keep it only as a fallback when nothing is remembered.
  const models = catalog.source === 'live' || seen.length === 0 ? union(seen, catalog.models) : seen;
  return { catalog: { ...catalog, models }, remembered: seen };
}

/**
 * The context window each model in a list reports, by id. Servers name it differently: LM Studio's own API says
 * loaded_context_length and max_context_length, OpenRouter context_length, vLLM max_model_len. What a model is loaded
 * with wins over what it could hold, since a request beyond the loaded size fails.
 */
export function parseModelContexts(value: unknown, preferLoaded = true): Record<string, number> {
  const records = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).data)
      ? (value as Record<string, unknown>).data as unknown[]
      : value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).models)
        ? (value as Record<string, unknown>).models as unknown[]
        : [];
  const result: Record<string, number> = {};
  for (const entry of records) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : typeof record.name === 'string' ? record.name : typeof record.model === 'string' ? record.model : '';
    if (!id.trim()) continue;
    const top = record.top_provider && typeof record.top_provider === 'object' ? (record.top_provider as Record<string, unknown>).context_length : undefined;
    // A gateway loads models on demand, so what is loaded right now says nothing about what a request can use.
    const first = preferLoaded ? [record.loaded_context_length, record.context_length] : [record.context_length];
    const size = [...first, record.max_context_length, record.context_window, record.max_model_len, top]
      .find((candidate) => typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) as number | undefined;
    if (size) result[id] = size;
  }
  return result;
}

export function parseModelIds(value: unknown): string[] {
  const records = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).data)
      ? (value as Record<string, unknown>).data as unknown[]
      : value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).models)
        ? (value as Record<string, unknown>).models as unknown[]
        : [];
  const models = records.flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    const candidate = typeof record.id === 'string'
      ? record.id
      : typeof record.name === 'string'
        ? record.name
        : typeof record.model === 'string'
          ? record.model
          : '';
    return [candidate];
  }).filter((model) => model.trim().length > 0);
  return [...new Set(models)].sort((left, right) => left.localeCompare(right)).slice(0, 2_000);
}

function modelsUrl(provider: ProviderId, baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (/\/models$/i.test(trimmed)) return trimmed;
  if (provider === 'google') return `${trimmed}/models`;
  return `${trimmed}/models`;
}

function modelsHeaders(provider: ProviderId, apiKey: string | undefined): Record<string, string> {
  if (!apiKey) return { Accept: 'application/json' };
  if (provider === 'anthropic') {
    return {
      Accept: 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
  }
  if (provider === 'google') {
    return {
      Accept: 'application/json',
      'x-goog-api-key': apiKey,
    };
  }
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
}

function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

async function responseDetail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    return text ? `: ${text.slice(0, 1_000)}` : '.';
  } catch {
    return '.';
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
