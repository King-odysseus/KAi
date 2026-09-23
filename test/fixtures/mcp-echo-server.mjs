import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'kai-test-mcp', version: '1.0.0' });

server.registerTool(
  'echo',
  {
    description: 'Echo text for tests.',
    inputSchema: { text: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ text }) => ({ content: [{ type: 'text', text: `echo:${text}` }] }),
);

server.registerTool(
  'show_secret',
  {
    description: 'Return a secret supplied through the vault-backed environment.',
    inputSchema: {},
  },
  async () => ({
    content: [{ type: 'text', text: `secret:${process.env.KAI_TEST_MCP_SECRET ?? 'missing'}` }],
  }),
);

await server.connect(new StdioServerTransport());
