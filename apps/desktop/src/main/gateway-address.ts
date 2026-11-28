import { modelHostOf, type ApiConnection, type AppSettings } from '@kai/contracts';

export interface GatewayAddress {
  baseUrl: string;
  label: 'home' | 'away' | 'direct';
  statusRoot?: string;
}

/** Prefer the Mac gateway at home; use the configured relay when home cannot be reached. */
export async function resolveGatewayAddress(
  connection: ApiConnection,
  settings: AppSettings,
  _apiKey?: string,
): Promise<GatewayAddress> {
  const ownHardware = connection.provider === 'openai-compatible' && modelHostOf(connection, settings) === 'own-hardware';
  const configured = ownHardware
    ? settings.gatewayAwayUrl ?? (settings.directApi.provider === 'openai-compatible' ? settings.directApi.baseUrl : connection.baseUrl ?? settings.directApi.baseUrl)
    : connection.baseUrl ?? settings.directApi.baseUrl;
  const homeBase = settings.gatewayHomeUrl?.replace(/\/+$/, '');
  if (!ownHardware) {
    return { baseUrl: configured, label: 'direct' };
  }
  if (!homeBase) return { baseUrl: configured, label: 'away' };
  if (!/\/v1$/i.test(homeBase) || /:1234(?:\/|$)/.test(homeBase)) return { baseUrl: configured, label: 'away' };
  const statusRoot = homeBase.replace(/\/v1$/i, '');
  try {
    const response = await fetch(`${homeBase}/models`, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(1_500),
    });
    const body = await response.text();
    const isGatewayAuthChallenge = response.status === 401 && /authentication credentials were not provided/i.test(body);
    const isGatewayModelList = response.ok && /gateway\/(?:coding|general|vision|research)/i.test(body);
    if ((!response.url || response.url === `${homeBase}/models`) && (isGatewayAuthChallenge || isGatewayModelList)) {
      const queueCheck = await fetch(`${statusRoot}/api/routing/queue/`, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(1_500),
      });
      const queueBody = await queueCheck.text();
      const hasStatusRoutes = queueCheck.status === 401 && /authentication credentials were not provided/i.test(queueBody);
      return { baseUrl: homeBase, label: 'home', ...(hasStatusRoutes ? { statusRoot } : {}) };
    }
  } catch { /* A home health-check failure falls through to the existing relay. */ }
  return { baseUrl: configured, label: 'away' };
}

