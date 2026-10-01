import * as os from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StudioArtifacts } from './artifacts';
import { StudioBoardStore } from './board';
import { writeHandoffFiles } from './handoff-files';
import { createKaiProjectTools } from './kai-project-tools';
import { SpecStore } from './spec-store';

/**
 * The `kai-project` MCP server, run as its own process. KAI writes a Claude, Codex, Qwen or Gemini config that
 * launches this with `--project <root>`, so an outside agent reads the same `.kai/spec` and works the same board as
 * a KAI agent — through the same stores, and so under the same rules.
 *
 * Kept as its own entry point rather than hosted in the Electron process because an MCP server is stdio: the agent
 * that launches it owns its stdin and stdout, and it must not share them with the app's own logging.
 */

/** The one project a server process serves. The stores are addressed by id; here the id is fixed. */
const PROJECT_ID = 'current';
const BOARD_TOOLS = new Set(['claim_task', 'move_task', 'submit_output']);

function projectArg(argv: readonly string[]): string | null {
  const index = argv.indexOf('--project');
  if (index >= 0 && argv[index + 1]) return argv[index + 1]!;
  return process.env.KAI_PROJECT_ROOT?.trim() || null;
}

export async function runKaiProjectServer(root: string): Promise<void> {
  const spec = new SpecStore();
  const projectRoot = async (): Promise<string> => root;
  const now = (): string => new Date().toISOString();
  const ports = {
    projectId: PROJECT_ID,
    projectRoot,
    spec,
    artifacts: new StudioArtifacts({ spec, projectRoot, now }),
    board: new StudioBoardStore({
      spec,
      projectRoot,
      // The outside agent's board cannot verify a build either: with no Git drift and no run, `done` stays refused.
      dirtyFiles: async () => null,
      hashFile: async () => null,
      run: async () => null,
      now,
    }),
    now,
  };

  const server = new McpServer({ name: 'kai-project', version: '0.1.0' });
  for (const tool of createKaiProjectTools(ports)) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.input },
      async (input: Record<string, unknown>) => {
        try {
          const result = await tool.run(input);
          // An outside agent moved the board, so the status file is rewritten for whoever reads it next.
          if (BOARD_TOOLS.has(tool.name)) {
            await Promise.all([ports.board.read(PROJECT_ID), ports.artifacts.read(PROJECT_ID)])
              .then(([board, catalog]) => writeHandoffFiles(root, board, catalog, now()))
              .catch(() => undefined);
          }
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          // A refused move is the point of the server, not a crash: report it as a tool error the agent can read.
          return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
        }
      },
    );
  }

  await server.connect(new StdioServerTransport());
}

async function main(): Promise<void> {
  const root = projectArg(process.argv.slice(2));
  if (!root) {
    process.stderr.write('kai-project: pass --project <path> or set KAI_PROJECT_ROOT.\n');
    process.exit(2);
  }
  await runKaiProjectServer(root);
}

// Started as a script, not imported. The guard keeps the module importable from a test.
const invokedDirectly =
  process.argv[1] !== undefined && /kai-project(\.(c[mj]s|ts))?$/i.test(process.argv[1].replace(/\\/g, '/'));
if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`kai-project: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}${os.EOL}`);
    process.exit(1);
  });
}
