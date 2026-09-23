import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AuthenticatedLoopbackGateway,
  EngineLocator,
  ServiceManager,
  universalProxyManifest,
  type ServiceLaunchSpec,
} from '../packages/integrations/src';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-integrations-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('desktop engine integrations', () => {
  it('locates a pinned engine from an explicit development root', async () => {
    const root = await temporaryDirectory();
    await fs.mkdir(path.join(root, 'out'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: universalProxyManifest.packageName, version: universalProxyManifest.expectedVersion }),
      'utf8',
    );
    await fs.writeFile(path.join(root, 'out', 'proxy.js'), 'module.exports = {};', 'utf8');

    const locator = new EngineLocator({
      kaiRoot: path.join(root, 'kai'),
      resourcesPath: path.join(root, 'resources'),
      environment: { KAI_UAP_ENGINE_ROOT: root },
    });

    await expect(locator.locate(universalProxyManifest)).resolves.toMatchObject({
      root,
      version: universalProxyManifest.expectedVersion,
      source: 'environment',
    });
  });

  it('starts and stops a managed child process only after its health check passes', async () => {
    const root = await temporaryDirectory();
    const script = path.join(root, 'service.cjs');
    const port = await availablePort();
    await fs.writeFile(script, serviceScript(), 'utf8');
    const manager = new ServiceManager();

    const spec = serviceSpec({
      root,
      port,
      executable: process.execPath,
      args: [script],
    });
    spec.env.TEST_SERVICE_PORT = String(port);
    const state = await manager.start(spec);
    expect(state.status).toBe('ready');
    expect(state.version).toBe('test-version');

    const stopped = await manager.stop('universalProxy');
    expect(stopped.status).toBe('stopped');
  });

  it('streams proxy credentials to the launcher over stdin rather than args or environment', async () => {
    const root = await temporaryDirectory();
    const engineRoot = path.join(root, 'engine');
    const outputFile = path.join(root, 'received.json');
    const port = await availablePort();
    await fs.mkdir(path.join(engineRoot, 'out'), { recursive: true });
    await fs.writeFile(path.join(engineRoot, 'out', 'proxy.js'), proxyEngineScript(), 'utf8');

    const payload = {
      config: {
        port,
        targetBaseUrl: 'https://example.invalid/v1',
        apiKey: 'test-secret-value',
        apiKeys: {},
        defaultModel: 'test-model',
        modelMap: {},
        customHeaders: {},
        fallbackProviders: [],
        kimiConfig: { enabled: false, baseUrl: '', apiKey: '', defaultModel: '' },
        qwenConfig: { enabled: false, baseUrl: '', apiKey: '', defaultModel: '' },
        codexConfig: { enabled: false, baseUrl: '', apiKey: '', defaultModel: '' },
      },
      runtime: {},
    };
    const launcherPath = path.resolve(process.cwd(), 'packages', 'integrations', 'launchers', 'start-proxy.cjs');
    const manager = new ServiceManager();
    const spec = serviceSpec({
      root: engineRoot,
      port,
      executable: process.execPath,
      args: [launcherPath],
    });
    spec.env = {
      ...spec.env,
      KAI_UAP_ENGINE_ROOT: engineRoot,
      KAI_TEST_PROXY_OUTPUT: outputFile,
    };
    spec.stdin = `${JSON.stringify(payload)}\n`;

    expect(spec.args.join(' ')).not.toContain('test-secret-value');
    expect(JSON.stringify(spec.env)).not.toContain('test-secret-value');

    const state = await manager.start(spec);
    expect(state.status).toBe('ready');
    const received = JSON.parse(await fs.readFile(outputFile, 'utf8')) as { apiKey: string };
    expect(received.apiKey).toBe('test-secret-value');
    await manager.stop('universalProxy');
  });

  it('requires an access token and does not leak it to the managed engine', async () => {
    const upstreamPort = await availablePort();
    const publicPort = await availablePort();
    const token = 'test-loopback-access-token';
    const observed: Array<{ authorization?: string; tokenHeader?: string; connection?: string }> = [];
    let upstreamConnections = 0;
    const upstream = http.createServer((request, response) => {
      observed.push({
        authorization: request.headers.authorization,
        tokenHeader: request.headers['x-kai-loopback-token'] as string | undefined,
        connection: request.headers.connection,
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok' }));
    });
    upstream.on('connection', () => {
      upstreamConnections += 1;
    });
    await listen(upstream, upstreamPort);

    const gateway = new AuthenticatedLoopbackGateway({
      listenEndpoint: `http://127.0.0.1:${publicPort}`,
      upstreamEndpoint: `http://127.0.0.1:${upstreamPort}`,
      token,
    });
    try {
      await gateway.start();
      const unauthorized = await fetch(`http://127.0.0.1:${publicPort}/health`);
      expect(unauthorized.status).toBe(401);
      expect(observed).toHaveLength(0);

      const authorized = await fetch(`http://127.0.0.1:${publicPort}/health`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(authorized.status).toBe(200);
      await expect(authorized.json()).resolves.toEqual({ status: 'ok' });
      expect(observed).toEqual([{ authorization: undefined, tokenHeader: undefined, connection: 'close' }]);

      const forwardedCredential = await fetch(`http://127.0.0.1:${publicPort}/health`, {
        headers: {
          'x-kai-loopback-token': token,
          Authorization: 'Bearer upstream-credential',
        },
      });
      expect(forwardedCredential.status).toBe(200);
      expect(observed[1]).toEqual({
        authorization: 'Bearer upstream-credential',
        tokenHeader: undefined,
        connection: 'close',
      });
      expect(upstreamConnections).toBe(2);
    } finally {
      await gateway.stop();
      await closeServer(upstream);
    }
  });
});

function serviceSpec(options: { root: string; port: number; executable: string; args: string[] }): ServiceLaunchSpec {
  return {
    kind: 'universalProxy',
    label: 'Test service',
    version: 'test-version',
    commit: 'test-commit',
    endpoint: `http://127.0.0.1:${options.port}`,
    healthPath: '/health',
    executable: options.executable,
    args: options.args,
    cwd: options.root,
    env: { ...process.env },
    startupTimeoutMs: 10_000,
    stopTimeoutMs: 5_000,
  };
}

function serviceScript(): string {
  return `
    const http = require('node:http');
    const port = Number(process.env.TEST_SERVICE_PORT);
    const server = http.createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      response.writeHead(404); response.end();
    });
    server.listen(port, '127.0.0.1');
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  `;
}

function proxyEngineScript(): string {
  return `
    const fs = require('node:fs');
    const http = require('node:http');
    class ProxyServer {
      async start(config) {
        fs.writeFileSync(process.env.KAI_TEST_PROXY_OUTPUT, JSON.stringify(config));
        this.server = http.createServer((request, response) => {
          if (request.url === '/health') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ status: 'ok' }));
            return;
          }
          response.writeHead(404); response.end();
        });
        await new Promise((resolve, reject) => {
          this.server.once('error', reject);
          this.server.listen(config.port, '127.0.0.1', resolve);
        });
      }
      async stop() {
        await new Promise((resolve) => this.server.close(() => resolve()));
      }
    }
    module.exports = { ProxyServer };
  `;
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
