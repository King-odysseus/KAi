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
export async function probeLocalServer(baseUrl: string, apiKey?: string, timeoutMs = 1_500): Promise<LocalServerProbe> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  try {
    // A server on the network (a gateway in front of Ollama or vLLM) often wants the key even to list its models;
    // without it the answer is 401 and a working server looked like one with no models.
    const headers: Record<string, string> = { Accept: 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { reachable: true, models: [], detail: `The server answered ${response.status}.${response.status === 401 || response.status === 403 ? ' It wants a key: save one for this provider in Settings.' : ''}` };
    return { reachable: true, models: parseModelIds(await response.json() as unknown) };
  } catch (error) {
    return { reachable: false, models: [], detail: error instanceof Error ? error.message : String(error) };
  }
}
