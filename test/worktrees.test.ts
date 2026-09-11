import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  createCompareWorktree,
  removeCompareWorktree,
  worktreeChanges,
  worktreeDiffPatch,
  applyWorktreePatch,
} from '../src/orchestrator/worktrees';

const execFileAsync = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

describe('compare worktrees', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-worktree-test-'));
    await git(repo, ['init', '-q']);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'KAI Test']);
    await fs.writeFile(path.join(repo, 'a.ts'), 'export const a = 1;\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-q', '-m', 'init']);
  }, 15000);

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('creates an independent worktree checked out from HEAD', async () => {
    const wt = await createCompareWorktree(repo, 'left');
    try {
      const content = await fs.readFile(path.join(wt, 'a.ts'), 'utf8');
      expect(content).toBe('export const a = 1;\n');
      expect(await worktreeChanges(wt)).toEqual([]);
    } finally {
      await removeCompareWorktree(repo, wt);
    }
  }, 20000);

  it('edits in one worktree never appear in another or in the main repo', async () => {
    const left = await createCompareWorktree(repo, 'left');
    const right = await createCompareWorktree(repo, 'right');
    try {
      await fs.writeFile(path.join(left, 'a.ts'), 'export const a = 2;\n');
      expect(await fs.readFile(path.join(right, 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
      expect(await fs.readFile(path.join(repo, 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
    } finally {
      await removeCompareWorktree(repo, left);
      await removeCompareWorktree(repo, right);
    }
  }, 25000);

  it('reports changed and new files in a worktree', async () => {
    const wt = await createCompareWorktree(repo, 'left');
    try {
      await fs.writeFile(path.join(wt, 'a.ts'), 'export const a = 2;\n');
      await fs.writeFile(path.join(wt, 'b.ts'), 'export const b = 1;\n');
      const changes = await worktreeChanges(wt);
      expect(changes.map((c) => c.path).sort()).toEqual(['a.ts', 'b.ts']);
    } finally {
      await removeCompareWorktree(repo, wt);
    }
  }, 20000);

  it('generates a patch (including new files) that applies cleanly onto the main repo', async () => {
    const wt = await createCompareWorktree(repo, 'left');
    try {
      await fs.writeFile(path.join(wt, 'a.ts'), 'export const a = 2;\n');
      await fs.writeFile(path.join(wt, 'b.ts'), 'export const b = 1;\n');
      const patch = await worktreeDiffPatch(wt);
      expect(patch).toContain('a.ts');
      expect(patch).toContain('b.ts');

      await applyWorktreePatch(repo, patch);
      expect(await fs.readFile(path.join(repo, 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
      expect(await fs.readFile(path.join(repo, 'b.ts'), 'utf8')).toBe('export const b = 1;\n');
    } finally {
      await removeCompareWorktree(repo, wt);
    }
  }, 20000);

  it('applying an empty patch (no changes) is a safe no-op', async () => {
    await applyWorktreePatch(repo, '');
    expect(await fs.readFile(path.join(repo, 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
  });

  it('removeCompareWorktree cleans up the directory', async () => {
    const wt = await createCompareWorktree(repo, 'left');
    await removeCompareWorktree(repo, wt);
    await expect(fs.access(wt)).rejects.toThrow();
    const list = await git(repo, ['worktree', 'list']);
    expect(list).not.toContain(wt);
  }, 20000);
});
