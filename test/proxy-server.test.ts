import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'http';
import { KaiProxyServer, type ProxyServerConfig } from '../src/proxy/proxy-server';

const running: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (running.length > 0) {
    await running.pop()?.();
  }
});

function config(port: number): ProxyServerConfig {
  return {
    port,
    targetBaseUrl: 'http://127.0.0.1:9',
    apiKey: 'test-key',
    defaultModel: 'test-model',
    modelMap: {},
  };
}

async function startForeignServer(): Promise<number> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/health') {
      res.end(JSON.stringify({ status: 'ok', target: 'https://example.com' }));
      return;
    }
    if (req.url === '/v1/models') {
      res.end(
        JSON.stringify({
          data: [{ id: 'foreign-model', object: 'model', owned_by: 'proxy' }],
        }),
      );
      return;
    }
    res.end('{}');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  running.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  );
  const address = server.address();
  return address && typeof address === 'object' ? address.port : 0;
}

describe('KaiProxyServer startup', () => {
  it('reuses an existing KAI proxy instead of failing on its port', async () => {
    const owner = new KaiProxyServer(config(0));
    await owner.start();
    running.push(() => owner.stop());

    const shared = new KaiProxyServer(config(owner.getPort()));
    await shared.start();
    running.push(() => shared.stop());

    expect(shared.isRunning()).toBe(true);
    expect(shared.isReused()).toBe(true);
    expect(shared.getPort()).toBe(owner.getPort());
  });

  it('falls back to another port when the configured port belongs to another service', async () => {
    const foreignPort = await startForeignServer();
    const server = new KaiProxyServer(config(foreignPort));
    await server.start();
    running.push(() => server.stop());

    expect(server.isRunning()).toBe(true);
    expect(server.isReused()).toBe(false);
    expect(server.getPort()).not.toBe(foreignPort);
  });
});
