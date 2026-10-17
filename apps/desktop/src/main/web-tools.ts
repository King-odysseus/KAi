import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { z } from 'zod';
import { searchWeb, type SearchContext, type SearchCredentialPort } from './web-search';

const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;
const MAX_RETURNED_CHARS = 20_000;
const MAX_REDIRECTS = 5;

export const webSearchToolInputSchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    limit: z.number().int().min(1).max(10).optional(),
  })
  .strict();

export const webFetchToolInputSchema = z
  .object({
    url: z.string().trim().url().max(2_048),
    max_chars: z.number().int().min(500).max(MAX_RETURNED_CHARS).optional(),
  })
  .strict();

export interface FetchedPage {
  title: string;
  url: string;
  text: string;
  truncated: boolean;
}

/** Tools the model can call during an API run. They are read-only: neither changes a project file. */
export const webToolDefinitions = [
  {
    type: 'function',
    name: 'web_search',
    description: 'Search the web for current information. Returns page titles, URLs and short snippets. Use web_fetch to read a result before relying on it.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for.' },
        limit: { type: 'number', description: 'How many results to return. Defaults to the Settings value.' },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'web_fetch',
    description: 'Read one http or https page and return its visible text. Use it on a URL from web_search or one the user supplied.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The page address, starting with http:// or https://.' },
        max_chars: { type: 'number', description: 'Maximum characters to return. Defaults to 20000.' },
      },
      required: ['url'],
    },
  },
] as const;

export const WEB_TOOLS: ReadonlySet<string> = new Set(['web_search', 'web_fetch']);

/** Which web tools a run may offer. Both are read-only, and neither touches a project file. */
export interface WebToolAvailability {
  search: boolean;
  fetch: boolean;
}

/** The definitions for the tools that are currently available. */
export function webToolDefinitionsFor(availability: WebToolAvailability): readonly unknown[] {
  return webToolDefinitions.filter((definition) => (
    definition.name === 'web_search' ? availability.search : availability.fetch
  ));
}

/**
 * One run's view of the web tools: the configured search source, the credential vault, and the per-run counters.
 * Counters are consumed even when a search is served from the cache, so a model repeating the same query still
 * reaches the cap instead of looping for free.
 */
export class WebToolRuntime {
  private searches = 0;
  private fetches = 0;

  constructor(
    private readonly context: SearchContext,
    private readonly credentials: SearchCredentialPort,
  ) {}

  availability(): WebToolAvailability {
    return {
      search: this.context.settings.enabled,
      fetch: this.context.settings.fetchEnabled,
    };
  }

  async search(query: string, limit: number | undefined, signal?: AbortSignal) {
    const settings = this.context.settings;
    if (!settings.enabled) throw new Error('Web search is switched off in Settings.');
    if (this.searches >= settings.maxSearchesPerRun) {
      throw new Error(`This run has used its ${settings.maxSearchesPerRun} web searches. Use what you already have or ask the user.`);
    }
    this.searches += 1;
    return searchWeb(this.context, this.credentials, query, limit ?? settings.results, signal);
  }

  async fetch(url: string, maxChars: number | undefined, signal?: AbortSignal): Promise<FetchedPage> {
    const settings = this.context.settings;
    if (!settings.fetchEnabled) throw new Error('Web fetch is switched off in Settings.');
    if (this.fetches >= settings.maxFetchesPerRun) {
      throw new Error(`This run has used its ${settings.maxFetchesPerRun} page fetches. Use what you already have or ask the user.`);
    }
    this.fetches += 1;
    return fetchWebPage(url, { signal, timeoutMs: settings.timeoutMs, maxChars });
  }
}

/**
 * Downloads a page and returns its visible text. The request is confined to public http(s) destinations: private,
 * loopback and link-local addresses are refused before the request and again on every redirect, so a page cannot
 * be used to reach the machine or the local network.
 */
export async function fetchWebPage(
  rawUrl: string,
  options: { signal?: AbortSignal; timeoutMs?: number; maxChars?: number } = {},
): Promise<FetchedPage> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let current = await checkedUrl(rawUrl);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetch(current, { redirect: 'manual', signal, headers: { Accept: 'text/html, text/plain, application/json;q=0.9, */*;q=0.5' } });
    if (isRedirect(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`The page redirected (${response.status}) without a destination.`);
      if (redirects === MAX_REDIRECTS) throw new Error('The page redirected too many times.');
      current = await checkedUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) throw new Error(`The page answered ${response.status}.`);
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (contentType && !isReadableType(contentType)) {
      throw new Error(`The page is ${contentType.split(';')[0]}, which is not readable text.`);
    }
    const body = await readCapped(response, MAX_DOWNLOAD_BYTES);
    const decoded = body.toString('utf8');
    const title = extractTitle(decoded);
    const text = contentType.includes('html') || /<html|<body|<p[\s>]/i.test(decoded)
      ? htmlToText(decoded)
      : decoded.trim();
    const maxChars = options.maxChars ?? MAX_RETURNED_CHARS;
    return {
      title,
      url: current.toString(),
      text: text.slice(0, maxChars),
      truncated: text.length > maxChars || body.length >= MAX_DOWNLOAD_BYTES,
    };
  }
  throw new Error('The page redirected too many times.');
}

/** Rejects anything that is not a public http(s) destination. Exported so the policy tests can call it directly. */
export async function checkedUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('The address is not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https addresses can be read.');
  }
  if (url.username || url.password) throw new Error('Addresses with embedded credentials are not read.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
  if (addresses.length === 0) throw new Error('The address did not resolve.');
  for (const address of addresses) {
    if (isPrivateAddress(address)) throw new Error('The address points inside this machine or the local network, so it is not read.');
  }
  return url;
}

/** True for loopback, private, link-local, CGNAT, multicast and reserved IPv4/IPv6 ranges. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateV4(address);
  if (family === 6) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateV4(mapped[1]);
    // ::1 loopback, :: unspecified, fc00::/7 unique-local, fe80::/10 link-local.
    if (lower === '::1' || lower === '::') return true;
    const first = parseInt(lower.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return true;
    if ((first & 0xffc0) === 0xfe80) return true;
    return false;
  }
  return true;
}

function isPrivateV4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isReadableType(contentType: string): boolean {
  return contentType.startsWith('text/')
    || contentType.includes('application/json')
    || contentType.includes('application/xml')
    || contentType.includes('application/xhtml+xml');
}

async function readCapped(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = limit - total;
      if (remaining <= 0) break;
      chunks.push(value.byteLength > remaining ? value.slice(0, remaining) : value);
      total += Math.min(value.byteLength, remaining);
      if (total >= limit) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

export function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]{0,500}?)<\/title>/i.exec(html);
  return match ? decodeEntities(match[1]).replace(/\s+/g, ' ').trim() : '';
}

/** A deliberately small HTML-to-text converter: enough for documentation and articles, with no dependency. */
export function htmlToText(html: string): string {
  const withoutHidden = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|template|object|embed)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<head\b[\s\S]*?<\/head>/gi, ' ');
  const spaced = withoutHidden
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article|\/header|\/footer)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(spaced)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal: string) => safeChar(parseInt(decimal, 10)));
}

function safeChar(code: number): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}
