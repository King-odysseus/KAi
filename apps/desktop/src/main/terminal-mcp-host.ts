import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { AgentShell, AgentTerminal } from './agent-terminal';

/**
 * Hosts KAI's terminal as an MCP server inside the desktop app, on 127.0.0.1 behind a Bearer token minted at launch.
 *
 * It lives in the app process, not in a stdio script like `kai-project`, because the sessions have to be the app's own
 * — the ones the terminal dock draws. KAI's direct-API agent reaches it through the ordinary MCP runtime, and the CLI
 * agents through the entries written to their configs, so one implementation serves them all, Autopilot included.
 */

const shellField = z.enum(['gitbash', 'powershell', 'cmd']).optional().describe('Which shell. Omit for KAI\'s default (Git Bash when installed). `cmd` is the Windows command prompt; off Windows it means the login shell.');

export function registerTerminalTools(server: McpServer, terminal: AgentTerminal): void {
  const text = (value: unknown): { content: Array<{ type: 'text'; text: string }> } => ({
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  });
  const failure = (error: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } => ({
    content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  });

  server.registerTool('terminal_run', {
    description: 'Run a command in a KAI terminal session and wait for it to finish. The session is reused for the same shell and folder, so `cd` and exported variables carry over, and the person can watch it in the terminal dock. Use this instead of opening a terminal window. A command that does not finish (a dev server) returns what it printed so far with timed_out true and keeps running: read it later with terminal_read.',
    inputSchema: {
      command: z.string().describe('The command line to run.'),
      shell: shellField,
      cwd: z.string().optional().describe('Folder to run in (absolute). Defaults to the open project.'),
      session_id: z.string().optional().describe('Run in this exact session instead (from terminal_start or terminal_list).'),
      timeout_ms: z.number().int().min(1000).max(300_000).optional().describe('How long to wait, 30000 by default, 300000 at most.'),
    },
  }, async ({ command, shell, cwd, session_id, timeout_ms }) => {
    try {
      const result = await terminal.run({
        command,
        ...(shell ? { shell: shell as AgentShell } : {}),
        ...(cwd ? { cwd } : {}),
        ...(session_id ? { sessionId: session_id } : {}),
        ...(timeout_ms ? { timeoutMs: timeout_ms } : {}),
      });
      return text({
        session_id: result.sessionId,
        shell: result.shell,
        exit_code: result.exitCode,
        timed_out: result.timedOut,
        output: result.output,
      });
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('terminal_start', {
    description: 'Open a new KAI terminal session without running anything, for something long-lived or interactive.',
    inputSchema: { shell: shellField, cwd: z.string().optional().describe('Folder to start in (absolute). Defaults to the open project.') },
  }, async ({ shell, cwd }) => {
    try {
      const started = await terminal.start({ ...(shell ? { shell: shell as AgentShell } : {}), ...(cwd ? { cwd } : {}) });
      return text({ session_id: started.id, shell: started.shell, cwd: started.cwd });
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('terminal_read', {
    description: 'Read the most recent output of a terminal session, for example a dev server started earlier.',
    inputSchema: { session_id: z.string(), max_chars: z.number().int().min(200).max(30_000).optional() },
    annotations: { readOnlyHint: true },
  }, async ({ session_id, max_chars }) => {
    try {
      return text(terminal.read(session_id, max_chars));
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('terminal_watch', {
    description: 'Wait for a pattern to appear in a session\'s output — a dev server reporting it is ready, a build finishing — instead of calling terminal_read over and over on a guess. Checks what has already printed first, then waits for new output. Returns matched: true the moment the pattern appears, or matched: false once the timeout passes or the session exits without it.',
    inputSchema: {
      session_id: z.string(),
      pattern: z.string().describe('A regular expression to look for in the output, matched case-insensitively.'),
      timeout_ms: z.number().int().min(1000).max(600_000).optional().describe('How long to wait, 60000 by default, 600000 (ten minutes) at most.'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ session_id, pattern, timeout_ms }) => {
    try {
      const result = await terminal.watch({
        sessionId: session_id,
        pattern,
        ...(timeout_ms ? { timeoutMs: timeout_ms } : {}),
      });
      return text({ matched: result.matched, output: result.output });
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('terminal_write', {
    description: 'Type raw keystrokes into a session, for a prompt a command stopped on. End a line with \\r to press Enter; send \\u0003 for Ctrl+C.',
    inputSchema: { session_id: z.string(), input: z.string().max(100_000) },
  }, async ({ session_id, input }) => {
    try {
      terminal.write(session_id, input);
      return text('Sent.');
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('terminal_list', {
    description: 'List open KAI terminal sessions and which shells are installed.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => text({
    shells_installed: terminal.shellsAvailable(),
    sessions: terminal.list().map((session) => ({ session_id: session.id, shell: session.shell, cwd: session.cwd, started_by_agent: session.byAgent })),
  }));

  server.registerTool('terminal_stop', {
    description: 'Close a terminal session and end whatever is running in it.',
    inputSchema: { session_id: z.string() },
  }, async ({ session_id }) => {
    try {
      terminal.stop(session_id);
      return text('Stopped.');
    } catch (error) {
      return failure(error);
    }
  });
}

export interface TerminalMcpHost {
  /** `http://127.0.0.1:<port>/mcp`. */
  endpoint: string;
  /** The whole Authorization header value, `Bearer <token>`. */
  authorization: string;
  close(): Promise<void>;
}

export async function startTerminalMcpHost(terminal: AgentTerminal): Promise<TerminalMcpHost> {
  const token = randomBytes(24).toString('hex');
  const expected = Buffer.from(`Bearer ${token}`);
  const httpServer = http.createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: String(error) }, id: null }));
      }
    });
  });

  async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' });
      response.end();
      return;
    }
    const given = Buffer.from(request.headers.authorization ?? '');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      response.writeHead(401);
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');
    const server = new McpServer({ name: 'kai-terminal', version: '0.1.0' });
    registerTerminalTools(server, terminal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    response.once('close', () => {
      void transport.close();
      void server.close();
    });
    await transport.handleRequest(request, response, raw ? JSON.parse(raw) : undefined);
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('The terminal MCP host did not bind a TCP port.');
  return {
    endpoint: `http://127.0.0.1:${address.port}/mcp`,
    authorization: `Bearer ${token}`,
    close: () => new Promise<void>((resolve) => { httpServer.close(() => resolve()); }),
  };
}
