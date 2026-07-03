import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackupManager } from '../src/config/backup-manager';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-backup-mgr-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('BackupManager', () => {
  it('lists no backups for an empty directory', async () => {
    const mgr = new BackupManager();
    const backups = await mgr.listBackups(tempDir);
    expect(backups).toEqual([]);
  });

  it('lists backups with parsed metadata', async () => {
    const backupDir = path.join(tempDir, '.kai-backups');
    await fs.mkdir(backupDir, { recursive: true });
    await fs.writeFile(path.join(backupDir, 'config.toml.2026-07-03T12-00-00-000Z.bak'), 'backup content', 'utf8');

    const mgr = new BackupManager();
    const backups = await mgr.listBackups(tempDir);

    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatchObject({
      originalName: 'config.toml',
      size: 14,
    });
  });

  it('restores a backup to the target path', async () => {
    const backupDir = path.join(tempDir, '.kai-backups');
    await fs.mkdir(backupDir, { recursive: true });
    await fs.writeFile(path.join(backupDir, 'settings.json.2026-07-03T12-00-00-000Z.bak'), '{"key":"value"}', 'utf8');

    const targetPath = path.join(tempDir, 'settings.json');
    const mgr = new BackupManager();
    const result = await mgr.restoreBackup(
      path.join(backupDir, 'settings.json.2026-07-03T12-00-00-000Z.bak'),
      targetPath,
    );

    expect(result.restored).toBe(true);
    const content = await fs.readFile(targetPath, 'utf8');
    expect(content).toBe('{"key":"value"}');
  });

  it('deletes a backup', async () => {
    const backupDir = path.join(tempDir, '.kai-backups');
    await fs.mkdir(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, 'old.bak');
    await fs.writeFile(backupPath, 'stale', 'utf8');

    const mgr = new BackupManager();
    await mgr.deleteBackup(backupPath);

    await expect(fs.access(backupPath)).rejects.toThrow();
  });

  it('returns an error detail when backup does not exist', async () => {
    const mgr = new BackupManager();
    const result = await mgr.restoreBackup(
      path.join(tempDir, 'nonexistent.bak'),
      path.join(tempDir, 'target.txt'),
    );

    expect(result.restored).toBe(false);
    expect(result.detail).toContain('Could not read backup');
  });
});
