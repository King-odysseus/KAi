import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { WindowControl } from './window-control';

/**
 * KAI's own windows as an MCP server hosted inside the desktop app, on 127.0.0.1 behind a Bearer token minted at
 * launch. The same arrangement as the terminal server: one implementation serves the direct-API agent and every CLI
 * agent. It sees KAI's pages only; see window-control.ts for what it cannot reach.
 */

const windowField = z.number().int().optional().describe('Which KAI window (from window_list). Omit for the focused one.');

export function registerWindowTools(server: McpServer, control: WindowControl): void {
  const text = (value: unknown): { content: Array<{ type: 'text'; text: string }> } => ({
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  });
  const failure = (error: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } => ({
    content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  });

  server.registerTool('window_list', {
    description: 'List the open KAI windows with their titles (which name the project) and which one is focused.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => text(control.list()));

  server.registerTool('window_screenshot', {
    description: 'See a KAI window: a PNG of its page. Use it to check how a screen looks. Only KAI itself is visible; no other application or the desktop.',
    inputSchema: { window_id: windowField },
    annotations: { readOnlyHint: true },
  }, async ({ window_id }) => {
    try {
      const shot = await control.screenshot(window_id);
      return {
        content: [
          { type: 'image' as const, data: shot.png.toString('base64'), mimeType: 'image/png' },
          { type: 'text' as const, text: `Window ${shot.windowId}, ${shot.width}x${shot.height}.` },
        ],
      };
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('window_snapshot', {
    description: 'List the controls visible in a KAI window (buttons, links, inputs, tabs) with a ref, name and position for each. Cheaper and more exact than a screenshot for deciding what to click; pass a ref to window_click or window_type. Refs change when the page does, so take a fresh snapshot after acting.',
    inputSchema: { window_id: windowField },
    annotations: { readOnlyHint: true },
  }, async ({ window_id }) => {
    try {
      return text(await control.snapshot(window_id));
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('window_click', {
    description: 'Click a control in a KAI window, by ref from window_snapshot or by x,y in the window. Paused while KAI is waiting for the person to answer an approval.',
    inputSchema: {
      window_id: windowField,
      ref: z.string().optional().describe('A ref from the latest window_snapshot.'),
      x: z.number().optional(),
      y: z.number().optional(),
      double: z.boolean().optional(),
      right: z.boolean().optional().describe('Right-click.'),
    },
  }, async ({ window_id, ref, x, y, double, right }) => {
    try {
      return text(await control.click({
        ...(window_id === undefined ? {} : { windowId: window_id }),
        ...(ref ? { ref } : {}),
        ...(x === undefined ? {} : { x }),
        ...(y === undefined ? {} : { y }),
        ...(double ? { double } : {}),
        ...(right ? { right } : {}),
      }));
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('window_type', {
    description: 'Type text into a KAI window. With a ref it clicks that field first; with clear it replaces what the field held. Paused while KAI is waiting for an approval.',
    inputSchema: {
      window_id: windowField,
      text: z.string().max(20_000),
      ref: z.string().optional(),
      clear: z.boolean().optional(),
    },
  }, async ({ window_id, text: value, ref, clear }) => {
    try {
      return text(await control.type({
        ...(window_id === undefined ? {} : { windowId: window_id }),
        text: value,
        ...(ref ? { ref } : {}),
        ...(clear ? { clear } : {}),
      }));
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('window_key', {
    description: 'Press a key in a KAI window: a single character, or Enter, Tab, Escape, Backspace, Delete, Space, an arrow, Home, End, PageUp, PageDown or F1-F12, with optional shift, control or alt.',
    inputSchema: {
      window_id: windowField,
      key: z.string().min(1).max(12),
      modifiers: z.array(z.enum(['shift', 'control', 'alt'])).max(3).optional(),
    },
  }, async ({ window_id, key, modifiers }) => {
    try {
      return text(await control.pressKey({
        ...(window_id === undefined ? {} : { windowId: window_id }),
        key,
        ...(modifiers ? { modifiers } : {}),
      }));
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('window_scroll', {
    description: 'Scroll a KAI window by a number of pixels (positive scrolls down), at x,y if given.',
    inputSchema: { window_id: windowField, delta_y: z.number().min(-5000).max(5000), x: z.number().optional(), y: z.number().optional() },
  }, async ({ window_id, delta_y, x, y }) => {
    try {
      return text(await control.scroll({
        ...(window_id === undefined ? {} : { windowId: window_id }),
        deltaY: delta_y,
        ...(x === undefined ? {} : { x }),
        ...(y === undefined ? {} : { y }),
      }));
    } catch (error) {
      return failure(error);
    }
  });
}

export interface WindowMcpHost {
  /** `http://127.0.0.1:<port>/mcp`. */
  endpoint: string;
  /** The whole Authorization header value, `Bearer <token>`. */
  authorization: string;
  close(): Promise<void>;
}

export async function startWindowMcpHost(control: WindowControl): Promise<WindowMcpHost> {
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
    const server = new McpServer({ name: 'kai-window', version: '0.1.0' });
    registerWindowTools(server, control);
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
  if (!address || typeof address === 'string') throw new Error('The window MCP host did not bind a TCP port.');
  return {
    endpoint: `http://127.0.0.1:${address.port}/mcp`,
    authorization: `Bearer ${token}`,
    close: () => new Promise<void>((resolve) => { httpServer.close(() => resolve()); }),
  };
}
