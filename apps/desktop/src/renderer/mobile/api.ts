import { REMOTE_PUSH_CHANNELS } from '@kai/contracts';
import type { IpcResponse, RemoteAccessStatus, RemoteWindowSummary } from '@kai/contracts';

const TOKEN_KEY = 'kai.remote.token';

/** What the phone keeps after pairing. A failure to keep it is not worth breaking the page over. */
export function rememberToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Private browsing, a locked-down webview: the token simply does not outlive this page.
  }
}

export function forgetToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing stored, nothing to forget.
  }
}

/**
 * The token from a pairing link, kept for next time; otherwise the one already stored. The token is
 * taken out of the address bar as soon as it is read, so it does not linger in history or a share.
 */
export function resolveToken(): string | null {
  const params = new URLSearchParams(window.location.search);
  const fromLink = params.get('token');
  if (fromLink) {
    rememberToken(fromLink);
    params.delete('token');
    const query = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
    return fromLink;
  }
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export class RemoteError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'RemoteError';
  }
}

/**
 * A token from whatever the user pasted: the whole pairing link, or the token on its own. The link is
 * the shape to accept, because that is what the desktop shows and what a phone copies in one gesture —
 * and it is the only way in for an installed app, which opens with no address bar to open a link from.
 */
export function tokenFromEntry(entry: string): string | null {
  const text = entry.trim();
  if (!text) return null;
  const marker = text.indexOf('?');
  const params = new URLSearchParams(marker === -1 ? '' : text.slice(marker + 1));
  const candidate = (params.get('token') ?? text).trim();
  return /^[A-Za-z0-9_-]{16,}$/.test(candidate) ? candidate : null;
}

export function isUnpaired(error: unknown): boolean {
  return error instanceof RemoteError && (error.code === 'UNPAIRED' || error.code === 'UNAUTHORIZED');
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = resolveToken();
  if (!token) throw new RemoteError('UNPAIRED', 'This phone has not been paired with KAI yet.');
  const response = await fetch(path, {
    ...init,
    headers: { ...init?.headers, authorization: `Bearer ${token}` },
  });
  if (response.status === 401) {
    forgetToken();
    throw new RemoteError('UNPAIRED', 'KAI did not accept this phone’s token. Pair it again.');
  }
  const body = (await response.json().catch(() => null)) as IpcResponse<T> | null;
  if (!body) throw new RemoteError('UNAVAILABLE', `KAI answered ${response.status} with no readable body.`);
  if (!body.ok) throw new RemoteError(body.error.code, body.error.message);
  return body.data;
}

/** Runs one channel on the desktop, through the gateway's default-deny allowlist. */
export async function ipc<T>(channel: string, input: unknown = {}, windowId: number | null = null): Promise<T> {
  return request<T>('/api/ipc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel, input, windowId }),
  });
}

export function fetchStatus(): Promise<RemoteAccessStatus> {
  return request<RemoteAccessStatus>('/api/status');
}

export function fetchWindows(): Promise<RemoteWindowSummary[]> {
  return request<RemoteWindowSummary[]>('/api/windows');
}

/** One push as the gateway sends it: which window it came from, where it sits, and what it carried. */
export interface StreamFrame {
  windowId: number | null;
  seq: number;
  payload: unknown;
}

export interface StreamHandlers {
  onFrame: (channel: string, frame: StreamFrame) => void;
  /** The phone fell too far behind for the replay buffer; state has to be read again from scratch. */
  onResync: () => void;
  onConnectionChange: (connected: boolean) => void;
}

/**
 * Follows the desktop's pushes. `EventSource` reconnects on its own and sends `Last-Event-ID` when it
 * does, which is the whole resume mechanism — so the token has to travel in the query string, because
 * that API cannot set a header. The gateway accepts it there for this route and nowhere else.
 */
export function openStream(handlers: StreamHandlers): () => void {
  const token = resolveToken();
  if (!token) return () => undefined;
  const source = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  const listen = (channel: string): void => {
    source.addEventListener(channel, (event) => {
      try {
        handlers.onFrame(channel, JSON.parse((event as MessageEvent<string>).data) as StreamFrame);
      } catch {
        // A frame that will not parse is a frame this version cannot use; the next one may be fine.
      }
    });
  };
  for (const channel of REMOTE_PUSH_CHANNELS) listen(channel);
  source.addEventListener('resync', () => handlers.onResync());
  source.addEventListener('open', () => handlers.onConnectionChange(true));
  source.addEventListener('error', () => handlers.onConnectionChange(false));
  return () => source.close();
}
