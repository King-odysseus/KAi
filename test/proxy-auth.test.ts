import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'http';
import { KaiProxyServer } from '../src/proxy/proxy-server';
import type { ProxyServerConfig } from '../src/proxy/proxy-server';

/**
 * The proxy holds the user's real upstream API key, and it listens on
 * localhost — so anything running on the machine, or any web page whose
 * fetch() reaches 127.0.0.1, could otherwise ride it. These tests cover the
 * two locks that close that hole: a per-session token on /v1/messages, and
 * an unconditional rejection of browser-context requests (Origin header).
 *
 * Both locks must also be proven not to fire on the legitimate path, and to
 * stay off entirely when no token is configured (the pre-Phase-6 default).
 */

const TOKEN = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const ANTHROPIC_REQUEST = {
  model: 'claude-sonnet-4-5',
  max_tokens: 64,
  messages: [{ role: 'user', content: 'hello' }],
};

interface FakeUpstream {
  url: string;
  /** Every request the proxy actually forwarded upstream. */
  hits: Array<{ path: string; authorization?: string }>;
  close: () => Promise<void>;
}

/** A stand-in for the real provider, answering /chat/completions with a 200
 *  SSE stream. Its request log is how the tests prove an unauthorized call
 *  never reached the upstream key at all. */
async function startFakeUpstream(): Promise<FakeUpstream> {
  const hits: FakeUpstream['hits'] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      hits.push({ path: req.url ?? '', authorization: req.headers.authorization });

      if (req.url !== '/chat/completions') {
        res.writeHead(404);
        res.end('{}');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({
        id: 'chatcmpl-test',
        choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
      }) + '\n\n');
      res.write('data: ' + JSON.stringify({
        id: 'chatcmpl-test',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;

  return {
    url: 'http://127.0.0.1:' + port,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function post(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: data,
        contentType: String(res.headers['content-type'] ?? ''),
      }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function get(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<number>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

// ---- lifecycle ----

const running: Array<() => Promise<void>> = [];

function track(close: () => Promise<void>): void {
  running.push(close);
}

afterEach(async () => {
  while (running.length > 0) {
    await running.pop()?.();
  }
});

async function startProxy(
  overrides: Partial<ProxyServerConfig> = {},
): Promise<{ server: KaiProxyServer; port: number; upstream: FakeUpstream }> {
  const upstream = await startFakeUpstream();
  track(upstream.close);

  const server = new KaiProxyServer({
    port: 0,
    targetBaseUrl: upstream.url,
    apiKey: 'sk-real-upstream-key',
    defaultModel: 'test-model',
    modelMap: {},
    ...overrides,
  });
  await server.start();
  track(() => server.stop());

  return { server, port: server.getPort(), upstream };
}

// ---- Origin lock ----

describe('proxy Origin lock', () => {
  it('rejects a browser-context request with 403 even when the token matches', async () => {
    const { port, upstream } = await startProxy({ authToken: TOKEN });

    const result = await post(port, '/v1/messages', ANTHROPIC_REQUEST, {
      Authorization: 'Bearer ' + TOKEN,
      Origin: 'https://evil.example.com',
    });

    expect(result.status).toBe(403);
    expect(result.body).toContain('forbidden_origin');
    // The whole point: the upstream key was never used.
    expect(upstream.hits).toEqual([]);
  });

  it('rejects a browser-context request when no token is configured', async () => {
    const { port, upstream } = await startProxy();

    const result = await post(port, '/chat/completions', { model: 'x', messages: [] }, {
      Origin: 'http://localhost:3000',
    });

    expect(result.status).toBe(403);
    expect(upstream.hits).toEqual([]);
  });

  it('rejects a browser-context request to the health endpoint', async () => {
    const { port } = await startProxy({ authToken: TOKEN });

    expect(await get(port, '/health', { Origin: 'https://evil.example.com' })).toBe(403);
  });
});

// ---- Auth token on /v1/messages ----

describe('proxy /v1/messages auth', () => {
  it('rejects a request with no Authorization header', async () => {
    const { port, upstream } = await startProxy({ authToken: TOKEN });

    const result = await post(port, '/v1/messages', ANTHROPIC_REQUEST);

    expect(result.status).toBe(401);
    expect(result.body).toContain('unauthorized');
    expect(upstream.hits).toEqual([]);
  });

  it('rejects a mismatched token', async () => {
    const { port, upstream } = await startProxy({ authToken: TOKEN });

    const result = await post(port, '/v1/messages', ANTHROPIC_REQUEST, {
      Authorization: 'Bearer sk-ant-proxy-placeholder-000000000000000000000000000000',
    });

    expect(result.status).toBe(401);
    expect(upstream.hits).toEqual([]);
  });

  it('rejects a bare token without the Bearer prefix', async () => {
    const { port, upstream } = await startProxy({ authToken: TOKEN });

    const result = await post(port, '/v1/messages', ANTHROPIC_REQUEST, {
      Authorization: TOKEN,
    });

    expect(result.status).toBe(401);
    expect(upstream.hits).toEqual([]);
  });

  it('accepts the matching token and forwards to the upstream with the real key', async () => {
    const { port, upstream } = await startProxy({ authToken: TOKEN });

    const result = await post(port, '/v1/messages', ANTHROPIC_REQUEST, {
      Authorization: 'Bearer ' + TOKEN,
    });

    expect(result.status).toBe(200);
    expect(result.contentType).toContain('text/event-stream');
    expect(upstream.hits).toHaveLength(1);
    expect(upstream.hits[0].path).toBe('/chat/completions');
    // The caller's token is the session token, never the upstream credential.
    expect(upstream.hits[0].authorization).toBe('Bearer sk-real-upstream-key');
  });

  it('leaves /v1/messages unauthenticated when no token is configured', async () => {
    const { port, upstream } = await startProxy();

    const result = await post(port, '/v1/messages', ANTHROPIC_REQUEST);

    expect(result.status).toBe(200);
    expect(upstream.hits).toHaveLength(1);
  });

  it('does not gate the health endpoint', async () => {
    const { port } = await startProxy({ authToken: TOKEN });

    expect(await get(port, '/health')).toBe(200);
  });
});
