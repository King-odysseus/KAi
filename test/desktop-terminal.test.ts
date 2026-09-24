import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { terminalResizeInputSchema, terminalStartInputSchema, terminalWriteInputSchema, type TerminalEvent } from '../packages/contracts/src';
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
  const output = (id: string) => events.flatMap((event) => event.kind === 'output' && event.id === id ? [event.data] : []).join('');
  const waitForOutput = (id: string, text: string) => vi.waitFor(() => {
    if (!output(id).includes(text)) throw new Error(`Waiting for ${text}`);
  }, { timeout: 30_000, interval: 50 });
  const waitForExit = (id: string) => vi.waitFor(() => {
    if (!events.some((event) => event.kind === 'exit' && event.id === id)) throw new Error('still running');
  }, { timeout: 30_000, interval: 50 });
  return { cwd, events, manager, output, waitForOutput, waitForExit };
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stopAll()));
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })));
});

describe('interactive terminal manager', () => {
  it('starts in the project folder and accepts typed commands', async () => {
    const { cwd, events, manager, output, waitForOutput, waitForExit } = await harness();
    const session = manager.start('p1', cwd, 'default', 100, 30);
    manager.write(session.id, `node -e "console.log(process.cwd()); console.error('warn')"\r`);
    await waitForOutput(session.id, 'warn');
    expect(output(session.id)).toContain('kai-terminal-');
    manager.write(session.id, 'exit 3\r');
    await waitForExit(session.id);
    expect(events.find((event) => event.kind === 'exit' && event.id === session.id)).toMatchObject({ code: 3 });
    expect(manager.runningCount()).toBe(0);
  });

  it('keeps stdin open so an interactive prompt can receive typed input', async () => {
    const { cwd, manager, waitForOutput } = await harness();
    await fs.writeFile(path.join(cwd, 'prompt.mjs'), [
      "process.stdout.write('Name: ');",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.once('data', (value) => { console.log(`hello ${value.trim()}`); process.exit(0); });",
    ].join('\n'), 'utf8');
    const session = manager.start('p1', cwd, 'default', 100, 30);
    manager.write(session.id, 'node prompt.mjs\r');
    await waitForOutput(session.id, 'Name:');
    manager.write(session.id, 'KAI\r');
    await waitForOutput(session.id, 'hello KAI');
  });

  it('resizes, stops a long-running session, and reports missing sessions as false', async () => {
    const { cwd, manager, waitForExit } = await harness();
    const session = manager.start('p1', cwd, 'default', 100, 30);
    manager.write(session.id, 'node -e "setInterval(() => {}, 1000)"\r');
    await vi.waitFor(() => expect(manager.runningCount()).toBe(1));
    expect(manager.resize(session.id, 120, 40)).toBe(true);
    expect(await manager.stop(session.id)).toBe(true);
    await waitForExit(session.id);
    expect(manager.runningCount()).toBe(0);
    expect(manager.write(session.id, 'x')).toBe(false);
    expect(manager.resize(session.id, 80, 24)).toBe(false);
    expect(manager.stop(session.id)).toBe(false);
  });

  it('caps the number of concurrent PTY sessions', async () => {
    const { cwd, manager } = await harness();
    const sessions = Array.from({ length: 8 }, () => manager.start('p1', cwd, 'default', 80, 24));
    expect(() => manager.start('p1', cwd, 'default', 80, 24)).toThrow(/Only 8/);
    await manager.stopAll();
    expect(sessions).toHaveLength(8);
  });
});

describe('Git Bash', () => {
  it.runIf(findGitBash() !== null)('starts a login shell and accepts Git Bash syntax', async () => {
    const { cwd, manager, waitForOutput, waitForExit } = await harness();
    const session = manager.start('p1', cwd, 'gitbash', 100, 30);
    manager.write(session.id, 'echo $((6 * 7))\n');
    await waitForOutput(session.id, '42');
    manager.write(session.id, 'exit\n');
    await waitForExit(session.id);
  });
});

describe('terminal contracts', () => {
  it('validates PTY start dimensions, write payloads, and resize payloads', () => {
    expect(terminalStartInputSchema.safeParse({ projectId: 'p', shell: 'default', cols: 120, rows: 30 }).success).toBe(true);
    expect(terminalStartInputSchema.safeParse({ projectId: 'p', shell: 'zsh', cols: 120, rows: 30 }).success).toBe(false);
    expect(terminalStartInputSchema.safeParse({ projectId: 'p', shell: 'default', cols: 1, rows: 30 }).success).toBe(false);
    expect(terminalWriteInputSchema.safeParse({ id: 'term', data: 'ls\r' }).success).toBe(true);
    expect(terminalWriteInputSchema.safeParse({ id: 'term', data: 'x'.repeat(100_001) }).success).toBe(false);
    expect(terminalResizeInputSchema.safeParse({ id: 'term', cols: 80, rows: 24 }).success).toBe(true);
    expect(terminalResizeInputSchema.safeParse({ id: 'term', cols: 80, rows: 2 }).success).toBe(false);
  });
});
