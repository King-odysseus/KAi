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
