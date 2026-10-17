import { z } from 'zod';
import type { ProviderId } from './primitives';

/**
 * Where the agent's web search comes from. External sources work with any model; the native sources are tools
 * that run inside a request to that provider, so they are only available when the run uses the same provider.
 */
export const WEB_SEARCH_SOURCES = ['searxng', 'brave', 'tavily', 'anthropic', 'openai', 'google', 'moonshot', 'zai', 'deepseek'] as const;
export const webSearchSourceSchema = z.enum(WEB_SEARCH_SOURCES);
export type WebSearchSource = z.infer<typeof webSearchSourceSchema>;

export const WEB_SEARCH_SOURCE_LABEL: Readonly<Record<WebSearchSource, string>> = {
  searxng: 'SearXNG (local, free)',
  brave: 'Brave Search',
  tavily: 'Tavily',
  anthropic: 'Anthropic (native)',
  openai: 'OpenAI (native)',
  google: 'Google (native)',
  moonshot: 'Moonshot / Kimi (native)',
  deepseek: 'DeepSeek (native)',
  zai: 'Z.AI / GLM (native)',
};

/** The provider whose own search tool a native source uses, or null for an external search service. */
export function nativeSearchProvider(source: WebSearchSource): ProviderId | null {
  if (source === 'anthropic' || source === 'openai' || source === 'google' || source === 'moonshot' || source === 'zai' || source === 'deepseek') {
    return source;
  }
  return null;
}

/** Keys for the external search services. Native sources reuse the matching `provider.*` credential. */
export function searchCredentialId(source: WebSearchSource): string {
  if (source === 'brave') return 'search.brave';
  if (source === 'tavily') return 'search.tavily';
  return '';
}

export const webSearchSettingsSchema = z
  .object({
    /** Search the web. Off still allows `web_fetch` when `fetchEnabled` is on. */
    enabled: z.boolean().default(false),
    /** Let the agent read a URL the user or the model supplies. This is free and needs no search service. */
    fetchEnabled: z.boolean().default(true),
    source: webSearchSourceSchema.default('searxng'),
    /** SearXNG's address. Other sources use their own fixed endpoints. */
    endpoint: z.string().url().default('http://127.0.0.1:8080'),
    /**
     * A credential ID to use instead of the derived one. Blank means the native provider's existing key, or
     * `search.brave` / `search.tavily` for those services.
     */
    credentialId: z.string().max(200).default(''),
    results: z.number().int().min(1).max(10).default(5),
    maxSearchesPerRun: z.number().int().min(1).max(50).default(5),
    maxFetchesPerRun: z.number().int().min(1).max(50).default(8),
    timeoutMs: z.number().int().min(1_000).max(60_000).default(15_000),
  })
  .strict();
export type WebSearchSettings = z.infer<typeof webSearchSettingsSchema>;

/** One page returned by a search service. */
export const webSearchResultSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    url: z.string().url(),
    snippet: z.string().max(2_000).default(''),
  })
  .strict();
export type WebSearchResult = z.infer<typeof webSearchResultSchema>;

export const webSearchTestResultSchema = z
  .object({
    ok: z.boolean(),
    detail: z.string().max(2_000),
    /** Sample titles, never page contents, so a test can show what the source returned without storing it. */
    titles: z.array(z.string().max(500)).max(10).default([]),
  })
  .strict();
export type WebSearchTestResult = z.infer<typeof webSearchTestResultSchema>;
