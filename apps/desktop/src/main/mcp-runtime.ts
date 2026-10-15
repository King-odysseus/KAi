import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { KAI_TERMINAL_MCP_SERVER_ID, type AppSettings, type AutonomyMode, type McpServerSettings } from '@kai/contracts';
import type { RedactedLogger } from '@kai/runtime';
import type { ExternalToolPort, ProjectToolExecution, ProjectToolPolicy } from './project-tools';

const MAX_MCP_OUTPUT = 100_000;
/** How long a server that failed to connect is left alone before the next call tries it again. */
const RECONNECT_AFTER_MS = 15_000;

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
  /** One fingerprint per connected server, so a change to one server's settings reconnects only that server. */
  serverFingerprints: Map<string, string>;
  /** When each enabled server last failed to connect. A failure is not cached for good: the editor may simply not have been open yet. */
  failedAt: Map<string, number>;
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

  /**
   * Drops the connection so the next call reconnects. With a server id it drops only that server's client and
   * keeps every other one open: a tool call another server is in the middle of (Autopilot's agent, say) must not
   * be cut off because open-pencil's token changed or one of its calls failed.
   */
  invalidate(serverId?: string): void {
    const previous = this.connection;
    if (!previous) return;
    if (serverId === undefined) {
      this.connection = undefined;
      void Promise.allSettled([...previous.clients.values()].map((client) => client.close()));
      return;
    }
    const client = previous.clients.get(serverId);
    previous.clients.delete(serverId);
    previous.serverFingerprints.delete(serverId);
    previous.failedAt.delete(serverId);
    for (const [name, tool] of previous.tools) if (tool.serverId === serverId) previous.tools.delete(name);
    previous.fingerprint = '';
    if (client) void client.close().catch(() => undefined);
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
    // KAI's own terminal is a shell, so it follows the shell tool's rules: refused in Plan, asked about otherwise,
    // free in Full access. Only its read-only tools (listing and reading output) are allowed everywhere.
    if (tool.serverId === KAI_TERMINAL_MCP_SERVER_ID && !tool.readOnly) {
      if (autonomy === 'plan') return { decision: 'deny', reason: 'Plan mode does not allow shell commands.' };
      return {
        decision: 'ask',
        title: 'Use the KAI terminal?',
        detail: 'Terminal commands run with your user permissions and can reach resources outside the project. Review the exact command before allowing it.',
        risk: 'high',
      };
    }
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

  /**
   * A view of this runtime scoped to one server's tools — only that server's tools are offered, and calling one of
   * them is always allowed, regardless of the run's own autonomy. Built for the open-pencil design-build loop: it
   * needs open-pencil's own tools to actually run (autonomy 'plan' denies every non-read-only MCP tool, open-
   * pencil's render/set_fill/create_page included — see DesktopStudio.buildDesignStep), without also unlocking
   * every other MCP server the user has enabled, or needing a weaker autonomy that would also unlock the project's
   * own file and shell tools. Execution still runs through this same runtime, so reconnects and credentials are
   * shared with every other caller.
   */
  scopedToServer(serverId: string): ExternalToolPort {
    return {
      definitions: async () => {
        const connection = await this.ensureConnected();
        return [...connection.tools.values()]
          .filter((tool) => tool.serverId === serverId)
          .map((tool) => ({
            type: 'function',
            name: tool.providerName,
            description: `MCP server ${tool.serverName}: ${tool.description}`,
            parameters: mcpInputSchema(tool.inputSchema),
          }));
      },
      policy: (name) => (this.connection?.tools.get(name)?.serverId === serverId ? { decision: 'allow' } : undefined),
      execute: (name, input, signal) => this.execute(name, input, signal),
    };
  }

  async execute(name: string, input: unknown, signal?: AbortSignal): Promise<ProjectToolExecution | undefined> {
    const connection = await this.ensureConnected();
    const tool = connection.tools.get(name);
    if (!tool) return undefined;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, output: { error: 'MCP tool arguments must be a JSON object.' } };
    }
    try {
      const result = await this.callWithReconnect(tool.serverId, (client) => client.callTool({
        name: tool.toolName,
        arguments: input as Record<string, unknown>,
      }, undefined, { signal }));
      if (result === undefined) return { ok: false, output: { error: `MCP server ${tool.serverName} is not connected.` } };
      return {
        ok: result.isError !== true,
        output: normalizeToolResult(result),
      };
    } catch (error) {
      return { ok: false, output: { error: error instanceof Error ? error.message : String(error) } };
    }
  }

  /**
   * Calls a tool on one named server and returns the raw content blocks. Unlike `execute` it keeps images, which is
   * what a screenshot tool returns and what `normalizeToolResult` would otherwise flatten to `[image content]`.
   */
  async callServerTool(serverId: string, toolName: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown[] | null> {
    const result = await this.callWithReconnect(serverId, (client) => client.callTool({ name: toolName, arguments: input }, undefined, { signal }));
    if (result === undefined) return null;
    return Array.isArray(result.content) ? result.content : [];
  }

  /**
   * Runs a call against one server's client, and — the point of this — tries exactly once more against a fresh
   * connection if the first attempt throws. A server that was restarted since KAI last connected (open-pencil
   * reissuing its token, or dropping it entirely when auth is turned off) fails its first call on the now-dead
   * client; `invalidate` plus a fresh `ensureConnected` is the same recovery a person would do by hand, just
   * automatic. Returns undefined, rather than retrying forever, when the server is not configured at all.
   */
  private async callWithReconnect<T>(
    serverId: string,
    run: (client: Client) => Promise<T>,
  ): Promise<T | undefined> {
    const connection = await this.ensureConnected();
    let client = connection.clients.get(serverId);
    if (!client) {
      // Enabled but not connected means it was down when KAI last tried (open-pencil not open yet, say). Try once
      // more now rather than answering "not connected" for as long as the settings stay the same.
      const configured = (await this.settings.load()).mcpServers.some((server) => server.id === serverId && server.enabled);
      if (!configured) return undefined;
      this.invalidate(serverId);
      client = (await this.ensureConnected()).clients.get(serverId);
      if (!client) return undefined;
    }
    try {
      return await run(client);
    } catch (error) {
      this.invalidate(serverId);
      const reconnected = await this.ensureConnected();
      const retried = reconnected.clients.get(serverId);
      if (!retried) throw error;
      return run(retried);
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
    if (this.connection?.fingerprint === fingerprint && !this.retryDue(this.connection)) return this.connection;
    if (this.connecting) return this.connecting;
    this.connecting = this.connect(settings, fingerprint).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private retryDue(connection: McpConnection): boolean {
    const now = Date.now();
    return [...connection.failedAt.values()].some((failed) => now - failed > RECONNECT_AFTER_MS);
  }

  /** Drops what is held for one credential, so only the servers that use it reconnect. */
  async invalidateCredential(credentialId: string): Promise<void> {
    const settings = await this.settings.load();
    for (const server of settings.mcpServers) {
      const ids = server.transport === 'http' ? Object.values(server.headerCredentialIds) : Object.values(server.envCredentialIds);
      if (ids.includes(credentialId)) this.invalidate(server.id);
    }
  }

  private async connect(settings: AppSettings, fingerprint: string): Promise<McpConnection> {
    const previous = this.connection;
    const clients = new Map<string, Client>();
    const tools = new Map<string, McpToolDescriptor>();
    const serverFingerprints = new Map<string, string>();
    const failedAt = new Map<string, number>();
    const enabledServers = settings.mcpServers.filter((server) => server.enabled);
    for (const server of enabledServers) {
      const serverFingerprint = JSON.stringify(server);
      // A server whose own settings did not change keeps its live client and tools, so one server's change never
      // closes a call another server is in the middle of.
      const kept = previous?.clients.get(server.id);
      if (kept && previous?.serverFingerprints.get(server.id) === serverFingerprint) {
        clients.set(server.id, kept);
        serverFingerprints.set(server.id, serverFingerprint);
        for (const [name, tool] of previous.tools) if (tool.serverId === server.id) tools.set(name, tool);
        continue;
      }
      try {
        const client = await this.connectServer(server);
        clients.set(server.id, client);
        serverFingerprints.set(server.id, serverFingerprint);
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
        failedAt.set(server.id, Date.now());
        this.logger.error('internal', `MCP server failed to connect: ${server.name}`, undefined, error);
      }
    }
    this.connection = { fingerprint, serverFingerprints, failedAt, clients, tools };
    if (previous) {
      const dropped = [...previous.clients].filter(([id, client]) => clients.get(id) !== client).map(([, client]) => client);
      await Promise.allSettled(dropped.map((client) => client.close()));
    }
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

export function normalizeToolResult(result: Record<string, unknown>): unknown {
  const parts: string[] = [];
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
      const record = block as Record<string, unknown>;
      if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text);
      else if (typeof record.type === 'string') parts.push(`[${record.type} content]`);
    }
  }
  const images = Array.isArray(result.content) ? result.content.filter((block: unknown) => block && typeof block === 'object' && (block as Record<string, unknown>).type === 'image') : [];
  const structured = result.structuredContent;
  const text = parts.join('\n').slice(0, MAX_MCP_OUTPUT);
  return {
    ...(text ? { text } : {}),
    ...(images.length ? { content: images } : {}),
    ...(structured && typeof structured === 'object' ? { structuredContent: structured } : {}),
    ...(result.isError === true ? { isError: true } : {}),
  };
}
