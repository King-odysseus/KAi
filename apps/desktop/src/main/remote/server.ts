import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import type { AddressInfo } from 'node:net';
import type {
  IpcChannel,
  RemoteAccessSettings,
  RemoteAccessStatus,
  RemoteTokenResult,
  RemoteWindowSummary,
} from '@kai/contracts';
import type { RedactedLogger } from '@kai/runtime';
import type { CredentialVault } from '../credential-vault';
import { failureFor } from '../ipc';
import { bearerToken, RemoteTokenStore, summarise, type RemoteDeviceSummary } from './auth';
import { RemoteChannelDenied, RemoteDispatcher, RemoteWindowUnavailable } from './dispatch';
import { isDroppableFrame, RemoteEventStream, type RemoteFrame, type WindowEventLike } from './events';

/** A body larger than this is refused unread: the phone sends small requests, so a big one is a mistake. */
const MAX_BODY_BYTES = 256 * 1024;
/** Past this much unflushed output the tail is dropped; past the second, the client is asked to resume. */
const STREAM_DROP_BYTES = 256 * 1024;
const STREAM_KILL_BYTES = 4 * 1024 * 1024;
/** A comment line now and then keeps idle proxies from closing a stream that is simply quiet. */
const STREAM_HEARTBEAT_MS = 15_000;

export interface RemoteGatewayOptions {
  credentials: CredentialVault;
  dispatcher: RemoteDispatcher;
  /** Resolves the desktop windows a phone can target. Injected so the gateway needs no project store. */
  describeWindows: () => Promise<RemoteWindowSummary[]>;
  /** Where the built phone UI lives. Absent in tests, and until a renderer build has produced it. */
  mobileRoot?: string;
  /** Follows the desktop's window pushes so the phone sees the same tail. Optional in tests. */
  subscribeWindowEvents?: (subscriber: (push: WindowEventLike) => void) => () => void;
  appName: string;
  version: string;
  logger: Pick<RedactedLogger, 'info' | 'warn' | 'error'>;
  /** The remote settings, read fresh so a change in Settings takes effect without a restart. */
  settings: () => Promise<RemoteAccessSettings>;
}

/**
 * The HTTP gateway KAI Remote is served from. It is not the preload bridge: a page on the LAN cannot
 * pass `assertTrustedSender`, so this listener authenticates with its own bearer token and then runs
 * requests through `RemoteDispatcher`, which applies a default-deny allowlist before any handler runs.
 */
export class RemoteGateway {
  private readonly tokens: RemoteTokenStore;
  private readonly events = new RemoteEventStream();
  private readonly detachEvents: () => void;
  private server: http.Server | null = null;
  private boundAddress: string | null = null;
  private boundPort: number | null = null;
  private lastError: string | null = null;

  constructor(private readonly options: RemoteGatewayOptions) {
    this.tokens = new RemoteTokenStore(options.credentials);
    this.detachEvents = options.subscribeWindowEvents?.((push) => this.events.record(push)) ?? (() => undefined);
  }

  isRunning(): boolean {
    return this.server !== null;
  }

  async status(): Promise<RemoteAccessStatus> {
    const settings = await this.options.settings();
    return {
      enabled: settings.enabled,
      running: this.isRunning(),
      lanEnabled: settings.lanEnabled,
      port: this.boundPort,
      urls: this.urls(settings),
      lanUrl: this.lanUrl(settings),
      tokenSet: (await this.tokens.list()).length > 0,
      connectedClients: this.events.clientCount,
      lastError: this.lastError,
    };
  }

  async windows(): Promise<RemoteWindowSummary[]> {
    return this.options.describeWindows();
  }

  /** Pairs one more device. The token belongs to that device alone, so nothing already paired is disturbed. */
  async pairDevice(label: string): Promise<RemoteTokenResult> {
    const device = await this.tokens.create(label);
    return { token: device.token, urls: this.urls(await this.options.settings()) };
  }

  async devices(): Promise<RemoteDeviceSummary[]> {
    return (await this.tokens.list()).map(summarise);
  }

  async revokeDevice(id: string): Promise<RemoteDeviceSummary[]> {
    return (await this.tokens.revoke(id)).map(summarise);
  }

  /** Brings the listener in line with `settings`: starts it, stops it, or moves it. Idempotent. */
  async apply(settings: RemoteAccessSettings): Promise<void> {
    if (!settings.enabled) {
      await this.stop();
      return;
    }
    if (!this.options.credentials.isAvailable()) {
      this.lastError = 'OS credential encryption is unavailable, so KAI will not mint a remote token.';
      throw new Error(this.lastError);
    }
    const address = resolveBindAddress(settings.lanEnabled);
    if (!address) {
      this.lastError = 'LAN access was requested but this machine has no private IPv4 address to bind.';
      throw new Error(this.lastError);
    }
    await this.tokens.ensure();
    if (this.server && this.boundAddress === address && this.boundPort === settings.port) return;
    await this.stop();
    await this.listen(address, settings.port);
  }

  async dispose(): Promise<void> {
    this.detachEvents();
    await this.stop();
  }

  private listen(address: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((request, response) => {
        void this.handle(request, response);
      });
      const onError = (error: Error): void => {
        server.removeListener('listening', onListening);
        this.lastError = error.message;
        this.options.logger.error('internal', 'KAI Remote could not listen', `${address}:${port}`, error);
        reject(error);
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        const info = server.address() as AddressInfo | null;
        this.server = server;
        this.boundAddress = address;
        this.boundPort = info?.port ?? port;
        this.lastError = null;
        this.options.logger.info('internal', `KAI Remote listening on ${address}:${this.boundPort}`);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, address);
    });
  }

  private async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.boundAddress = null;
    this.boundPort = null;
    if (!server) return;
    // A phone holding a keep-alive socket would otherwise stall shutdown for the whole keep-alive window.
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private urls(settings: RemoteAccessSettings): string[] {
    const host = this.boundAddress ?? '127.0.0.1';
    const port = this.boundPort ?? settings.port;
    return [`http://${host}:${port}`];
  }

  /**
   * What a phone would type, computed the same way a LAN bind would be — but regardless of whether LAN
   * mode is on or the listener is up. The user needs the address to decide about the switch, so this
   * cannot wait on the switch. Null means the machine has no private IPv4 to offer at all.
   */
  private lanUrl(settings: RemoteAccessSettings): string | null {
    const address = resolveBindAddress(true);
    if (!address) return null;
    return `http://${address}:${this.boundPort ?? settings.port}`;
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      const pathname = pathOf(request);
      if (!this.originAllowed(request)) {
        return this.send(response, 403, failure('UNAVAILABLE', 'Cross-origin requests are not accepted.'));
      }
      // Only the API is gated. The phone's page and its scripts have to load before the app can read a
      // token out of the URL and send it, so gating the bundle too would make pairing impossible. The
      // bundle is a build artifact with no data in it: everything a phone can *learn* arrives over
      // `/api`, which is behind the token exactly as before.
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        const presented = bearerToken(request.headers.authorization) ?? this.queryToken(request, pathname);
        if (!presented || !(await this.tokens.verify(presented))) {
          return this.send(response, 401, failure('UNAVAILABLE', 'A valid remote token is required.'));
        }
      }
      await this.route(request, response, pathname);
    } catch (error) {
      this.options.logger.error('internal', 'KAI Remote request failed', request.url, error);
      this.send(response, 500, failure('INTERNAL', 'Unexpected gateway error.'));
    }
  }

  /**
   * The token in the query string, accepted for the live stream and nothing else. `EventSource` cannot
   * set an `Authorization` header, so the stream has no other way to authenticate; every other route
   * takes the token in the header, where it cannot end up in a log line.
   */
  private queryToken(request: http.IncomingMessage, pathname: string): string | null {
    if (request.method !== 'GET' || pathname !== '/api/events') return null;
    const token = new URL(request.url ?? '/', 'http://localhost').searchParams.get('token');
    return token?.trim() ? token.trim() : null;
  }

  /**
   * A browser page on another origin could otherwise POST here with a token it should not have. Requests
   * with no origin are the normal case for the phone app and for curl, so only a *wrong* one is refused.
   */
  private originAllowed(request: http.IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (!origin) return true;
    if (this.boundPort === null) return false;
    const allowed = new Set([
      `http://127.0.0.1:${this.boundPort}`,
      `http://localhost:${this.boundPort}`,
    ]);
    if (this.boundAddress) allowed.add(`http://${this.boundAddress}:${this.boundPort}`);
    return allowed.has(origin);
  }

  private async route(request: http.IncomingMessage, response: http.ServerResponse, path: string): Promise<void> {
    if (request.method === 'GET' && path === '/api/status') {
      return this.send(response, 200, { ok: true, data: await this.status() });
    }
    if (request.method === 'GET' && path === '/api/windows') {
      return this.send(response, 200, { ok: true, data: await this.windows() });
    }
    if (request.method === 'GET' && path === '/api/events') {
      return this.stream(request, response);
    }
    if (request.method === 'POST' && path === '/api/ipc') {
      return this.ipc(request, response);
    }
    if (path.startsWith('/api/')) {
      return this.send(response, 404, failure('NOT_FOUND', `No route for ${request.method} ${path}.`));
    }
    if (request.method !== 'GET') {
      return this.send(response, 404, failure('NOT_FOUND', `No route for ${request.method} ${path}.`));
    }
    return this.bundle(request, response, path);
  }

  /**
   * The phone UI, served from the renderer build. Only `/mobile/` and the shared `/assets/` are
   * published, so the desktop workbench's own page — which is in the same build directory and would
   * do nothing useful without the preload bridge — is not handed out as well. The app is a single
   * page, so any extensionless path under it is a deep link into it.
   */
  private async bundle(request: http.IncomingMessage, response: http.ServerResponse, path: string): Promise<void> {
    const root = this.options.mobileRoot;
    if (!root) return this.send(response, 503, failure('UNAVAILABLE', NOT_BUILT));
    if (path === '/' || path === '/mobile') {
      // Kept query-carrying, so a pairing link with ?token= survives the hop.
      const search = (request.url ?? '').includes('?') ? `?${(request.url ?? '').split('?')[1]!}` : '';
      return this.redirect(response, `/mobile/${search}`);
    }
    if (!path.startsWith('/mobile/') && !path.startsWith('/assets/')) {
      return this.send(response, 404, failure('NOT_FOUND', `No route for GET ${path}.`));
    }
    const target = resolveWithin(root, path.replace(/^\/+/, ''));
    if (target && (await isFile(target))) return this.sendFile(response, target, path);
    if (path.startsWith('/mobile/') && !extname(path)) {
      const index = join(root, 'mobile', 'index.html');
      if (await isFile(index)) return this.sendFile(response, index, '/mobile/index.html');
    }
    // A missing asset is a missing asset: answering with HTML would only turn it into a MIME error.
    this.send(response, 404, failure('NOT_FOUND', `No file for ${path}.`));
  }

  private redirect(response: http.ServerResponse, location: string): void {
    if (response.writableEnded) return;
    response.writeHead(302, { location, 'cache-control': 'no-store' });
    response.end();
  }

  private async sendFile(response: http.ServerResponse, target: string, path: string): Promise<void> {
    if (response.writableEnded) return;
    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) {
      return this.send(response, 404, failure('NOT_FOUND', `No file for ${path}.`));
    }
    response.writeHead(200, {
      'content-type': contentTypeFor(target),
      'content-length': info.size,
      // Vite fingerprints everything under assets/, so only those may be cached past the next deploy.
      'cache-control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store',
      'x-content-type-options': 'nosniff',
    });
    const stream = createReadStream(target);
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  }

  private async ipc(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      return this.send(response, 400, failure('INVALID_REQUEST', messageOf(error)));
    }
    const channel = body.channel;
    if (typeof channel !== 'string' || !channel.trim()) {
      return this.send(response, 400, failure('INVALID_REQUEST', 'A channel name is required.'));
    }
    const windowId = typeof body.windowId === 'number' && Number.isInteger(body.windowId) ? body.windowId : null;
    try {
      const data = await this.options.dispatcher.dispatch(channel as IpcChannel, body.input ?? {}, windowId);
      this.send(response, 200, { ok: true, data });
    } catch (error) {
      if (error instanceof RemoteChannelDenied) {
        return this.send(response, 403, failure('UNAVAILABLE', error.message));
      }
      if (error instanceof RemoteWindowUnavailable) {
        return this.send(response, 503, failure('UNAVAILABLE', error.message));
      }
      this.send(response, statusFor(error), failureFor(error));
    }
  }

  /**
   * The live tail, as Server-Sent Events. SSE rather than a WebSocket: plain HTTP with no dependency
   * to add, and the browser's own `Last-Event-ID` on reconnect gives the resume the plan wanted.
   *
   * Every frame carries its window rather than being filtered per connection, so one stream serves
   * the whole app and the client decides what it cares about — that is what lets a Runs screen span
   * several windows at once.
   */
  private stream(request: http.IncomingMessage, response: http.ServerResponse): void {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const sent = url.searchParams.get('since') ?? request.headers['last-event-id'];
    // A fresh connection wants the present, not a replay of whatever the buffer happens to hold: the
    // client reads current state over /api/ipc and takes the tail from here.
    const parsed = parseStreamPosition(sent, this.events.epoch);
    const backlog = parsed === 'stale'
      ? null
      : this.events.since(parsed === 'fresh' ? this.events.latestSeq : parsed);

    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    response.flushHeaders();

    if (backlog === null) {
      this.writeEvent(response, 'resync', {
        epoch: this.events.epoch,
        reason: 'That position is older than the replay buffer.',
      });
    } else {
      for (const frame of backlog) this.writeFrame(response, frame);
    }

    const detach = this.events.attach((frame) => {
      if (response.writableEnded) return;
      // A phone on a slow link must not be able to stall a run. Drop the tail first; if even that is
      // not enough, end the stream so the client reconnects and resumes from where it actually got to.
      if (response.writableLength > STREAM_KILL_BYTES) {
        response.end();
        return;
      }
      if (response.writableLength > STREAM_DROP_BYTES && isDroppableFrame(frame)) return;
      this.writeFrame(response, frame);
    });

    const heartbeat = setInterval(() => {
      if (!response.writableEnded) response.write(': keep-alive\n\n');
    }, STREAM_HEARTBEAT_MS);
    heartbeat.unref?.();

    const cleanup = (): void => {
      clearInterval(heartbeat);
      detach();
    };
    response.on('close', cleanup);
    response.on('error', cleanup);
  }

  private writeFrame(response: http.ServerResponse, frame: RemoteFrame): void {
    this.writeEvent(
      response,
      frame.channel,
      { windowId: frame.windowId, seq: frame.seq, payload: frame.payload },
      `${this.events.epoch}.${frame.seq}`,
    );
  }

  private writeEvent(response: http.ServerResponse, event: string, data: unknown, id?: string): void {
    if (response.writableEnded) return;
    response.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private send(response: http.ServerResponse, status: number, payload: unknown): void {
    if (response.writableEnded) return;
    const text = JSON.stringify(payload);
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(text);
  }
}

/**
 * Loopback unless the user opts into LAN, and then only a private address — never `0.0.0.0`, which
 * would also publish KAI on any VPN or public interface the machine happens to have. Null means LAN
 * was asked for and there is nothing safe to bind.
 */
export function resolveBindAddress(lanEnabled: boolean): string | null {
  if (!lanEnabled) return '127.0.0.1';
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((entry): entry is os.NetworkInterfaceInfo => Boolean(entry))
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address)
    .filter(isPrivateAddress);
  return addresses[0] ?? null;
}

function isPrivateAddress(address: string): boolean {
  const [first, second] = address.split('.').map(Number);
  if (first === undefined || second === undefined) return false;
  if (first === 10) return true;
  if (first === 192 && second === 168) return true;
  return first === 172 && second >= 16 && second <= 31;
}

/**
 * Reads a `<epoch>.<seq>` resume point off the stream. `fresh` means the client is not resuming and
 * should be handed the present; `stale` means it is resuming from a previous run, when the same
 * sequence number meant something else, so it has to be told to resync instead of being given frames.
 */
export function parseStreamPosition(
  value: string | string[] | undefined | null,
  epoch: string,
): number | 'fresh' | 'stale' {
  const raw = (Array.isArray(value) ? value[0] : value)?.trim();
  if (!raw) return 'fresh';
  const separator = raw.lastIndexOf('.');
  if (separator <= 0) return 'stale';
  if (raw.slice(0, separator) !== epoch) return 'stale';
  const seq = raw.slice(separator + 1);
  if (!/^\d+$/.test(seq)) return 'stale';
  return Number(seq);
}

const NOT_BUILT = 'The KAI Remote UI is not built into this copy of the gateway; only its API is available.';

function pathOf(request: http.IncomingMessage): string {
  // The trailing slash is kept: `/mobile/` is the page and `/mobile` is a link to it, so folding the
  // two together would turn the redirect below into a loop.
  return new URL(request.url ?? '/', 'http://localhost').pathname || '/';
}

/** Resolves a request path under `root`, refusing anything that climbs out of it. */
function resolveWithin(root: string, relative: string): string | null {
  const target = resolve(root, relative);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target.startsWith(prefix) ? target : null;
}

async function isFile(target: string): Promise<boolean> {
  return await stat(target).then((info) => info.isFile()).catch(() => false);
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function contentTypeFor(target: string): string {
  return CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream';
}

function failure(code: 'INVALID_REQUEST' | 'NOT_FOUND' | 'CONFLICT' | 'UNAVAILABLE' | 'INTERNAL', message: string) {
  return { ok: false as const, error: { code, message } };
}

function statusFor(error: unknown): number {
  switch (failureFor(error).error.code) {
    case 'INVALID_REQUEST': return 400;
    case 'NOT_FOUND': return 404;
    case 'CONFLICT': return 409;
    case 'UNAVAILABLE': return 503;
    default: return 500;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected gateway error.';
}

function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let stopped = false;
    request.on('data', (chunk: Buffer) => {
      if (stopped) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        stopped = true;
        // The response still has to go out, so the socket is left alone and the rest is simply not read.
        request.pause();
        reject(new Error('Request body is too large.'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        const parsed: unknown = text ? JSON.parse(text) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new Error('Request body must be a JSON object.'));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });
    request.on('error', reject);
  });
}
