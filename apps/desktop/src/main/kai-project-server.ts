import * as os from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { NodeFileSystem } from '@kai/runtime';
import { StudioArtifacts } from './artifacts';
import { StudioBoardStore } from './board';
import { writeHandoffFiles } from './handoff-files';
import { createKaiProjectTools } from './kai-project-tools';
import { SecurityFindingsStore } from './security-findings-store';
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

/**
 * Where the app keeps its findings log. Passed explicitly rather than derived from the project because the log is
 * one per installation, not one per repository — the panel reads that same file.
 */
function findingsArg(argv: readonly string[]): string | null {
  const index = argv.indexOf('--findings');
  if (index >= 0 && argv[index + 1]) return argv[index + 1]!;
  return process.env.KAI_FINDINGS_FILE?.trim() || null;
}

export async function runKaiProjectServer(root: string, findingsFile?: string | null): Promise<void> {
  const spec = new SpecStore();
  const projectRoot = async (): Promise<string> => root;
  const now = (): string => new Date().toISOString();
  const ports = {
    projectId: PROJECT_ID,
    projectRoot,
    spec,
    ...(findingsFile ? { findings: new SecurityFindingsStore(findingsFile, new NodeFileSystem()) } : {}),
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
  // Wired after the transport, so both are listening before anything can close the pipe under us.
  endWhenParentGoes(server);
}

/**
 * Ends this process when the agent that launched it goes away.
 *
 * An MCP server is stdio, and it lives exactly as long as the pipe does: when the agent exits — finished, crashed, or
 * killed — stdin reaches EOF and there is nobody left to answer. The SDK's stdio transport registers `data` and
 * `error` and never `end`, so nothing fires on EOF and the reader that is still attached keeps the event loop alive.
 * The process then outlives the agent for good, one per finished session, each holding a project open. Nothing in KAI
 * collects them either: they are launched by the agent rather than by KAI, so they are outside KAI's process tree and
 * the quit-time `taskkill /T` walks straight past them.
 */
export function endWhenParentGoes(
  server: Pick<McpServer, 'close'>,
  input: NodeJS.ReadableStream = process.stdin,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  let leaving = false;
  const leave = (): void => {
    if (leaving) return;
    leaving = true;
    // Closed first so a tool call in flight is not cut off mid-write; the exit is a formality after that, since
    // whoever would have read the answer has gone.
    void server.close().catch(() => undefined).finally(() => exit(0));
  };
  // A stream only reports its end once it is being read, so this does not depend on the transport having already put
  // stdin into flowing mode — the one thing here that must not rely on somebody else's internals.
  input.resume();
  input.on('end', leave);
  // Some pipes report the closure this way instead, and a signal means the same thing: nobody is waiting.
  input.on('close', leave);
  process.on('SIGTERM', leave);
  process.on('SIGINT', leave);
}

async function main(): Promise<void> {
  const root = projectArg(process.argv.slice(2));
  if (!root) {
    process.stderr.write('kai-project: pass --project <path> or set KAI_PROJECT_ROOT.\n');
    process.exit(2);
  }
  await runKaiProjectServer(root, findingsArg(process.argv.slice(2)));
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
