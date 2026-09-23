import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { terminalRunInputSchema, type TerminalEvent } from '../packages/contracts/src';
import { TerminalManager, findGitBash } from '../apps/desktop/src/main/terminal';

vi.setConfig({ testTimeout: 60_000 });

const directories: string[] = [];
const managers: TerminalManager[] = [];

async function harness() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-terminal-'));
  directories.push(cwd);
  const events: TerminalEvent[] = [];
  const manager = new TerminalManager((event) => events.push(event));
  managers.push(manager);
  const finished = (id: string) => vi.waitFor(() => {
    if (!events.some((event) => event.kind === 'exit' && event.id === id)) throw new Error('still running');
  }, { timeout: 30_000, interval: 50 });
  return { cwd, events, manager, finished };
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stopAll()));
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })));
});

const outputOf = (events: TerminalEvent[], id: string, stream: 'stdout' | 'stderr'): string =>
  events.flatMap((event) => (event.kind === 'output' && event.id === id && event.stream === stream ? [event.text] : [])).join('');
const exitOf = (events: TerminalEvent[], id: string) => events.find((event) => event.kind === 'exit' && event.id === id);

describe('terminal command runner', () => {
  it('runs a command in the project folder and streams its output, then reports the exit code', async () => {
    const { cwd, events, manager, finished } = await harness();
    const id = manager.start('p1', cwd, 'node -e "console.log(process.cwd()); console.error(\'warn\'); process.exit(3)"', 'default');
    await finished(id);
    // Windows can print the short 8.3 form of the folder, so compare the real paths.
    expect(await fs.realpath(outputOf(events, id, 'stdout').trim())).toBe(await fs.realpath(cwd));
    expect(outputOf(events, id, 'stderr')).toContain('warn');
    expect(exitOf(events, id)).toMatchObject({ kind: 'exit', code: 3 });
    expect(manager.runningCount()).toBe(0);
  });

  it('ends a program that waits for typed input instead of hanging, because stdin is closed', async () => {
    const { cwd, events, manager, finished } = await harness();
    const id = manager.start('p1', cwd, 'node -e "process.stdin.on(\'end\', () => console.log(\'stdin closed\')); process.stdin.resume()"', 'default');
    await finished(id);
    expect(outputOf(events, id, 'stdout')).toContain('stdin closed');
  });

  it('stops a long-running command and everything it started', async () => {
    const { cwd, events, manager, finished } = await harness();
    const id = manager.start('p1', cwd, 'node -e "setInterval(() => {}, 1000)"', 'default');
    await vi.waitFor(() => expect(manager.runningCount()).toBe(1));
    expect(await manager.stop(id)).toBe(true);
    await finished(id);
    expect(manager.runningCount()).toBe(0);
    expect(await manager.stop(id)).toBe(false);
    expect(exitOf(events, id)).toBeTruthy();
  });

  it('reports a command that cannot start as a failed run rather than throwing', async () => {
    const { cwd, events, manager, finished } = await harness();
    const id = manager.start('p1', cwd, 'definitely-not-a-real-command-kai', 'default');
    await finished(id);
    const exit = exitOf(events, id);
    expect(exit?.kind === 'exit' && exit.code).not.toBe(0);
  });

  it('caps how many commands run at once', async () => {
    const { cwd, manager } = await harness();
    const ids = Array.from({ length: 8 }, () => manager.start('p1', cwd, 'node -e "setInterval(() => {}, 1000)"', 'default'));
    expect(() => manager.start('p1', cwd, 'node -e "0"', 'default')).toThrow(/at most|Only 8/);
    await manager.stopAll();
    expect(ids).toHaveLength(8);
  });

  it('splits very large output into bounded chunks', async () => {
    const { cwd, events, manager, finished } = await harness();
    const id = manager.start('p1', cwd, 'node -e "process.stdout.write(\'x\'.repeat(50000))"', 'default');
    await finished(id);
    const chunks = events.filter((event) => event.kind === 'output' && event.id === id);
    expect(outputOf(events, id, 'stdout')).toHaveLength(50_000);
    expect(chunks.every((event) => event.kind === 'output' && event.text.length <= 16_000)).toBe(true);
  });
});

describe('Git Bash', () => {
  it.runIf(findGitBash() !== null)('runs a command in Git Bash when Git for Windows is installed', async () => {
    const { cwd, events, manager, finished } = await harness();
    const id = manager.start('p1', cwd, 'echo $((6 * 7)) && pwd', 'gitbash');
    await finished(id);
    expect(outputOf(events, id, 'stdout')).toContain('42');
    expect(exitOf(events, id)).toMatchObject({ kind: 'exit', code: 0 });
  });

  it('accepts gitbash as a shell and explains when Git Bash is missing', async () => {
    expect(terminalRunInputSchema.safeParse({ projectId: 'p', command: 'ls', shell: 'gitbash' }).success).toBe(true);
    const previous = process.env.KAI_GIT_BASH;
    process.env.KAI_GIT_BASH = 'C:\nowhere\bash.exe';
    try {
      if (findGitBash() === null) {
        const { cwd, manager } = await harness();
        expect(() => manager.start('p1', cwd, 'ls', 'gitbash')).toThrow(/Git Bash was not found/);
      }
    } finally {
      if (previous === undefined) delete process.env.KAI_GIT_BASH;
      else process.env.KAI_GIT_BASH = previous;
    }
  });
});

describe('terminal input contract', () => {
  it('requires a project, a non-empty command and a known shell', () => {
    expect(terminalRunInputSchema.safeParse({ projectId: 'p', command: 'git status', shell: 'default' }).success).toBe(true);
    expect(terminalRunInputSchema.safeParse({ projectId: 'p', command: '   ', shell: 'default' }).success).toBe(false);
    expect(terminalRunInputSchema.safeParse({ projectId: 'p', command: 'ls', shell: 'zsh' }).success).toBe(false);
    expect(terminalRunInputSchema.safeParse({ projectId: 'p', command: 'x'.repeat(4_001), shell: 'default' }).success).toBe(false);
  });
});
