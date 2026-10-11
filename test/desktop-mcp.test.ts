import * as http from 'node:http';
import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDefaultSettings, type AppSettings } from '../packages/contracts/src';
import { RedactedLogger } from '../packages/runtime/src';
import { DesktopMcpRuntime } from '../apps/desktop/src/main/mcp-runtime';

const runtimes: DesktopMcpRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

describe('desktop MCP runtime', () => {
  it('connects a stdio server, discovers tools, and injects vault credentials as environment variables', async () => {
    const fixture = path.resolve('test/fixtures/mcp-echo-server.mjs');
    const settings = createDefaultSettings();
    settings.mcpServers = [{
      id: 'test',
      name: 'Test MCP',
      enabled: true,
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
      cwd: null,
      envCredentialIds: { KAI_TEST_MCP_SECRET: 'mcp.test' },
    }];
    const runtime = new DesktopMcpRuntime(settingsPort(settings), credentialPort('mcp.test', 'vault-secret'), new RedactedLogger());
    runtimes.push(runtime);

    const definitions = await runtime.definitions();
    const echoDefinition = definitions.find((definition) =>
      definition && typeof definition === 'object' && 'name' in definition && String(definition.name).includes('echo'));
    const secretDefinition = definitions.find((definition) =>
      definition && typeof definition === 'object' && 'name' in definition && String(definition.name).includes('show_secret'));
    expect(echoDefinition).toMatchObject({ type: 'function', description: expect.stringContaining('Test MCP') });
    expect(secretDefinition).toMatchObject({ type: 'function' });

    const secretName = String((secretDefinition as { name: string }).name);
    expect(runtime.policy(secretName, 'plan')).toMatchObject({ decision: 'deny' });
    expect(runtime.policy(secretName, 'ask')).toMatchObject({ decision: 'ask' });
    await expect(runtime.execute(secretName, {})).resolves.toMatchObject({
      ok: true,
      output: { text: 'secret:vault-secret' },
    });
  });

  it('allows a read-only MCP tool without approval in plan mode', async () => {
    const fixture = path.resolve('test/fixtures/mcp-echo-server.mjs');
    const settings = createDefaultSettings();
    settings.mcpServers = [{
      id: 'test',
      name: 'Test MCP',
      enabled: true,
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
      cwd: null,
      envCredentialIds: {},
    }];
    const runtime = new DesktopMcpRuntime(settingsPort(settings), credentialPort(), new RedactedLogger());
    runtimes.push(runtime);

    const [echo] = await runtime.definitions();
    const name = String((echo as { name: string }).name);
    expect(runtime.policy(name, 'plan')).toEqual({ decision: 'allow' });
    await expect(runtime.execute(name, { text: 'hello' })).resolves.toMatchObject({
      ok: true,
      output: { text: 'echo:hello' },
    });
  });

  it('connects a remote Streamable HTTP server with vault-backed headers', async () => {
    const server = await startHttpMcpServer('Bearer vault-token');
    try {
      const settings = createDefaultSettings();
      settings.mcpServers = [{
        id: 'remote',
        name: 'Remote MCP',
        enabled: true,
        transport: 'http',
        url: server.url,
        headerCredentialIds: { Authorization: 'mcp.remote' },
      }];
      const runtime = new DesktopMcpRuntime(settingsPort(settings), credentialPort('mcp.remote', 'Bearer vault-token'), new RedactedLogger());
      runtimes.push(runtime);

      const [echo] = await runtime.definitions();
      expect(echo).toMatchObject({ type: 'function', description: expect.stringContaining('Remote MCP') });
      const name = String((echo as { name: string }).name);
      expect(runtime.policy(name, 'plan')).toEqual({ decision: 'allow' });
      await expect(runtime.execute(name, { text: 'hello remotely' })).resolves.toMatchObject({
        ok: true,
        output: { text: 'echo:hello remotely' },
      });
    } finally {
      await server.close();
    }
  });

  it('scopes to one server: offers only its tools, and allows them outright regardless of autonomy', async () => {
    // Two servers sharing the same fixture, standing in for open-pencil plus some other MCP server the user has
    // also enabled — scopedToServer must offer only the one it names, not both.
    const fixture = path.resolve('test/fixtures/mcp-echo-server.mjs');
    const settings = createDefaultSettings();
    settings.mcpServers = [
      { id: 'open-pencil', name: 'Open Pencil', enabled: true, transport: 'stdio', command: process.execPath, args: [fixture], cwd: null, envCredentialIds: { KAI_TEST_MCP_SECRET: 'mcp.test' } },
      { id: 'other', name: 'Other MCP', enabled: true, transport: 'stdio', command: process.execPath, args: [fixture], cwd: null, envCredentialIds: { KAI_TEST_MCP_SECRET: 'mcp.test' } },
    ];
    const runtime = new DesktopMcpRuntime(settingsPort(settings), credentialPort('mcp.test', 'vault-secret'), new RedactedLogger());
    runtimes.push(runtime);
    const scoped = runtime.scopedToServer('open-pencil');

    const scopedDefinitions = await scoped.definitions();
    const allDefinitions = await runtime.definitions();
    expect(scopedDefinitions.length).toBeGreaterThan(0);
    expect(scopedDefinitions.length).toBeLessThan(allDefinitions.length);

    const secretName = String((scopedDefinitions.find((definition) =>
      definition && typeof definition === 'object' && 'name' in definition && String(definition.name).includes('show_secret')) as { name: string }).name);
    // The raw runtime denies a non-read-only MCP tool under 'plan'; the scoped view allows it regardless.
    expect(runtime.policy(secretName, 'plan')).toMatchObject({ decision: 'deny' });
    expect(scoped.policy?.(secretName, 'plan')).toEqual({ decision: 'allow' });
    await expect(scoped.execute?.(secretName, {})).resolves.toMatchObject({ ok: true, output: { text: 'secret:vault-secret' } });

    // A tool belonging to the other server is simply not this view's to answer for.
    const otherOnlyName = allDefinitions
      .map((definition) => (definition && typeof definition === 'object' && 'name' in definition ? String(definition.name) : ''))
      .find((name) => !scopedDefinitions.some((scopedDefinition) => scopedDefinition && typeof scopedDefinition === 'object' && 'name' in scopedDefinition && scopedDefinition.name === name));
    expect(scoped.policy?.(otherOnlyName!, 'full')).toBeUndefined();
  });

  it('reconnects and retries once when a call fails against an already-connected server, instead of leaving a dead connection in place', async () => {
    // Stands in for the server having restarted under an already-open connection (open-pencil reissuing its token,
    // or dropping it when auth is turned off): the first call throws against the now-dead client, and the retry
    // connects again — by which point the vault holds whatever the server now actually wants — the same recovery a
    // person would do by hand, done automatically.
    const server = await startHttpMcpServer('Bearer vault-token');
    try {
      const settings = createDefaultSettings();
      settings.mcpServers = [{
        id: 'remote',
        name: 'Remote MCP',
        enabled: true,
        transport: 'http',
        url: server.url,
        headerCredentialIds: { Authorization: 'mcp.remote' },
      }];
      const runtime = new DesktopMcpRuntime(settingsPort(settings), credentialPort('mcp.remote', 'Bearer vault-token'), new RedactedLogger());
      runtimes.push(runtime);
      const [echo] = await runtime.definitions();
      const name = String((echo as { name: string }).name);
      // A real connection exists now. Kill the transport underneath it without telling the runtime, the way a
      // restarted server would: the next call on it throws, which is exactly what callWithReconnect is for.
      const connection = (runtime as unknown as { connection?: { clients: Map<string, { close(): Promise<void> }> } }).connection;
      await connection?.clients.get('remote')?.close();

      await expect(runtime.execute(name, { text: 'hello again' })).resolves.toMatchObject({
        ok: true,
        output: { text: 'echo:hello again' },
      });
    } finally {
      await server.close();
    }
  });
});

describe('desktop MCP runtime reconnects per server', () => {
  const stdio = (id: string, secret: string): AppSettings['mcpServers'][number] => ({
    id, name: id, enabled: true, transport: 'stdio', command: process.execPath, args: [path.resolve('test/fixtures/mcp-echo-server.mjs')], cwd: null,
    envCredentialIds: { KAI_TEST_MCP_SECRET: secret },
  });
  const clientsOf = (runtime: DesktopMcpRuntime): Map<string, unknown> => (runtime as unknown as { connection: { clients: Map<string, unknown> } }).connection.clients;

  it('keeps the other servers connected when one server changes or is invalidated', async () => {
    const settings = createDefaultSettings();
    settings.mcpServers = [stdio('a', 'mcp.a'), stdio('b', 'mcp.b')];
    const runtime = new DesktopMcpRuntime({ load: async () => structuredClone(settings) }, { get: async () => 'secret' }, new RedactedLogger());
    runtimes.push(runtime);
    await runtime.definitions();
    const [a1, b1] = [clientsOf(runtime).get('a'), clientsOf(runtime).get('b')];

    settings.mcpServers = [stdio('a', 'mcp.a2'), stdio('b', 'mcp.b')];
    await runtime.definitions();
    expect(clientsOf(runtime).get('a')).not.toBe(a1);
    expect(clientsOf(runtime).get('b')).toBe(b1);

    const [a2, b2] = [clientsOf(runtime).get('a'), clientsOf(runtime).get('b')];
    runtime.invalidate('a');
    await runtime.definitions();
    expect(clientsOf(runtime).get('a')).not.toBe(a2);
    expect(clientsOf(runtime).get('b')).toBe(b2);
  });
});

function settingsPort(settings: AppSettings): { load(): Promise<AppSettings> } {
  return { load: async () => structuredClone(settings) };
}

function credentialPort(id?: string, value?: string): { get(requestedId: string): Promise<string | undefined> } {
  return { get: async (requestedId) => requestedId === id ? value : undefined };
}

async function startHttpMcpServer(authorization: string): Promise<{ url: string; close(): Promise<void> }> {
  const httpServer = http.createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' });
      response.end();
      return;
    }
    if (request.headers.authorization !== authorization) {
      response.writeHead(401);
      response.end();
      return;
    }
    try {
      const server = createHttpMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      await transport.handleRequest(request, response, await readJsonBody(request));
      response.once('close', () => {
        void transport.close();
        void server.close();
      });
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: String(error) }, id: null }));
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('HTTP MCP test server did not bind a TCP port.');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve())),
  };
}

function createHttpMcpServer(): McpServer {
  const server = new McpServer({ name: 'kai-http-test-mcp', version: '1.0.0' });
  server.registerTool(
    'echo',
    {
      description: 'Echo text for remote tests.',
      inputSchema: { text: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ text }) => ({ content: [{ type: 'text', text: `echo:${text}` }] }),
  );
  return server;
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}
