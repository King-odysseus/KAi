import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Which test files are "slow": the ones that start real Git processes, child processes or terminals. They are what makes
 * the full run take minutes (every file runs one after another because of them), and they are rarely what a change to a
 * component or a pure function can break.
 *
 * Found by reading the files rather than from a list, so a new test that spawns a process joins the slow tier on its own
 * and a list cannot go stale. `npm run test:fast` runs everything else, in parallel; `npm run test:slow` runs these,
 * one at a time; `npm test` still runs all of it.
 */
const STARTS_EXTERNAL_WORK = /child_process|\bspawn\(|\bexecFile|\bexecSync|git init|node-pty|pty\.spawn|'git'|\.listen\s*\(/;

/**
 * Files that start processes or hold directories open without saying so in their own text (they go through the
 * runtime's command runner, an MCP server or the board server), which is why they failed on timeouts and on a
 * directory still being in use when run in parallel. Add a file here when it shows the same pattern.
 */
const ALSO_SLOW = [
  'desktop-agent-terminal.test.ts',
  'desktop-agents.test.ts',
  'desktop-direct-provider.test.ts',
  'desktop-kai-project-server.test.ts',
  'desktop-kai-project.test.ts',
  'desktop-learning.test.ts',
  'desktop-mcp.test.ts',
  'desktop-preview.test.ts',
  'desktop-studio-plan-chat.test.ts',
  'desktop-terminal.test.ts',
  'desktop-process-cleanup.test.ts',
  'conventions-service.test.ts',
  'service-manager-process-tree.test.ts',
];

export function slowTestFiles(root = path.join(__dirname, 'test')): string[] {
  return readdirSync(root)
    .filter((name) => name.endsWith('.test.ts'))
    .filter((name) => ALSO_SLOW.includes(name) || STARTS_EXTERNAL_WORK.test(readFileSync(path.join(root, name), 'utf8')))
    .sort()
    .map((name) => `test/${name}`);
}

/** The fast tier is the remaining top-level unit and contract tests. */
export function fastTestFiles(root = path.join(__dirname, 'test')): string[] {
  const slow = new Set(slowTestFiles(root).map((file) => path.basename(file)));
  return readdirSync(root)
    .filter((name) => name.endsWith('.test.ts') && !slow.has(name))
    .sort()
    .map((name) => `test/${name}`);
}
