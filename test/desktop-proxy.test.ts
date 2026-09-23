import * as http from 'node:http';
import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { UniversalProxyClient } from '../apps/desktop/src/main/proxy-client';
import { AuthenticatedLoopbackGateway } from '../packages/integrations/src';

const servers: http.Server[] = [];
const gateways: AuthenticatedLoopbackGateway[] = [];

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.stop()));
  await Promise.all(servers.splice(0).map(closeServer));
});

describe('desktop Universal Agent Proxy client', () => {
  it('normalizes metrics, filters history, inspects details, and keeps the gateway token private', async () => {
    const token = 'proxy-client-test-token';
    const observedAuthorization: Array<string | undefined> = [];
    const requestedUrls: string[] = [];
    const upstream = http.createServer((request, response) => {
      observedAuthorization.push(request.headers.authorization);
      requestedUrls.push(request.url ?? '/');

      if (request.method === 'GET' && request.url === '/v1/provider-health') {
        return json(response, {
          status: 'ok',
          target: 'https://api.example.test/v1',
          providers: {
            'api.example.test': {
              provider: 'api.example.test',
              state: 'closed',
              reachable: true,
              successRate: 0.75,
              p50: 120,
              p95: 480,
              p99: 620,
              count: 4,
              errorCount: 1,
              errorCount24h: 1,
              errorsByStatus: { '502': 1 },
              lastCheck: 1_776_000_000_000,
            },
          },
        });
      }
      if (request.method === 'GET' && request.url === '/v1/metrics') {
        return json(response, {
          byProvider: {
            'api.example.test': { p50: 120, p95: 480, p99: 620, count: 4 },
          },
        });
      }
      if (request.method === 'GET' && request.url === '/v1/costs') {
        return json(response, {
          totalCost: 0.0142,
          byModel: {
            'smoke-model': { input_tokens: 1000, output_tokens: 200, calls: 4, cost: 0.0142 },
          },
        });
      }
      if (request.method === 'GET' && request.url === '/v1/cache-stats') {
        return json(response, {
          cacheReadTokens: 250,
          totalInputTokens: 1000,
          hitRate: 25,
          calls: 4,
        });
      }
      if (request.method === 'GET' && request.url?.startsWith('/v1/history?')) {
        return json(response, [
          {
            id: 'request-1',
            ts: '2026-09-23T10:00:00.000Z',
            agent: 'smoke',
            model: 'smoke-model',
            provider: 'api.example.test',
            input: 1000,
            output: 200,
            latencyMs: 480,
            statusCode: 502,
            requestModel: 'smoke-model',
            promptSnippet: '',
          },
        ]);
      }
      if (request.method === 'GET' && request.url === '/v1/history/request-1') {
        return json(response, {
          id: 'request-1',
          agentId: 'smoke',
          timestamp: 1_776_000_000_000,
          route: 'proxy',
          upstreamProvider: 'api.example.test',
          upstreamModel: 'smoke-model',
          credentialFingerprint: '',
          requestMethod: 'POST',
          requestPath: '/v1/messages',
          requestModel: 'smoke-model',
          translatedModel: 'smoke-model',
          promptSnippet: '',
          requestHeaders: { 'content-type': 'application/json' },
          translatedRequest: '{"model":"smoke-model"}',
          responseSummary: { contentType: 'application/json', bytes: 42 },
          statusCode: 502,
          errorStage: 'upstream',
          errorMessage: 'Upstream refused the connection.',
          latency: {
            clientToProxyMs: 4,
            queueMs: 4,
            upstreamFirstByteMs: 476,
            streamMs: 0,
            totalMs: 480,
          },
          tokens: { input: 1000, output: 200, cacheRead: 250, cacheWrite: 0 },
          costUsd: 0.0142,
          retryAttempt: 0,
          fallbackUsed: false,
          fallbackTransitions: [],
          isVerification: false,
          replayId: 'ephemeral-replay-handle',
        });
      }
      if (request.method === 'POST' && request.url === '/v1/history/clear') {
        return json(response, { cleared: 1 });
      }

      json(response, { error: { message: 'Not found' } }, 404);
    });
    await listen(upstream, 0);
    servers.push(upstream);

    const publicPort = await availablePort();
    const gateway = new AuthenticatedLoopbackGateway({
      listenEndpoint: `http://127.0.0.1:${publicPort}`,
      upstreamEndpoint: `http://127.0.0.1:${addressOf(upstream).port}`,
      token,
    });
    gateways.push(gateway);
    await gateway.start();

    const client = new UniversalProxyClient({
      access: {
        loopbackAccess: async () => ({ endpoint: `http://127.0.0.1:${publicPort}`, token }),
      },
    });

    await expect(client.overview()).resolves.toMatchObject({
      target: 'https://api.example.test/v1',
      totalCostUsd: 0.0142,
      trackedCalls: 4,
      cacheHitRate: 25,
      providers: [{ provider: 'api.example.test', state: 'closed', p95: 480, errorCount24h: 1 }],
      latency: [{ provider: 'api.example.test', p95: 480 }],
      models: [{ model: 'smoke-model', calls: 4, costUsd: 0.0142 }],
    });

    await expect(client.history({ search: ' smoke ', agent: 'claude', status: '5xx', page: 2, limit: 10 })).resolves.toEqual([
      {
        id: 'request-1',
        ts: '2026-09-23T10:00:00.000Z',
        agent: 'smoke',
        model: 'smoke-model',
        provider: 'api.example.test',
        input: 1000,
        output: 200,
        latencyMs: 480,
        statusCode: 502,
        requestModel: 'smoke-model',
        promptSnippet: '',
      },
    ]);
    const historyRequest = requestedUrls.find((url) => url.startsWith('/v1/history?'));
    expect(historyRequest).toContain('search=smoke');
    expect(historyRequest).toContain('agent=claude');
    expect(historyRequest).toContain('status=5xx');
    expect(historyRequest).toContain('page=2');
    expect(historyRequest).toContain('limit=10');

    await expect(client.historyDetail('request-1')).resolves.toMatchObject({
      id: 'request-1',
      agent: 'smoke',
      route: 'proxy',
      provider: 'api.example.test',
      model: 'smoke-model',
      statusCode: 502,
      errorStage: 'upstream',
      errorMessage: 'Upstream refused the connection.',
      latency: { totalMs: 480 },
      tokens: { input: 1000, output: 200 },
      responseContentType: 'application/json',
      responseBytes: 42,
    });
    const detail = await client.historyDetail('request-1');
    expect(detail).not.toHaveProperty('requestHeaders');
    expect(detail).not.toHaveProperty('translatedRequest');
    expect(JSON.stringify(detail)).not.toContain('ephemeral-replay-handle');

    await expect(client.clearHistory()).resolves.toEqual({ cleared: 1 });
    expect(observedAuthorization).not.toContain(`Bearer ${token}`);
  });
});

function json(response: http.ServerResponse, payload: unknown, status = 200): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload));
}

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await listen(server, 0);
  const port = addressOf(server).port;
  await closeServer(server);
  return port;
}

function addressOf(server: http.Server | net.Server): { port: number } {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address.');
  return { port: address.port };
}

function listen(server: http.Server | net.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

function closeServer(server: http.Server | net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
