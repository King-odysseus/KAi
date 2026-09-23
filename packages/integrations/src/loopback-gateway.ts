import * as http from 'node:http';
import * as net from 'node:net';

export interface LoopbackGatewayOptions {
  listenEndpoint: string;
  upstreamEndpoint: string;
  token: string;
}

/** A loopback-only authenticating reverse proxy in front of a managed engine. */
export class AuthenticatedLoopbackGateway {
  private server: http.Server | null = null;

  constructor(private readonly options: LoopbackGatewayOptions) {
    assertLoopbackEndpoint(options.listenEndpoint, 'listen');
    assertLoopbackEndpoint(options.upstreamEndpoint, 'upstream');
    if (!options.token.trim()) throw new Error('Loopback access token cannot be empty.');
  }

  async start(): Promise<void> {
    if (this.server) return;

    const server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
    this.server = server;

    const listen = new URL(this.options.listenEndpoint);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(portOf(listen), listen.hostname);
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      server.close(finish);
      server.closeAllConnections?.();
      setTimeout(() => {
        server.closeAllConnections?.();
        finish();
      }, 1_000).unref();
    });
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (!isLoopbackHost(request.headers.host)) {
      writeJson(response, 421, { error: 'Host header rejected; loopback only.' });
      return;
    }

    const authorization = request.headers.authorization ?? '';
    const headerToken = singleHeader(request.headers['x-kai-loopback-token']);
    const bearerToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const authenticated = headerToken === this.options.token || bearerToken === this.options.token;
    if (!authenticated) {
      response.setHeader('WWW-Authenticate', 'Bearer realm="KAI loopback"');
      writeJson(response, 401, { error: 'Unauthorized' });
      return;
    }

    const upstream = new URL(this.options.upstreamEndpoint);
    const headers = normalizedForwardHeaders(request.headers);
    if (bearerToken === this.options.token) delete headers.authorization;
    if (singleHeader(request.headers['x-api-key']) === this.options.token) delete headers['x-api-key'];
    delete headers['x-kai-loopback-token'];
    headers.host = upstream.host;

    const forwarded = http.request({
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: portOf(upstream),
      method: request.method,
      path: request.url || '/',
      headers,
    });

    const abortUpstream = () => forwarded.destroy();
    request.once('aborted', abortUpstream);
    response.once('close', () => {
      if (!response.writableEnded) forwarded.destroy();
    });

    forwarded.once('response', (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage,
        normalizedResponseHeaders(upstreamResponse.headers),
      );
      upstreamResponse.pipe(response);
    });
    forwarded.once('error', (error) => {
      if (!response.headersSent) writeJson(response, 502, { error: `Engine request failed: ${error.message}` });
      else response.destroy(error);
    });

    request.pipe(forwarded);
  }
}

function normalizedForwardHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const result: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!value || hopByHopHeaders.has(name.toLowerCase())) continue;
    result[name] = value;
  }
  return result;
}

function normalizedResponseHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const result: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!value || hopByHopHeaders.has(name.toLowerCase())) continue;
    result[name] = value;
  }
  return result;
}

const hopByHopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function assertLoopbackEndpoint(endpoint: string, label: string): void {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:') throw new Error(`The ${label} endpoint must use HTTP.`);
  if (!isLoopbackHostname(url.hostname)) throw new Error(`The ${label} endpoint must be loopback-only.`);
  if (!url.port) throw new Error(`The ${label} endpoint must include an explicit port.`);
}

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  try {
    return isLoopbackHostname(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname.toLowerCase() === 'localhost';
}

function portOf(url: URL): number {
  return Number(url.port);
}

function singleHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function writeJson(response: http.ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload));
}

export async function findAvailableLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error('Could not reserve a loopback port for the engine.');
  return port;
}
