import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { AppSettings, AutonomyMode, McpServerSettings } from '@kai/contracts';
import type { RedactedLogger } from '@kai/runtime';
import type { ExternalToolPort, ProjectToolExecution, ProjectToolPolicy } from './project-tools';

const MAX_MCP_OUTPUT = 100_000;

interface McpSettingsPort {
  load(): Promise<AppSettings>;
}

interface McpCredentialPort {
  get(id: string): Promise<string | undefined>;
}

interface McpToolDescriptor {
  providerName: string;
  serverId: string;
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: unknown;
  readOnly: boolean;
}

interface McpConnection {
  fingerprint: string;
  clients: Map<string, Client>;
  tools: Map<string, McpToolDescriptor>;
}

export class DesktopMcpRuntime implements ExternalToolPort {
  private connection: McpConnection | undefined;
  private connecting: Promise<McpConnection> | undefined;

  constructor(
    private readonly settings: McpSettingsPort,
    private readonly credentials: McpCredentialPort,
    private readonly logger: RedactedLogger,
  ) {}

  invalidate(): void {
    const previous = this.connection;
    this.connection = undefined;
    if (previous) void Promise.allSettled([...previous.clients.values()].map((client) => client.close()));
  }

  async definitions(): Promise<readonly unknown[]> {
    const connection = await this.ensureConnected();
    return [...connection.tools.values()].map((tool) => ({
      type: 'function',
      name: tool.providerName,
      description: `MCP server ${tool.serverName}: ${tool.description}`,
      parameters: mcpInputSchema(tool.inputSchema),
    }));
  }

  policy(name: string, autonomy: AutonomyMode): ProjectToolPolicy | undefined {
    const tool = this.connection?.tools.get(name);
    if (!tool) return undefined;
    if (autonomy === 'full') return { decision: 'allow' };
    if (tool.readOnly && (autonomy === 'plan' || autonomy === 'ask' || autonomy === 'autoEdit' || autonomy === 'custom')) {
      return { decision: 'allow' };
    }
    if (autonomy === 'plan') {
      return { decision: 'deny', reason: 'Plan mode only allows MCP tools that declare read-only behavior.' };
    }
    return {
      decision: 'ask',
      title: `Allow MCP tool ${tool.serverName}/${tool.toolName}?`,
      detail: 'This MCP tool can have effects outside the built-in project boundary. Review its arguments before allowing it.',
      risk: tool.readOnly ? 'low' : 'medium',
    };
  }

  async execute(name: string, input: unknown, signal?: AbortSignal): Promise<ProjectToolExecution | undefined> {
    const connection = await this.ensureConnected();
    const tool = connection.tools.get(name);
    if (!tool) return undefined;
    const owner = connection.clients.get(tool.serverId);
    if (!owner) return { ok: false, output: { error: `MCP server ${tool.serverName} is not connected.` } };
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, output: { error: 'MCP tool arguments must be a JSON object.' } };
    }
    try {
      const result = await owner.callTool({
        name: tool.toolName,
        arguments: input as Record<string, unknown>,
      }, undefined, { signal });
      return {
        ok: result.isError !== true,
        output: normalizeToolResult(result),
      };
    } catch (error) {
      return { ok: false, output: { error: error instanceof Error ? error.message : String(error) } };
    }
  }

  async dispose(): Promise<void> {
    const current = this.connection;
    this.connection = undefined;
    if (!current) return;
    await Promise.allSettled([...current.clients.values()].map((client) => client.close()));
  }

  private async ensureConnected(): Promise<McpConnection> {
    const settings = await this.settings.load();
    const fingerprint = JSON.stringify(settings.mcpServers);
    if (this.connection?.fingerprint === fingerprint) return this.connection;
    if (this.connecting) return this.connecting;
    this.connecting = this.connect(settings, fingerprint).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async connect(settings: AppSettings, fingerprint: string): Promise<McpConnection> {
    const clients = new Map<string, Client>();
    const tools = new Map<string, McpToolDescriptor>();
    const enabledServers = settings.mcpServers.filter((server) => server.enabled);
    for (const server of enabledServers) {
      try {
        const client = await this.connectServer(server);
        clients.set(server.id, client);
        const listed = await client.listTools(undefined, { timeout: 15_000 });
        for (const tool of listed.tools) {
          const providerName = providerToolName(server, tool.name, tools.keys());
          tools.set(providerName, {
            providerName,
            serverId: server.id,
            serverName: server.name,
            toolName: tool.name,
            description: tool.description || 'No description provided.',
            inputSchema: tool.inputSchema,
            readOnly: tool.annotations?.readOnlyHint === true,
          });
        }
        this.logger.info('internal', `MCP server connected: ${server.name}`, `${listed.tools.length} tool(s)`);
      } catch (error) {
        this.logger.error('internal', `MCP server failed to connect: ${server.name}`, undefined, error);
      }
    }
    const previous = this.connection;
    this.connection = { fingerprint, clients, tools };
    if (previous) await Promise.allSettled([...previous.clients.values()].map((client) => client.close()));
    return this.connection;
  }

  private async connectServer(server: McpServerSettings): Promise<Client> {
    if (server.transport === 'http') return this.connectHttpServer(server);

    const env = getDefaultEnvironment();
    for (const [environmentName, credentialId] of Object.entries(server.envCredentialIds)) {
      const value = await this.credentials.get(credentialId);
      if (!value) throw new Error(`Credential ${credentialId} is required by MCP server ${server.name}.`);
      env[environmentName] = value;
    }
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      cwd: server.cwd ?? undefined,
      env,
      stderr: 'pipe',
      maxBufferSize: 10 * 1024 * 1024,
    });
    transport.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8').trim();
      if (line) this.logger.info('internal', `MCP ${server.name}: ${line.slice(0, 500)}`);
    });
    const client = new Client({ name: 'KAI Desktop', version: '0.1.0' });
    await client.connect(transport, { timeout: 15_000 });
    return client;
  }

  private async connectHttpServer(server: Extract<McpServerSettings, { transport: 'http' }>): Promise<Client> {
    const headers = new Headers();
    for (const [headerName, credentialId] of Object.entries(server.headerCredentialIds)) {
      const value = await this.credentials.get(credentialId);
      if (!value) throw new Error(`Credential ${credentialId} is required by MCP server ${server.name}.`);
      headers.set(headerName, value);
    }
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers },
      reconnectionOptions: {
        maxReconnectionDelay: 10_000,
        initialReconnectionDelay: 500,
        reconnectionDelayGrowFactor: 1.5,
        maxRetries: 2,
      },
    });
    transport.onerror = (error) => this.logger.warn('internal', `MCP ${server.name}: ${error.message}`);
    const client = new Client({ name: 'KAI Desktop', version: '0.1.0' });
    await client.connect(transport, { timeout: 15_000 });
    return client;
  }

}

function providerToolName(server: McpServerSettings, toolName: string, existing: Iterable<string>): string {
  const serverPart = sanitizeToolPart(server.id);
  const toolPart = sanitizeToolPart(toolName);
  let candidate = `mcp_${serverPart}_${toolPart}`.slice(0, 64);
  if (![...existing].includes(candidate)) return candidate;
  const hash = createHash('sha1').update(`${server.id}:${toolName}`).digest('hex').slice(0, 8);
  candidate = `mcp_${serverPart}_${hash}_${toolPart}`.slice(0, 64);
  return candidate;
}

function sanitizeToolPart(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+/, '') || 'tool';
  return sanitized.slice(0, 24);
}

function mcpInputSchema(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    const record = schema as Record<string, unknown>;
    if (record.type === 'object') return record;
  }
  return { type: 'object', properties: {}, additionalProperties: true };
}

function normalizeToolResult(result: Record<string, unknown>): unknown {
  const parts: string[] = [];
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
      const record = block as Record<string, unknown>;
      if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text);
      else if (typeof record.type === 'string') parts.push(`[${record.type} content]`);
    }
  }
  const structured = result.structuredContent;
  const text = parts.join('\n').slice(0, MAX_MCP_OUTPUT);
  return {
    ...(text ? { text } : {}),
    ...(structured && typeof structured === 'object' ? { structuredContent: structured } : {}),
    ...(result.isError === true ? { isError: true } : {}),
  };
}
