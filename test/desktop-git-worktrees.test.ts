import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addWorktree,
  applyToWorkingTree,
  changedFiles,
  commitWorktree,
  mergeCommit,
  removeWorktree,
  repositoryFor,
  snapshotWorkingTree,
} from '../apps/desktop/src/main/git-worktrees';

// Every test here runs real git, which is slow on Windows when the whole suite is running.
vi.setConfig({ testTimeout: 120_000 });

const run = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.test', '-c', 'core.autocrlf=false', ...args], { cwd })).stdout;
}

async function temporary(label: string): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), `kai-wt-${label}-`)));
  directories.push(directory);
  return directory;
}

/** A repository with two committed files and an ignore rule. */
async function repository(): Promise<string> {
  const root = await temporary('repo');
  await git(root, 'init', '-q');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'ui.ts'), 'export const ui = 1;\n');
  await writeFile(path.join(root, 'src', 'api.ts'), 'export const api = 1;\n');
  await writeFile(path.join(root, 'shared.ts'), 'line one\nline two\nline three\n');
  await writeFile(path.join(root, '.gitignore'), 'ignored.log\nnode_modules\n');
  await git(root, 'add', '-A');
  await git(root, 'commit', '-q', '-m', 'initial');
  return root;
}

const read = (...parts: string[]): Promise<string> => readFile(path.join(...parts), 'utf8');
const exists = (target: string): Promise<boolean> => access(target).then(() => true, () => false);

describe('git worktrees for parallel parts', () => {
  it('finds the repository a project lives in, including a subfolder of a bigger one, and refuses anything else', async () => {
    const plain = await temporary('plain');
    expect(await repositoryFor(plain)).toBeNull();

    const empty = await temporary('empty');
    await git(empty, 'init', '-q');
    expect(await repositoryFor(empty)).toBeNull();

    const root = await repository();
    expect(await repositoryFor(root)).toEqual({ root, prefix: '' });
    const sub = path.join(root, 'apps', 'site');
    await mkdir(sub, { recursive: true });
    expect(await repositoryFor(sub)).toEqual({ root, prefix: 'apps/site' });
  });

  it('snapshots the working tree as it is, with new files and without ignored ones, and changes nothing of the user\'s', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'src', 'ui.ts'), 'export const ui = 2; // edited, not committed\n');
    await writeFile(path.join(root, 'notes.md'), 'a new file nobody added to git\n');
    await writeFile(path.join(root, 'ignored.log'), 'noise\n');
    await git(root, 'add', 'src/api.ts'); // an index the snapshot must leave alone
    const before = { status: await git(root, 'status', '--porcelain'), head: await git(root, 'rev-parse', 'HEAD'), branches: await git(root, 'branch') };

    const snapshot = await snapshotWorkingTree(root);

    expect(await git(root, 'show', `${snapshot}:src/ui.ts`)).toContain('edited, not committed');
    expect(await git(root, 'show', `${snapshot}:notes.md`)).toContain('a new file');
    await expect(git(root, 'show', `${snapshot}:ignored.log`)).rejects.toThrow();
    expect(await git(root, 'status', '--porcelain')).toBe(before.status);
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(before.head);
    expect(await git(root, 'branch')).toBe(before.branches);
    expect((await git(root, 'log', '-1', '--format=%s', snapshot)).trim()).toContain('KAI snapshot');
  });

  it('runs two parts in separate copies, merges them, and copies the result into the real project', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'notes.md'), 'uncommitted notes\n');
    const base = await snapshotWorkingTree(root);
    const work = await temporary('work');

    // Each part starts from the snapshot, so it sees the user's uncommitted file too.
    const ui = path.join(work, 'ui');
    const api = path.join(work, 'api');
    await addWorktree(root, ui, base);
    await addWorktree(root, api, base);
    expect(await read(ui, 'notes.md')).toBe('uncommitted notes\n');
    await writeFile(path.join(ui, 'src', 'ui.ts'), 'export const ui = 2;\n');
    await writeFile(path.join(ui, 'src', 'new-form.ts'), 'export const form = true;\n');
    await writeFile(path.join(api, 'src', 'api.ts'), 'export const api = 2;\n');
    await rm(path.join(api, 'shared.ts'));
    // The real project is untouched while the parts work.
    expect(await read(root, 'src', 'ui.ts')).toBe('export const ui = 1;\n');

    const uiCommit = await commitWorktree(ui, 'ui');
    const apiCommit = await commitWorktree(api, 'api');
    expect(uiCommit).not.toBe(base);

    const integration = path.join(work, 'integration');
    await addWorktree(root, integration, base);
    expect(await mergeCommit(integration, uiCommit, 'merge ui')).toEqual({ ok: true });
    expect(await mergeCommit(integration, apiCommit, 'merge api')).toEqual({ ok: true });
    const head = (await git(integration, 'rev-parse', 'HEAD')).trim();
    const changes = await changedFiles(integration, base, head);
    expect(changes).toEqual(expect.arrayContaining([
      { status: 'modified', file: 'src/ui.ts' },
      { status: 'added', file: 'src/new-form.ts' },
      { status: 'modified', file: 'src/api.ts' },
      { status: 'deleted', file: 'shared.ts' },
    ]));

    const result = await applyToWorkingTree(root, base, integration, changes);

    expect(result.skipped).toEqual([]);
    expect(await read(root, 'src', 'ui.ts')).toBe('export const ui = 2;\n');
    expect(await read(root, 'src', 'new-form.ts')).toContain('form = true');
    expect(await read(root, 'src', 'api.ts')).toBe('export const api = 2;\n');
    expect(await exists(path.join(root, 'shared.ts'))).toBe(false);
    expect(await read(root, 'notes.md')).toBe('uncommitted notes\n');
    // Nothing was committed to the user's branch.
    expect((await git(root, 'log', '--oneline')).trim().split('\n')).toHaveLength(1);
  });

  it('reports a conflict between two parts and leaves the integration checkout clean', async () => {
    const root = await repository();
    const base = await snapshotWorkingTree(root);
    const work = await temporary('work');
    const first = path.join(work, 'first');
    const second = path.join(work, 'second');
    await addWorktree(root, first, base);
    await addWorktree(root, second, base);
    await writeFile(path.join(first, 'shared.ts'), 'line one\nFIRST\nline three\n');
    await writeFile(path.join(second, 'shared.ts'), 'line one\nSECOND\nline three\n');
    await writeFile(path.join(second, 'src', 'api.ts'), 'export const api = 3;\n');
    const firstCommit = await commitWorktree(first, 'first');
    const secondCommit = await commitWorktree(second, 'second');

    const integration = path.join(work, 'integration');
    await addWorktree(root, integration, base);
    expect(await mergeCommit(integration, firstCommit, 'merge first')).toEqual({ ok: true });
    const afterFirst = (await git(integration, 'rev-parse', 'HEAD')).trim();
    const conflict = await mergeCommit(integration, secondCommit, 'merge second');

    expect(conflict).toEqual({ ok: false, files: ['shared.ts'] });
    // The failed merge was undone: nothing half merged, and the first part's work is intact.
    expect((await git(integration, 'rev-parse', 'HEAD')).trim()).toBe(afterFirst);
    expect((await git(integration, 'status', '--porcelain')).trim()).toBe('');
    expect(await read(integration, 'shared.ts')).toContain('FIRST');
    expect(await read(integration, 'src', 'api.ts')).toBe('export const api = 1;\n');
  });

  it('never overwrites something the user changed after the snapshot', async () => {
    const root = await repository();
    const base = await snapshotWorkingTree(root);
    const work = await temporary('work');
    const part = path.join(work, 'part');
    await addWorktree(root, part, base);
    await writeFile(path.join(part, 'src', 'ui.ts'), 'export const ui = "from the part";\n');
    await writeFile(path.join(part, 'src', 'api.ts'), 'export const api = "from the part";\n');
    await writeFile(path.join(part, 'brand-new.ts'), 'new\n');
    await rm(path.join(part, 'shared.ts'));
    const commit = await commitWorktree(part, 'part');

    const integration = path.join(work, 'integration');
    await addWorktree(root, integration, base);
    await mergeCommit(integration, commit, 'merge');
    const changes = await changedFiles(integration, base, (await git(integration, 'rev-parse', 'HEAD')).trim());

    // While the part worked, the user edited one file, edited another the same way, deleted one and added a clash.
    await writeFile(path.join(root, 'src', 'ui.ts'), 'export const ui = "the user was here";\n');
    await writeFile(path.join(root, 'src', 'api.ts'), 'export const api = "from the part";\n');
    await writeFile(path.join(root, 'shared.ts'), 'the user rewrote this\n');
    await writeFile(path.join(root, 'brand-new.ts'), 'the user made this file too\n');

    const result = await applyToWorkingTree(root, base, integration, changes);

    expect(result.skipped.sort()).toEqual(['brand-new.ts', 'shared.ts', 'src/ui.ts']);
    expect(result.applied).toEqual(['src/api.ts']);
    expect(await read(root, 'src', 'ui.ts')).toContain('the user was here');
    expect(await read(root, 'shared.ts')).toBe('the user rewrote this\n');
    expect(await read(root, 'brand-new.ts')).toBe('the user made this file too\n');
  });

  it('returns the starting commit when a part changed nothing, and merges that as a no-op', async () => {
    const root = await repository();
    const base = await snapshotWorkingTree(root);
    const work = await temporary('work');
    const idle = path.join(work, 'idle');
    await addWorktree(root, idle, base);

    expect(await commitWorktree(idle, 'idle')).toBe(base);
    const integration = path.join(work, 'integration');
    await addWorktree(root, integration, base);
    expect(await mergeCommit(integration, base, 'merge idle')).toEqual({ ok: true });
    expect(await changedFiles(integration, base, (await git(integration, 'rev-parse', 'HEAD')).trim())).toEqual([]);
  });

  it('removes a worktree without ever reaching into the linked node_modules', async () => {
    const root = await repository();
    const dependencies = path.join(root, 'node_modules', 'left-pad');
    await mkdir(dependencies, { recursive: true });
    await writeFile(path.join(dependencies, 'index.js'), 'module.exports = 1;\n');
    const base = await snapshotWorkingTree(root);
    const work = await temporary('work');
    const part = path.join(work, 'part');
    await addWorktree(root, part, base);

    // The checkout can use the project's installed packages...
    expect(await read(part, 'node_modules', 'left-pad', 'index.js')).toContain('module.exports');
    await removeWorktree(root, part);

    // ...and removing it left those packages exactly where they were.
    expect(await exists(path.join(dependencies, 'index.js'))).toBe(true);
    expect(await exists(part)).toBe(false);
    expect(await git(root, 'worktree', 'list')).not.toContain('part');
  });

  it('never commits the linked node_modules, even when .gitignore only matches the folder form', async () => {
    const root = await repository();
    await writeFile(path.join(root, '.gitignore'), 'node_modules/\n');
    await git(root, 'commit', '-q', '-am', 'folder-form ignore');
    await mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true });
    await writeFile(path.join(root, 'node_modules', 'dep', 'index.js'), 'x\n');
    const base = await snapshotWorkingTree(root);
    const part = path.join(await temporary('work'), 'part');
    await addWorktree(root, part, base);
    await writeFile(path.join(part, 'src', 'ui.ts'), 'export const ui = 9;\n');

    const commit = await commitWorktree(part, 'part');

    expect((await git(part, 'show', '--name-only', '--format=', commit)).trim()).toBe('src/ui.ts');
    await removeWorktree(root, part);
    expect(await exists(path.join(root, 'node_modules', 'dep', 'index.js'))).toBe(true);
  });

  it('leaves a project that tracks its own node_modules alone', async () => {
    const root = await repository();
    await mkdir(path.join(root, 'node_modules', 'tracked'), { recursive: true });
    await writeFile(path.join(root, 'node_modules', 'tracked', 'a.js'), 'x\n');
    await git(root, 'add', '-A', '-f');
    await git(root, 'commit', '-q', '-m', 'track deps');
    const base = await snapshotWorkingTree(root);
    const part = path.join(await temporary('work'), 'part');

    await addWorktree(root, part, base);

    expect(await read(part, 'node_modules', 'tracked', 'a.js')).toBe('x\n');
    await removeWorktree(root, part);
    expect(await exists(path.join(root, 'node_modules', 'tracked', 'a.js'))).toBe(true);
  });

  it('keeps a symlinked-from-elsewhere dependency folder from being deleted when its worktree goes', async () => {
    const root = await repository();
    const elsewhere = await temporary('elsewhere');
    await writeFile(path.join(elsewhere, 'keep.txt'), 'still here\n');
    const base = await snapshotWorkingTree(root);
    const part = path.join(await temporary('work'), 'part');
    await addWorktree(root, part, base, false);
    await symlink(elsewhere, path.join(part, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');

    await removeWorktree(root, part);

    expect(await exists(path.join(elsewhere, 'keep.txt'))).toBe(true);
  });
});
