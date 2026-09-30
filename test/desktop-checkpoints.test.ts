import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCheckpoint,
  diffFromCheckpoint,
  restoreCheckpoint,
  restoreCheckpointFile,
} from '../apps/desktop/src/main/checkpoints';

vi.setConfig({ testTimeout: 90_000 });

const execFileAsync = promisify(execFile);
const git = async (cwd: string, args: string[]): Promise<string> => (await execFileAsync('git', args, { cwd })).stdout;

describe('desktop checkpoints', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'kai-desktop-checkpoint-')));
    await git(repo, ['init', '-q']);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'KAI Test']);
    await fs.writeFile(path.join(repo, 'a.ts'), 'export const a = 1;\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-q', '-m', 'init']);
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('restores an untracked file the agent edited, which a stash snapshot could not', async () => {
    await fs.writeFile(path.join(repo, 'notes.md'), 'draft\n');
    const checkpoint = await createCheckpoint(repo);
    await fs.writeFile(path.join(repo, 'notes.md'), 'draft\nagent edit\n');

    expect(await diffFromCheckpoint(repo, checkpoint)).toEqual([{ path: 'notes.md', added: 1, removed: 0 }]);
    await restoreCheckpoint(repo, checkpoint);

    expect(await fs.readFile(path.join(repo, 'notes.md'), 'utf8')).toBe('draft\n');
  });

  it('restores binary bytes exactly, and brings back deleted files', async () => {
    const bytes = Buffer.from([0, 255, 128, 10, 13, 0, 7]);
    await fs.writeFile(path.join(repo, 'logo.bin'), bytes);
    const checkpoint = await createCheckpoint(repo);
    await fs.writeFile(path.join(repo, 'logo.bin'), Buffer.from([1, 2, 3]));
    await fs.rm(path.join(repo, 'a.ts'));

    const result = await restoreCheckpoint(repo, checkpoint);

    expect([...result.restored].sort()).toEqual(['a.ts', 'logo.bin']);
    expect(await fs.readFile(path.join(repo, 'logo.bin'))).toEqual(bytes);
    expect(await fs.readFile(path.join(repo, 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
  });

  it('deletes files created after the checkpoint and can restore a single file', async () => {
    const checkpoint = await createCheckpoint(repo);
    await fs.writeFile(path.join(repo, 'new.ts'), 'export const n = 1;\n');
    await fs.writeFile(path.join(repo, 'a.ts'), 'export const a = 2;\n');

    expect(await restoreCheckpointFile(repo, checkpoint, 'new.ts')).toEqual({ restored: [], deleted: ['new.ts'] });
    await expect(fs.access(path.join(repo, 'new.ts'))).rejects.toThrow();
    expect(await fs.readFile(path.join(repo, 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
  });

  it('does not disturb the real index or report unchanged files', async () => {
    await fs.writeFile(path.join(repo, 'staged.ts'), 'x\n');
    await git(repo, ['add', 'staged.ts']);
    const before = await git(repo, ['status', '--porcelain=v1']);

    const checkpoint = await createCheckpoint(repo);

    expect(await git(repo, ['status', '--porcelain=v1'])).toBe(before);
    expect(await diffFromCheckpoint(repo, checkpoint)).toEqual([]);
  });
});
