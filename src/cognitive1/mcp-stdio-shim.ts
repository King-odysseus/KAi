import { createInterface } from 'readline';

/**
 * Stdio MCP relay shim.
 *
 * Some agents only support MCP over stdio (JSON-RPC on stdin/stdout).
 * This shim bridges a local stdio transport to the Cognitive1 HTTP endpoint.
 *
 * Usage: launch as a child process from the agent's MCP config.
 *   node kai-mcp-stdio-shim.js --c1-url http://127.0.0.1:9876
 *
 * The shim reads JSON-RPC requests from stdin, translates them to C1 HTTP
 * calls, and writes JSON-RPC responses to stdout.
 */

export interface McpRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface StdioRelayOptions {
  c1Url: string;
  fetcher?: typeof fetch;
}

export class StdioMcpRelay {
  private readonly c1Base: string;
  private readonly fetcher: typeof fetch;
  private readonly methodMap: Record<string, string>;

  constructor(options: StdioRelayOptions) {
    this.c1Base = options.c1Url.replace(/\/+$/, '');
    this.fetcher = options.fetcher ?? fetch;
    this.methodMap = {
      'session/start': '/api/session/start',
      'brain/recall': '/api/brain/recall',
      'brain/handoff': '/api/brain/handoff',
      'brain/learn': '/api/brain/learn',
      'health': '/health',
    };
  }

  async start(): Promise<void> {
    const rl = createInterface({ input: process.stdin });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let request: McpRequest;
      try {
        request = JSON.parse(trimmed);
      } catch {
        this.writeResponse({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } });
        continue;
      }

      const response = await this.handleRequest(request);
      this.writeResponse(response);
    }
  }

  private async handleRequest(request: McpRequest): Promise<McpResponse> {
    const endpoint = this.methodMap[request.method];
    if (!endpoint) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32601, message: `Method not found: ${request.method}` },
      };
    }

    try {
      const response = await this.fetcher(`${this.c1Base}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.params || {}),
      });

      const data = await response.text();
      let result: unknown = data;
      try { result = JSON.parse(data); } catch { /* keep as text */ }

      return {
        jsonrpc: '2.0',
        id: request.id,
        result: response.ok ? result : { error: `HTTP ${response.status}`, body: result },
      };
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private writeResponse(response: McpResponse): void {
    process.stdout.write(JSON.stringify(response) + '\n');
  }
}

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  const c1Flag = args.findIndex((a) => a === '--c1-url');
  const c1Url = c1Flag >= 0 ? args[c1Flag + 1] : 'http://127.0.0.1:9876';

  const relay = new StdioMcpRelay({ c1Url });
  relay.start().catch((err) => {
    process.stderr.write(`KAI MCP stdio relay error: ${err.message}\n`);
    process.exit(1);
  });
}
