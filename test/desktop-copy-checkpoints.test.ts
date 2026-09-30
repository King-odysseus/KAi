import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createProjectCheckpoint,
  diffFromCheckpoint,
  readFileAtCheckpoint,
  restoreCheckpoint,
  restoreCheckpointFile,
  textDiffFromCheckpoint,
} from '../apps/desktop/src/main/checkpoints';
import { configureCopyCheckpoints } from '../apps/desktop/src/main/copy-checkpoints';

describe('checkpoints for a folder that is not a Git repository', () => {
  let project: string;
  let store: string;

  beforeEach(async () => {
    project = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-plain-'));
    store = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-plain-store-'));
    configureCopyCheckpoints(store);
    await fs.mkdir(path.join(project, 'src'), { recursive: true });
    await fs.mkdir(path.join(project, 'node_modules', 'dep'), { recursive: true });
    await fs.writeFile(path.join(project, 'src', 'a.txt'), 'one\ntwo\n');
    await fs.writeFile(path.join(project, 'keep.txt'), 'keep\n');
    await fs.writeFile(path.join(project, 'node_modules', 'dep', 'x.js'), 'ignored');
  });

  afterEach(async () => {
    await fs.rm(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    await fs.rm(store, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('reports edits, new files and deletions, and ignores dependency folders', async () => {
    const checkpoint = await createProjectCheckpoint(project);
    expect(checkpoint?.ref.startsWith('copy:')).toBe(true);
    expect(await diffFromCheckpoint(project, checkpoint!)).toEqual([]);

    await fs.writeFile(path.join(project, 'src', 'a.txt'), 'one\nthree\nfour\n');
    await fs.writeFile(path.join(project, 'new.txt'), 'fresh\n');
    await fs.rm(path.join(project, 'keep.txt'));
    await fs.writeFile(path.join(project, 'node_modules', 'dep', 'x.js'), 'changed but ignored');

    expect(await diffFromCheckpoint(project, checkpoint!)).toEqual([
      { path: 'keep.txt', added: 0, removed: 1 },
      { path: 'new.txt', added: 1, removed: 0 },
      { path: 'src/a.txt', added: 2, removed: 1 },
    ]);
  });

  it('restores everything, and one file at a time', async () => {
    const checkpoint = (await createProjectCheckpoint(project))!;
    await fs.writeFile(path.join(project, 'src', 'a.txt'), 'changed\n');
    await fs.writeFile(path.join(project, 'new.txt'), 'fresh\n');
    await fs.rm(path.join(project, 'keep.txt'));

    expect(await restoreCheckpointFile(project, checkpoint, 'new.txt')).toEqual({ restored: [], deleted: ['new.txt'] });
    const result = await restoreCheckpoint(project, checkpoint);

    expect([...result.restored].sort()).toEqual(['keep.txt', 'src/a.txt']);
    expect(await fs.readFile(path.join(project, 'src', 'a.txt'), 'utf8')).toBe('one\ntwo\n');
    expect(await fs.readFile(path.join(project, 'keep.txt'), 'utf8')).toBe('keep\n');
    await expect(fs.access(path.join(project, 'new.txt'))).rejects.toThrow();
  });

  it('reads the earlier content for review and offers no text diff', async () => {
    const checkpoint = (await createProjectCheckpoint(project))!;
    await fs.writeFile(path.join(project, 'src', 'a.txt'), 'changed\n');
    expect(await readFileAtCheckpoint(project, checkpoint, 'src/a.txt')).toBe('one\ntwo\n');
    expect(await readFileAtCheckpoint(project, checkpoint, 'missing.txt')).toBe('');
    expect(await textDiffFromCheckpoint(project, checkpoint)).toBe('');
  });

  it('will not restore outside the project', async () => {
    const checkpoint = (await createProjectCheckpoint(project))!;
    await expect(restoreCheckpointFile(project, checkpoint, '../escape.txt')).rejects.toThrow(/escapes/);
  });

  it('keeps only the most recent snapshots', async () => {
    for (let index = 0; index < 23; index += 1) await createProjectCheckpoint(project);
    expect((await fs.readdir(store)).length).toBe(20);
  });
});
