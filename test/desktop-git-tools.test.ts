import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gitBranchNameSchema } from '../packages/contracts/src';
import {
  GitCommandError,
  gitCheckout,
  gitCommit,
  gitCreateBranch,
  gitDiffFile,
  gitOverview,
  gitStage,
  gitSync,
  parseBranches,
  parseGithubRepository,
  parseStatus,
} from '../apps/desktop/src/main/git-tools';

// Every step starts a git process, which is slow on Windows, so these tests get a generous limit.
vi.setConfig({ testTimeout: 90_000 });

const directories: string[] = [];

async function temporary(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-git-'));
  directories.push(directory);
  return directory;
}

const identity = ['-c', 'user.email=kai@example.test', '-c', 'user.name=KAI Test'];
function run(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...identity, ...args], { cwd, encoding: 'utf8' });
}

async function repository(): Promise<string> {
  const root = await temporary();
  run(root, 'init', '-q', '-b', 'main');
  // The commit helper uses the repository's own identity, exactly as a real user's would be configured.
  run(root, 'config', 'user.email', 'kai@example.test');
  run(root, 'config', 'user.name', 'KAI Test');
  await fs.writeFile(path.join(root, 'a.txt'), 'one\n');
  run(root, 'add', '-A');
  run(root, 'commit', '-q', '-m', 'first');
  return root;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })));
});

describe('parsing', () => {
  it('recognises GitHub remotes in https and ssh form and rejects others', () => {
    expect(parseGithubRepository('https://github.com/King-odysseus/KAi.git')).toBe('King-odysseus/KAi');
    expect(parseGithubRepository('git@github.com:owner/repo.git')).toBe('owner/repo');
    expect(parseGithubRepository('https://github.com/owner/repo')).toBe('owner/repo');
    expect(parseGithubRepository('https://gitlab.com/owner/repo.git')).toBeNull();
    expect(parseGithubRepository('')).toBeNull();
  });

  it('parses porcelain status including renames, untracked and partly staged files', () => {
    const changes = parseStatus(['M  staged.ts', ' M edited.ts', 'MM both.ts', '?? new.ts', 'R  renamed.ts', 'old.ts', 'D  gone.ts', ''].join('\0'));
    expect(changes.map((change) => [change.path, change.staged, change.unstaged])).toEqual([
      ['staged.ts', true, false],
      ['edited.ts', false, true],
      ['both.ts', true, true],
      ['new.ts', false, true],
      ['renamed.ts', true, false],
      ['gone.ts', true, false],
    ]);
  });

  it('parses branch listings', () => {
    expect(parseBranches('*\tmain\torigin/main\tfirst commit\n \tfeature/x\t\twork in progress\n')).toEqual([
      { name: 'main', current: true, upstream: 'origin/main', subject: 'first commit' },
      { name: 'feature/x', current: false, upstream: null, subject: 'work in progress' },
    ]);
  });

  it('accepts ordinary branch names and refuses anything that could act as a git option', () => {
    for (const name of ['main', 'feature/login', 'fix-123', 'release_1.2']) expect(gitBranchNameSchema.safeParse(name).success, name).toBe(true);
    for (const name of ['', '-D', '--force', '--upload-pack=evil', 'a..b', 'a b', 'topic/', 'x.lock', 'a//b', 'x;y']) {
      expect(gitBranchNameSchema.safeParse(name).success, name).toBe(false);
    }
  });
});

describe('overview, staging and commits', () => {
  it('reports a non-repository without failing', async () => {
    const overview = await gitOverview(await temporary());
    expect(overview).toMatchObject({ isRepository: false, branch: null, changes: [], branches: [] });
  });

  it('lists branch, changes and history for a repository', async () => {
    const root = await repository();
    await fs.writeFile(path.join(root, 'a.txt'), 'one\ntwo\n');
    await fs.writeFile(path.join(root, 'b.txt'), 'new\n');
    const overview = await gitOverview(root);
    expect(overview).toMatchObject({ isRepository: true, branch: 'main', detached: false, upstream: null, githubRepository: null });
    expect(overview.branches).toEqual([expect.objectContaining({ name: 'main', current: true })]);
    expect(overview.changes.map((change) => change.path).sort()).toEqual(['a.txt', 'b.txt']);
    expect(overview.commits[0]).toMatchObject({ subject: 'first', author: 'KAI Test' });
  });

  it('stages, commits only what is staged, and refuses an empty commit', async () => {
    const root = await repository();
    await fs.writeFile(path.join(root, 'a.txt'), 'changed\n');
    await fs.writeFile(path.join(root, 'b.txt'), 'other\n');

    await expect(gitCommit(root, 'nothing staged')).rejects.toThrow(/Nothing is staged/);
    await gitStage(root, ['a.txt'], true);
    expect((await gitOverview(root)).changes.find((change) => change.path === 'a.txt')?.staged).toBe(true);

    await gitCommit(root, 'Change a');
    const after = await gitOverview(root);
    expect(after.commits[0]?.subject).toBe('Change a');
    expect(after.changes.map((change) => change.path)).toEqual(['b.txt']);

    await gitStage(root, ['b.txt'], true);
    await gitStage(root, ['b.txt'], false);
    expect((await gitOverview(root)).changes[0]).toMatchObject({ path: 'b.txt', staged: false });
  });

  it('treats a file name that looks like an option as a file', async () => {
    const root = await repository();
    await fs.writeFile(path.join(root, '--all'), 'x');
    await gitStage(root, ['--all'], true);
    const change = (await gitOverview(root)).changes.find((item) => item.path === '--all');
    expect(change?.staged).toBe(true);
  });

  it('shows a diff for modified and brand-new files', async () => {
    const root = await repository();
    await fs.writeFile(path.join(root, 'a.txt'), 'one\ntwo\n');
    await fs.writeFile(path.join(root, 'new.txt'), 'fresh\n');
    expect((await gitDiffFile(root, 'a.txt', false)).output).toContain('+two');
    expect((await gitDiffFile(root, 'new.txt', false)).output).toContain('+fresh');
  });
});

describe('branches', () => {
  it('creates, switches and lists branches, and validates names before touching git', async () => {
    const root = await repository();
    await gitCreateBranch(root, 'feature/login', true);
    let overview = await gitOverview(root);
    expect(overview.branch).toBe('feature/login');
    expect(overview.branches.map((branch) => branch.name).sort()).toEqual(['feature/login', 'main']);

    await gitCheckout(root, 'main');
    overview = await gitOverview(root);
    expect(overview.branch).toBe('main');

    await expect(gitCheckout(root, '--orphan')).rejects.toThrow();
    await expect(gitCreateBranch(root, '-D', false)).rejects.toThrow();
    await expect(gitCheckout(root, 'no-such-branch')).rejects.toBeInstanceOf(GitCommandError);
  });

  it('refuses to switch branches when local changes would be overwritten', async () => {
    const root = await repository();
    await gitCreateBranch(root, 'other', true);
    await fs.writeFile(path.join(root, 'a.txt'), 'other branch\n');
    run(root, 'commit', '-qam', 'diverge');
    await gitCheckout(root, 'main');
    await fs.writeFile(path.join(root, 'a.txt'), 'uncommitted\n');
    await expect(gitCheckout(root, 'other')).rejects.toThrow();
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('uncommitted\n');
  });
});

describe('push and pull', () => {
  async function withRemote() {
    const root = await repository();
    const remote = await temporary();
    run(remote, 'init', '-q', '--bare', '-b', 'main');
    run(root, 'remote', 'add', 'origin', remote);
    return { root, remote };
  }

  it('publishes a new branch with an upstream, then reports ahead and behind counts', async () => {
    const { root, remote } = await withRemote();
    await gitSync(root, 'push');
    let overview = await gitOverview(root);
    expect(overview).toMatchObject({ upstream: 'origin/main', ahead: 0, behind: 0 });
    expect(run(remote, 'log', '--format=%s', '-1').trim()).toBe('first');

    await fs.writeFile(path.join(root, 'a.txt'), 'two\n');
    run(root, 'commit', '-qam', 'second');
    overview = await gitOverview(root);
    expect(overview.ahead).toBe(1);
    await gitSync(root, 'push');
    expect((await gitOverview(root)).ahead).toBe(0);
    expect(run(remote, 'log', '--format=%s', '-1').trim()).toBe('second');
  });

  it('fast-forwards on pull and refuses when histories have diverged, never rewriting anything', async () => {
    const { root, remote } = await withRemote();
    await gitSync(root, 'push');
    const other = await temporary();
    run(other, 'clone', '-q', remote, '.');
    run(other, 'config', 'user.email', 'o@example.test');
    run(other, 'config', 'user.name', 'Other');
    await fs.writeFile(path.join(other, 'b.txt'), 'from elsewhere\n');
    run(other, 'add', '-A');
    run(other, 'commit', '-qm', 'remote change');
    run(other, 'push', '-q');

    await gitSync(root, 'fetch');
    expect((await gitOverview(root)).behind).toBe(1);
    await gitSync(root, 'pull');
    // Git for Windows may check files out with CRLF (core.autocrlf), so compare the text, not the line endings.
    expect((await fs.readFile(path.join(root, 'b.txt'), 'utf8')).replace(/\r\n/g, '\n')).toBe('from elsewhere\n');

    // Now diverge: one commit on each side.
    await fs.writeFile(path.join(root, 'a.txt'), 'local\n');
    run(root, 'commit', '-qam', 'local change');
    await fs.writeFile(path.join(other, 'c.txt'), 'more\n');
    run(other, 'add', '-A');
    run(other, 'commit', '-qm', 'remote again');
    run(other, 'push', '-q');
    await gitSync(root, 'fetch');
    await expect(gitSync(root, 'pull')).rejects.toBeInstanceOf(GitCommandError);
    // The plain push is also rejected by the server; there is no force option to override it.
    await expect(gitSync(root, 'push')).rejects.toBeInstanceOf(GitCommandError);
    expect(run(remote, 'log', '--format=%s', '-1').trim()).toBe('remote again');
  });

  it('reports a clear failure when there is no remote to push to', async () => {
    const root = await repository();
    await expect(gitSync(root, 'push')).rejects.toBeInstanceOf(GitCommandError);
  });
});
