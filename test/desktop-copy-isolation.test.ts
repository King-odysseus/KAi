import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withoutTerminalTools } from '../apps/desktop/src/main/direct-provider-runtime';
import { createParallelSession, isParallelCopy } from '../apps/desktop/src/main/parallel-session';
import { copyRules } from '../apps/desktop/src/main/autopilot';
import type { ExternalToolPort } from '../apps/desktop/src/main/project-tools';

vi.setConfig({ testTimeout: 120_000 });

const run = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })));
});

function port(): ExternalToolPort & { executed: string[] } {
  const executed: string[] = [];
  return {
    executed,
    definitions: async () => [
      { name: 'mcp_kai-terminal_terminal_run' },
      { name: 'mcp_kai_terminal_terminal_read' },
      { name: 'mcp_playwright-browser_browser_navigate' },
      { name: 'mcp_open-pencil_get_node' },
    ],
    policy: () => ({ decision: 'allow' }),
    execute: async (name) => { executed.push(name); return { ok: true, output: 'ran' }; },
  };
}

describe('KAI\'s terminal, for a run working in a copy of the project', () => {
  it('is not offered, and the other outside tools still are', async () => {
    const names = (await withoutTerminalTools(port()).definitions()).map((definition) => (definition as { name: string }).name);
    expect(names).toEqual(['mcp_playwright-browser_browser_navigate', 'mcp_open-pencil_get_node']);
  });

  it('is refused with the reason if a model asks for it anyway, and never runs', async () => {
    const original = port();
    const filtered = withoutTerminalTools(original);
    expect(filtered.policy('mcp_kai-terminal_terminal_run', 'full')).toMatchObject({ decision: 'deny' });
    const result = await filtered.execute('mcp_kai-terminal_terminal_run', { command: 'npm test' });
    expect(result?.ok).toBe(false);
    expect(JSON.stringify(result?.output)).toContain('run_command');
    expect(original.executed).toEqual([]);
    expect((await filtered.execute('mcp_open-pencil_get_node', {}))?.ok).toBe(true);
    expect(original.executed).toEqual(['mcp_open-pencil_get_node']);
  });
});

describe('telling a copy of the project from the project', () => {
  it('knows a card\'s copy while its wave is open, and nothing else', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'kai-iso-repo-')));
    const base = await realpath(await mkdtemp(path.join(tmpdir(), 'kai-iso-base-')));
    directories.push(root, base);
    const git = (...args: string[]) => run('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.test', ...args], { cwd: root });
    await git('init', '-q');
    await writeFile(path.join(root, 'a.txt'), 'a\n');
    await git('add', '-A');
    await git('commit', '-q', '-m', 'initial');

    const session = (await createParallelSession(root, 'iso-wave', base))!;
    const folder = await session.checkout('card');
    expect(isParallelCopy(folder)).toBe(true);
    expect(isParallelCopy(path.join(folder, 'src', 'deep'))).toBe(true);
    expect(isParallelCopy(root)).toBe(false);
    // A folder beside the wave's whose name merely starts the same way is not a copy.
    expect(isParallelCopy(path.join(base, 'iso-wave-elsewhere'))).toBe(false);
    await session.dispose();
    expect(isParallelCopy(folder)).toBe(false);
  });
});

describe('the working rules a card\'s agent is given in its copy', () => {
  it('names the copy and keeps the agent in it, off the expensive habits and the probe files', () => {
    const rules = copyRules('C:\\Temp\\kai-parallel\\wave-3\\card-a');
    expect(rules).toContain('C:\\Temp\\kai-parallel\\wave-3\\card-a');
    expect(rules).toContain('do not touch the project\'s own folder');
    expect(rules).toContain('Do not page through a file a few lines at a time');
    expect(rules).toContain('Run the project\'s check once');
    expect(rules).toContain('Never start Electron on a probe script');
    expect(rules).toContain('Close any browser tab');
  });
});
