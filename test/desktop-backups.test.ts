import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DesktopConfigBackupStore } from '../apps/desktop/src/main/backups';
import { createDesktopPaths } from '../apps/desktop/src/main/paths';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-desktop-backups-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('DesktopConfigBackupStore', () => {
  it('creates, lists, restores, and deletes a configuration backup', async () => {
    const paths = createDesktopPaths(tempDir);
    await fs.writeFile(paths.settings, '{"theme":"dark"}', 'utf8');
    await fs.writeFile(paths.preferences, '{"projectId":"project-1"}', 'utf8');
    const store = new DesktopConfigBackupStore(paths);

    const backup = await store.create('Before provider changes');
    expect(backup).toMatchObject({ name: 'Before provider changes' });
    expect(backup.sizeBytes).toBeGreaterThan(0);
    expect((await store.list()).map((entry) => entry.id)).toContain(backup.id);

    await fs.writeFile(paths.settings, '{"theme":"light"}', 'utf8');
    await store.restore(backup.id);
    expect(await fs.readFile(paths.settings, 'utf8')).toBe('{"theme":"dark"}');

    await store.delete(backup.id);
    expect(await store.list()).toEqual([]);
  });

  it('rejects malformed backup identifiers', async () => {
    const store = new DesktopConfigBackupStore(createDesktopPaths(tempDir));
    await expect(store.restore('../outside')).rejects.toThrow('Invalid backup identifier');
    await expect(store.delete('../outside')).rejects.toThrow('Invalid backup identifier');
  });
});
