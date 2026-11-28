import type { ApiConnection } from './architect';
import type { AppSettings } from './domain';

export type ModelHost = 'this-computer' | 'own-hardware' | 'cloud';

/** Classifies a saved connection without tying gateway ownership to the current Direct API provider. */
export function modelHostOf(
  connection: Pick<ApiConnection, 'provider' | 'baseUrl'>,
  settings: AppSettings,
): ModelHost {
  if (connection.provider === 'openai-compatible' && settings.gatewayOwnHardware) {
    const ownedUrls = [
      settings.gatewayAwayUrl,
      settings.gatewayHomeUrl,
      // Only until a gateway address is saved: afterwards the default may be somebody else's service.
      !settings.gatewayAwayUrl && settings.directApi.provider === 'openai-compatible' ? settings.directApi.baseUrl : null,
    ].filter((value): value is string => Boolean(value));
    const matchesOwnedGateway = connection.baseUrl
      ? ownedUrls.some((url) => normalizeUrl(connection.baseUrl!) === normalizeUrl(url))
      : ownedUrls.length > 0;
    if (matchesOwnedGateway) return 'own-hardware';
  }
  if (connection.provider === 'lmstudio' || connection.provider === 'ollama' || connection.provider === 'llamacpp' || connection.provider === 'vllm') {
    return 'this-computer';
  }
  if (connection.baseUrl) {
    try {
      const host = new URL(connection.baseUrl).hostname;
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return 'this-computer';
    } catch { /* Invalid addresses are handled by connection validation. */ }
  }
  return 'cloud';
}

function normalizeUrl(value: string): string {
  try { return new URL(value).toString().replace(/\/$/, ''); } catch { return value.replace(/\/$/, ''); }
}
