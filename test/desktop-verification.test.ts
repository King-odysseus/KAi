import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isVerificationCommand, parseTestCounts, verificationStatuses } from '../packages/contracts/src';
import {
  VerificationStore,
  agentChecksFromEvents,
  recordVerification,
  runCheckCommand,
  suggestTestCommand,
  verificationOverview,
} from '../apps/desktop/src/main/verification';

// Each step starts git or node processes, which are slow on Windows when the whole suite runs at once.
vi.setConfig({ testTimeout: 90_000 });

const directories: string[] = [];

async function temporary(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-verify-'));
  directories.push(directory);
  return directory;
}

async function repository(): Promise<string> {
  const root = await temporary();
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root });
  return root;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })));
});

const PASS = 'node -e "process.exit(0)"';
const FAIL = 'node -e "process.exit(1)"';

describe('file status against the latest check', () => {
  const hashes = [{ path: 'a.ts', hash: 'h1' }, { path: 'b.ts', hash: 'h2' }];

  it('is unverified before any check has run', () => {
    expect(verificationStatuses(null, hashes).map((file) => file.status)).toEqual(['unverified', 'unverified']);
  });

  it('is verified only for files whose content the passing check saw', () => {
    const latest = { passed: true, files: hashes };
    expect(verificationStatuses(latest, hashes).map((file) => file.status)).toEqual(['verified', 'verified']);
    expect(verificationStatuses(latest, [{ path: 'a.ts', hash: 'CHANGED' }, hashes[1]!]).map((file) => file.status)).toEqual(['stale', 'verified']);
    expect(verificationStatuses(latest, [...hashes, { path: 'c.ts', hash: 'new' }]).at(-1)?.status).toBe('stale');
  });

  it('reports a failed check on unchanged files as failed, not verified', () => {
    expect(verificationStatuses({ passed: false, files: hashes }, hashes).map((file) => file.status)).toEqual(['failed', 'failed']);
  });
});

describe('recording checks against real files', () => {
  it('goes stale when a file changes, and a repaired file rerun becomes verified again', async () => {
    const root = await repository();
    const store = new VerificationStore(await temporary());
    await fs.writeFile(path.join(root, 'a.ts'), 'export const a = 1;\n');

    await recordVerification(store, 'p1', root, await runCheckCommand(root, FAIL));
    let overview = await verificationOverview(store, 'p1', root);
    expect(overview.gitAvailable).toBe(true);
    expect(overview.latest).toMatchObject({ passed: false, exitCode: 1, source: 'user' });
    expect(overview.files).toEqual([{ path: 'a.ts', status: 'failed' }]);

    // The repair changes the file, so the failed result no longer describes it...
    await fs.writeFile(path.join(root, 'a.ts'), 'export const a = 2;\n');
    overview = await verificationOverview(store, 'p1', root);
    expect(overview.files).toEqual([{ path: 'a.ts', status: 'stale' }]);

    // ...and rerunning the check on the new content verifies it.
    await recordVerification(store, 'p1', root, await runCheckCommand(root, PASS));
    overview = await verificationOverview(store, 'p1', root);
    expect(overview.latest?.passed).toBe(true);
    expect(overview.files).toEqual([{ path: 'a.ts', status: 'verified' }]);
    expect(overview.history.map((run) => run.passed)).toEqual([true, false]);

    // Any later edit, even a tiny one, makes it stale again.
    await fs.appendFile(path.join(root, 'a.ts'), '// touched\n');
    expect((await verificationOverview(store, 'p1', root)).files[0]?.status).toBe('stale');
  });

  it('marks a newly changed file unverified-by-that-run (stale) even when the old files are unchanged', async () => {
    const root = await repository();
    const store = new VerificationStore(await temporary());
    await fs.writeFile(path.join(root, 'a.ts'), 'a');
    await recordVerification(store, 'p1', root, await runCheckCommand(root, PASS));
    await fs.writeFile(path.join(root, 'b.ts'), 'b');
    const statuses = (await verificationOverview(store, 'p1', root)).files;
    expect(statuses).toEqual([{ path: 'a.ts', status: 'verified' }, { path: 'b.ts', status: 'stale' }]);
  });

  it('works without git, reporting that verification needs a repository', async () => {
    const root = await temporary();
    const store = new VerificationStore(await temporary());
    await fs.writeFile(path.join(root, 'a.ts'), 'a');
    const run = await recordVerification(store, 'p1', root, await runCheckCommand(root, PASS));
    expect(run.files).toEqual([]);
    expect(await verificationOverview(store, 'p1', root)).toMatchObject({ gitAvailable: false, files: [] });
  });

  it('keeps output short, treats a command that cannot start as a failure, and never crosses projects', async () => {
    const root = await repository();
    const store = new VerificationStore(await temporary());
    const noisy = await runCheckCommand(root, 'node -e "console.log(\'x\'.repeat(50000))"');
    const run = await recordVerification(store, 'p1', root, noisy);
    expect(run.outputTail.length).toBeLessThanOrEqual(4_000);
    const missing = await runCheckCommand(root, 'definitely-not-a-real-command-kai');
    expect(missing.exitCode).not.toBe(0);
    expect(await store.list('other-project')).toEqual([]);
    await expect(store.list('../escape')).resolves.toEqual([]);
  });
});

describe('recognising checks', () => {
  it('recognises test, type-check and lint commands but not builds or installs', () => {
    for (const command of ['npm test', 'npm run lint', 'pnpm test', 'npx vitest run', 'pytest -q', 'python -m pytest', 'cargo test', 'go test ./...', 'tsc -p .', 'npx eslint src']) {
      expect(isVerificationCommand(command), command).toBe(true);
    }
    for (const command of ['npm install', 'npm run build', 'git status', 'ls -la', 'cargo build']) {
      expect(isVerificationCommand(command), command).toBe(false);
    }
  });

  it('reads totals from vitest, pytest and cargo summaries', () => {
    expect(parseTestCounts(' Tests  386 passed | 1 skipped (387)')).toEqual({ passed: 386, failed: 0 });
    expect(parseTestCounts(' Tests  2 failed | 384 passed (386)')).toEqual({ passed: 384, failed: 2 });
    expect(parseTestCounts('=== 3 failed, 12 passed in 1.20s ===')).toEqual({ passed: 12, failed: 3 });
    expect(parseTestCounts('test result: ok. 7 passed; 0 failed; 0 ignored')).toEqual({ passed: 7, failed: 0 });
    expect(parseTestCounts('nothing recognisable')).toEqual({ passed: null, failed: null });
  });

  it('records agent runs of check commands, including failures, and skips other commands', () => {
    const base = { type: 'tool.call', name: 'run_command', timestamp: '2026-09-23T10:00:00.000Z' };
    const checks = agentChecksFromEvents([
      { ...base, status: 'failed', input: { command: 'npm test' }, output: { exitCode: 1, stdout: ' Tests  1 failed | 2 passed (3)', stderr: '' } },
      { ...base, status: 'completed', input: { command: 'npm run build' }, output: { exitCode: 0, stdout: '' } },
      { ...base, status: 'completed', input: { command: 'pytest' }, output: { exitCode: 0, stdout: '' } },
      { ...base, status: 'started', input: { command: 'npm test' } },
      { ...base, status: 'completed', input: { command: 'npm test' }, output: {} },
    ]);
    expect(checks.map((check) => [check.command, check.exitCode, check.source])).toEqual([['npm test', 1, 'agent'], ['pytest', 0, 'agent']]);
    expect(parseTestCounts(checks[0]!.output)).toEqual({ passed: 2, failed: 1 });
  });

  it('suggests a test command from the project manifest', async () => {
    const node = await temporary();
    await fs.writeFile(path.join(node, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    expect(await suggestTestCommand(node)).toBe('npm test');
    const rust = await temporary();
    await fs.writeFile(path.join(rust, 'Cargo.toml'), '[package]');
    expect(await suggestTestCommand(rust)).toBe('cargo test');
    expect(await suggestTestCommand(await temporary())).toBeNull();
  });

  it('finds the check of a project split into parts when the root has none', async () => {
    const split = await temporary();
    await fs.mkdir(path.join(split, 'frontend'));
    await fs.mkdir(path.join(split, 'backend'));
    await fs.writeFile(path.join(split, 'frontend', 'package.json'), JSON.stringify({ scripts: { dev: 'vite', build: 'vite build', typecheck: 'tsc --noEmit' } }));
    expect(await suggestTestCommand(split)).toBe('npm --prefix frontend run typecheck');
    // A part with its own tests is checked by them, and every part's check has to pass.
    await fs.writeFile(path.join(split, 'backend', 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    expect(await suggestTestCommand(split)).toBe('npm --prefix frontend run typecheck && npm --prefix backend test');
    // A part with nothing that checks anything gives no command.
    const bare = await temporary();
    await fs.mkdir(path.join(bare, 'frontend'));
    await fs.writeFile(path.join(bare, 'frontend', 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    expect(await suggestTestCommand(bare)).toBeNull();
  });
});
