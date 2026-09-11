import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  isGitRepo,
  createCheckpoint,
  diffFromCheckpoint,
  restoreCheckpoint,
  restoreFile,
  readFileAtCheckpoint,
} from '../src/orchestrator/checkpoints';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

describe('checkpoints', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-checkpoint-test-'));
    await git(repo, ['init', '-q']);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'KAI Test']);
    await fs.writeFile(path.join(repo, 'a.ts'), 'export const a = 1;\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-q', '-m', 'init']);
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it('detects a git repo and rejects a non-repo path', async () => {
    expect(await isGitRepo(repo)).toBe(true);
    const notRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-not-repo-'));
    try {
      expect(await isGitRepo(notRepo)).toBe(false);
    } finally {
      await fs.rm(notRepo, { recursive: true, force: true });
    }
  });

  it('reports no changes when nothing happened since the checkpoint', async () => {
    const cp = await createCheckpoint(repo);
    expect(await diffFromCheckpoint(repo, cp)).toEqual([]);
  });

  it('diffs a modified tracked file', async () => {
    const cp = await createCheckpoint(repo);
    await fs.writeFile(path.join(repo, 'a.ts'), 'export const a = 1;\nexport const b = 2;\n');
    const changes = await diffFromCheckpoint(repo, cp);
    expect(changes).toEqual([{ path: 'a.ts', added: 1, removed: 0 }]);
  });

  it('diffs a new untracked file as fully added', async () => {
    const cp = await createCheckpoint(repo);
    await fs.writeFile(path.join(repo, 'b.ts'), 'export const b = 2;\n');
    const changes = await diffFromCheckpoint(repo, cp);
    expect(changes.map((c) => c.path)).toContain('b.ts');
  });

  it('restores a modified file to its checkpoint content', async () => {
    const cp = await createCheckpoint(repo);
    await fs.writeFile(path.join(repo, 'a.ts'), 'CORRUPTED');
    const result = await restoreCheckpoint(repo, cp);
    expect(result.restored).toEqual(['a.ts']);
    const content = await fs.readFile(path.join(repo, 'a.ts'), 'utf8');
    expect(content).toBe('export const a = 1;\n');
  });

  it('deletes a file the agent created since the checkpoint', async () => {
    const cp = await createCheckpoint(repo);
    await fs.writeFile(path.join(repo, 'new-file.ts'), 'export const created = true;\n');
    const result = await restoreCheckpoint(repo, cp);
    expect(result.deleted).toEqual(['new-file.ts']);
    await expect(fs.access(path.join(repo, 'new-file.ts'))).rejects.toThrow();
  });

  it('never touches a file outside the diff', async () => {
    const cp = await createCheckpoint(repo);
    await fs.writeFile(path.join(repo, 'a.ts'), 'CORRUPTED');
    await fs.writeFile(path.join(repo, 'untouched.ts'), 'export const untouched = true;\n');
    // untouched.ts existed as untracked when the checkpoint was made? No —
    // it's created after, so restoreCheckpoint would only leave it alone if
    // we don't ask it to restore everything blindly. Since it's a new file
    // not part of this test's diff scope check, confirm restoreFile (the
    // single-file variant) leaves other files untouched.
    await restoreFile(repo, cp, 'a.ts');
    const untouchedContent = await fs.readFile(path.join(repo, 'untouched.ts'), 'utf8');
    expect(untouchedContent).toBe('export const untouched = true;\n');
    const aContent = await fs.readFile(path.join(repo, 'a.ts'), 'utf8');
    expect(aContent).toBe('export const a = 1;\n');
  });

  it('reads a file\'s content as of the checkpoint', async () => {
    const cp = await createCheckpoint(repo);
    await fs.writeFile(path.join(repo, 'a.ts'), 'CHANGED');
    expect(await readFileAtCheckpoint(repo, cp, 'a.ts')).toBe('export const a = 1;\n');
  });

  it('reads empty content for a file that did not exist at checkpoint time', async () => {
    const cp = await createCheckpoint(repo);
    await fs.writeFile(path.join(repo, 'brand-new.ts'), 'x');
    expect(await readFileAtCheckpoint(repo, cp, 'brand-new.ts')).toBe('');
  });
});
