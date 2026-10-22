import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { planWaves } from '../packages/contracts/src';
import { createParallelSession } from '../apps/desktop/src/main/parallel-session';

vi.setConfig({ testTimeout: 180_000 });

const run = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })));
});

async function temporary(label: string): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), `kai-ps-${label}-`)));
  directories.push(directory);
  return directory;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.test', '-c', 'core.autocrlf=false', ...args], { cwd })).stdout;
}

const exists = (target: string): Promise<boolean> => access(target).then(() => true, () => false);

describe('planning waves', () => {
  const step = (id: string, ...dependsOn: string[]) => ({ id, dependsOn });

  it('puts independent steps together and each dependent step after what it needs', () => {
    const waves = planWaves([step('ui'), step('api'), step('tests', 'ui', 'api'), step('security', 'ui', 'api', 'tests'), step('review', 'ui', 'api', 'tests')]);
    expect(waves.map((wave) => wave.map((item) => item.id))).toEqual([['ui', 'api'], ['tests'], ['security', 'review']]);
  });

  it('treats a dependency that is not in the list as already done', () => {
    expect(planWaves([step('review', 'ui'), step('docs')]).map((wave) => wave.map((item) => item.id))).toEqual([['review', 'docs']]);
  });

  it('handles a dependency listed later, a chain, an empty list, and a loop without hanging', () => {
    expect(planWaves([step('b', 'a'), step('a')]).map((wave) => wave.map((item) => item.id))).toEqual([['a'], ['b']]);
    expect(planWaves([step('a'), step('b', 'a'), step('c', 'b')]).length).toBe(3);
    expect(planWaves([])).toEqual([]);
    const loop = planWaves([step('a', 'b'), step('b', 'a')]);
    expect(loop.flat().map((item) => item.id).sort()).toEqual(['a', 'b']);
  });
});

describe('a side-by-side session on a real repository', () => {
  async function repository(): Promise<string> {
    const root = await temporary('repo');
    await git(root, 'init', '-q');
    await mkdir(path.join(root, 'app', 'src'), { recursive: true });
    await writeFile(path.join(root, 'app', 'src', 'ui.ts'), 'export const ui = 1;\n');
    await writeFile(path.join(root, 'app', 'src', 'api.ts'), 'export const api = 1;\n');
    await writeFile(path.join(root, 'README.md'), '# root\n');
    await git(root, 'add', '-A');
    await git(root, 'commit', '-q', '-m', 'initial');
    return root;
  }

  it('gives each part a copy of a project that is a subfolder, merges both, and cleans up after itself', async () => {
    const root = await repository();
    const project = path.join(root, 'app');
    const base = await temporary('base');

    const session = await createParallelSession(project, 'wave-1', base);
    expect(session).not.toBeNull();
    const uiFolder = await session!.checkout('ui');
    const apiFolder = await session!.checkout('api');
    // The folder a part works in is the project folder inside its copy, not the repository root.
    expect(path.basename(uiFolder)).toBe('app');
    await writeFile(path.join(uiFolder, 'src', 'ui.ts'), 'export const ui = 2;\n');
    await writeFile(path.join(apiFolder, 'src', 'api.ts'), 'export const api = 2;\n');

    const result = await session!.integrate([
      { stepId: 'ui', commit: await session!.commit('ui', 'ui') },
      { stepId: 'api', commit: await session!.commit('api', 'api') },
    ]);

    expect(result.conflicts).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.applied.sort()).toEqual(['app/src/api.ts', 'app/src/ui.ts']);
    expect(await readFile(path.join(project, 'src', 'ui.ts'), 'utf8')).toBe('export const ui = 2;\n');
    expect(await readFile(path.join(project, 'src', 'api.ts'), 'utf8')).toBe('export const api = 2;\n');

    await session!.dispose();
    await session!.dispose();
    expect(await exists(path.join(base, 'wave-1'))).toBe(false);
    expect((await git(root, 'worktree', 'list')).trim().split('\n')).toHaveLength(1);
    // The user's history is untouched: the merge only reached the working tree.
    expect((await git(root, 'log', '--oneline')).trim().split('\n')).toHaveLength(1);
  });

  it('names the files a part changed, and none for a part that changed nothing', async () => {
    const root = await repository();
    const session = (await createParallelSession(root, 'wave-files', await temporary('base')))!;
    const edited = await session.checkout('edited');
    const idle = await session.checkout('idle');
    await writeFile(path.join(edited, 'app', 'src', 'ui.ts'), 'export const ui = 3;\n');
    await writeFile(path.join(edited, 'app', 'src', 'new.ts'), 'export const added = 1;\n');

    expect((await session.filesChanged(await session.commit('edited', 'edit'))).sort()).toEqual(['app/src/new.ts', 'app/src/ui.ts']);
    expect(await session.filesChanged(await session.commit('idle', 'nothing'))).toEqual([]);
    expect(idle).not.toBe(edited);
    await session.dispose();
  });

  it('reports a clash and applies only the part that merged', async () => {
    const root = await repository();
    const session = (await createParallelSession(root, 'wave-clash', await temporary('base')))!;
    const first = await session.checkout('first');
    const second = await session.checkout('second');
    await writeFile(path.join(first, 'app', 'src', 'ui.ts'), 'export const ui = "first";\n');
    await writeFile(path.join(second, 'app', 'src', 'ui.ts'), 'export const ui = "second";\n');

    try {
      const result = await session.integrate([
        { stepId: 'first', commit: await session.commit('first', 'first') },
        { stepId: 'second', commit: await session.commit('second', 'second') },
      ]);
      expect(result.conflicts).toEqual([expect.objectContaining({ stepId: 'second', files: ['app/src/ui.ts'] })]);
      expect(result.conflicts[0]?.diff).toContain('+export const ui = "second";');
      expect(result.conflicts[0]?.diff).not.toContain('+export const ui = "first";');
      expect(result.conflicts[0]?.commit).toMatch(/^[a-f0-9]{40}$/);
      expect(await readFile(path.join(root, 'app', 'src', 'ui.ts'), 'utf8')).toBe('export const ui = "first";\n');
    } finally {
      await session.dispose();
    }
  });

  it('starts from the uncommitted work in the project, and clears a crashed wave that used the same name', async () => {
    const root = await repository();
    const base = await temporary('base');
    await writeFile(path.join(root, 'app', 'src', 'ui.ts'), 'export const ui = "uncommitted";\n');
    const leftover = path.join(base, 'wave-again', 'stale');
    await mkdir(leftover, { recursive: true });
    await writeFile(path.join(leftover, 'junk.txt'), 'from a crash\n');

    const session = (await createParallelSession(root, 'wave-again', base))!;
    try {
      expect(await exists(leftover)).toBe(false);
      const copy = await session.checkout('part');
      expect(await readFile(path.join(copy, 'app', 'src', 'ui.ts'), 'utf8')).toBe('export const ui = "uncommitted";\n');
    } finally {
      await session.dispose();
    }
  });

  describe('when the project changed a file the part also changed', () => {
    const lines = (count: number): string => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n') + '\n';

    async function shared(): Promise<string> {
      const root = await temporary('shared');
      await git(root, 'init', '-q');
      await writeFile(path.join(root, 'styles.css'), lines(20));
      await git(root, 'add', '-A');
      await git(root, 'commit', '-q', '-m', 'initial');
      return root;
    }

    it('combines the two when they changed different lines, as git would', async () => {
      const root = await shared();
      const session = (await createParallelSession(root, 'wave-combine', await temporary('base')))!;
      const folder = await session.checkout('card');
      // The card adds at the end; meanwhile another card's work changed the top of the same file in the project.
      await writeFile(path.join(folder, 'styles.css'), lines(20) + '.card { color: blue; }\n');
      await writeFile(path.join(root, 'styles.css'), '.other { color: red; }\n' + lines(20));
      const result = await session.integrate([{ stepId: 'card', commit: await session.commit('card', 'card') }]);

      expect(result.skipped).toEqual([]);
      expect(result.merged).toEqual(['styles.css']);
      const text = await readFile(path.join(root, 'styles.css'), 'utf8');
      expect(text.startsWith('.other { color: red; }\n')).toBe(true);
      expect(text.endsWith('.card { color: blue; }\n')).toBe(true);
      await session.dispose();
    });

    it('leaves the project\'s version alone when both changed the same line', async () => {
      const root = await shared();
      const session = (await createParallelSession(root, 'wave-same-line', await temporary('base')))!;
      const folder = await session.checkout('card');
      await writeFile(path.join(folder, 'styles.css'), lines(20).replace('line 5\n', 'line five from the card\n'));
      await writeFile(path.join(root, 'styles.css'), lines(20).replace('line 5\n', 'line five from the project\n'));
      const result = await session.integrate([{ stepId: 'card', commit: await session.commit('card', 'card') }]);

      expect(result.skipped).toEqual(['styles.css']);
      expect(await readFile(path.join(root, 'styles.css'), 'utf8')).toContain('line five from the project');
      await session.dispose();
    });

    it('takes a merge back out exactly, new files included, so a card that failed its check leaves nothing behind', async () => {
      const root = await shared();
      const before = await readFile(path.join(root, 'styles.css'), 'utf8');
      const session = (await createParallelSession(root, 'wave-undo', await temporary('base')))!;
      const folder = await session.checkout('card');
      await writeFile(path.join(folder, 'styles.css'), before + '.card {}\n');
      await writeFile(path.join(folder, 'new.ts'), 'export const added = 1;\n');
      const result = await session.integrate([{ stepId: 'card', commit: await session.commit('card', 'card') }]);
      expect(await exists(path.join(root, 'new.ts'))).toBe(true);

      await result.undo!();
      expect(await readFile(path.join(root, 'styles.css'), 'utf8')).toBe(before);
      expect(await exists(path.join(root, 'new.ts'))).toBe(false);
      await session.dispose();
    });

    it('carries an earlier attempt into a fresh copy, on top of what the project holds now', async () => {
      const root = await shared();
      const first = (await createParallelSession(root, 'wave-first', await temporary('base')))!;
      const firstFolder = await first.checkout('card');
      await writeFile(path.join(firstFolder, 'styles.css'), lines(20) + '.card { color: blue; }\n');
      const earlier = await first.commit('card', 'first attempt');
      await first.dispose();

      // Another card's work reached the project in between.
      await writeFile(path.join(root, 'styles.css'), '.other {}\n' + lines(20));
      const second = (await createParallelSession(root, 'wave-second', await temporary('base')))!;
      const secondFolder = await second.checkout('card');
      expect(await second.carry!('card', earlier)).toBe(true);
      const text = await readFile(path.join(secondFolder, 'styles.css'), 'utf8');
      expect(text.startsWith('.other {}\n')).toBe(true);
      expect(text.endsWith('.card { color: blue; }\n')).toBe(true);
      await second.dispose();
    });
  });

  it('is not available for a folder that is not a git project', async () => {
    expect(await createParallelSession(await temporary('plain'), 'wave', await temporary('base'))).toBeNull();
  });
});
