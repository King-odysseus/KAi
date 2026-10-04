import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { brainPathInsideRepository } from '../apps/desktop/src/main/service-controller';

/**
 * Where the brain folder may live.
 *
 * The engine pulls with rebase and autostash on a timer, and commits and pushes what it writes. Pointed at a folder
 * inside somebody's repository it does all of that to *their* repository — their branch, their origin. The default
 * path is KAI's own engines folder, so this only fires on a path chosen by hand, and the settings screen refuses it.
 */
describe('a brain path inside a repository', () => {
  const created: string[] = [];

  afterEach(async () => {
    await Promise.all(created.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
  });

  async function makeTree(structure: Record<string, string>): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-brain-path-'));
    created.push(root);
    for (const [relative, contents] of Object.entries(structure)) {
      const target = path.join(root, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (contents === 'dir') await fs.mkdir(target, { recursive: true });
      else await fs.writeFile(target, contents, 'utf8');
    }
    // Windows hands back the 8.3 short form of a temp path ("MEGA-M~1"), which will never equal the long form. Every
    // path in these cases is canonicalised so the comparisons are about the repository, not about the spelling.
    return fs.realpath(root);
  }

  it('finds the repository above a path, however deep it is', async () => {
    const root = await makeTree({ '.git/HEAD': 'ref: refs/heads/main\n', 'work/brain/learned/bugs.md': '' });

    expect(await brainPathInsideRepository(path.join(root, 'work', 'brain'))).toBe(root);
  });

  it('treats a .git file the same as a directory, which is what a worktree or submodule has', async () => {
    const root = await makeTree({ '.git': 'gitdir: /somewhere/else\n', 'brain': 'dir' });

    expect(await brainPathInsideRepository(path.join(root, 'brain'))).toBe(root);
  });

  it('says nothing about a path with no repository above it', async () => {
    const root = await makeTree({ 'brain/learned/bugs.md': '' });

    expect(await brainPathInsideRepository(path.join(root, 'brain'))).toBeNull();
  });

  it('does not mistake a folder that merely starts with .git for a repository', async () => {
    const root = await makeTree({ '.gitignore': 'node_modules\n', 'brain': 'dir' });

    expect(await brainPathInsideRepository(path.join(root, 'brain'))).toBeNull();
  });
});
