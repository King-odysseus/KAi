import { parseModelIds } from './provider-models';

export interface LocalServerProbe {
  reachable: boolean;
  /** Model ids the server offers. Empty when unreachable. */
  models: string[];
  detail?: string;
}

/**
 * Asks a local OpenAI-compatible server (LM Studio) which models it has. A refused connection answers at once,
 * so a stopped server never slows the app down; the timeout only matters for a server that accepts but hangs.
 */
export async function probeLocalServer(baseUrl: string, timeoutMs = 1_500): Promise<LocalServerProbe> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { reachable: true, models: [], detail: `The server answered ${response.status}.` };
    return { reachable: true, models: parseModelIds(await response.json() as unknown) };
  } catch (error) {
    return { reachable: false, models: [], detail: error instanceof Error ? error.message : String(error) };
  }
}
