import * as fs from 'fs/promises';
import * as path from 'path';

export interface BackupEntry {
  filename: string;
  originalName: string;
  timestamp: string;
  path: string;
  size: number;
}

export class BackupManager {
  constructor(private readonly backupDirName = '.kai-backups') {}

  async listBackups(configDir: string): Promise<BackupEntry[]> {
    const backupDir = path.join(configDir, this.backupDirName);

    let entries: string[];
    try {
      entries = await fs.readdir(backupDir);
    } catch {
      return [];
    }

    const results: BackupEntry[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.bak')) {
        continue;
      }

      const fullPath = path.join(backupDir, entry);
      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        continue;
      }

      // Parse timestamp from filename: "config.toml.2026-07-03T12-00-00-000Z.bak"
      const parts = entry.split('.');
      const ext = parts.pop(); // bak
      const stamp = parts.pop(); // timestamp
      const originalName = parts.join('.');

      results.push({
        filename: entry,
        originalName,
        timestamp: stamp ? stamp.replace(/-/g, ':').replace(/^(\d{4}):(\d{2}):(\d{2})T/, '$1-$2-$3T') : 'unknown',
        path: fullPath,
        size: stat.size,
      });
    }

    return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  async restoreBackup(backupPath: string, targetPath: string): Promise<{ restored: boolean; detail: string }> {
    let content: string;
    try {
      content = await fs.readFile(backupPath, 'utf8');
    } catch (error) {
      return { restored: false, detail: `Could not read backup: ${errorMessage(error)}` };
    }

    // Backup current before restoring
    try {
      const current = await fs.readFile(targetPath, 'utf8');
      const backupDir = path.join(path.dirname(targetPath), this.backupDirName);
      await fs.mkdir(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const preRestoreBackup = path.join(backupDir, `${path.basename(targetPath)}.pre-restore.${stamp}.bak`);
      await fs.writeFile(preRestoreBackup, current, 'utf8');
    } catch {
      // Target doesn't exist yet — no need to backup
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, content, 'utf8');

    return { restored: true, detail: `Restored ${path.basename(targetPath)} from backup.` };
  }

  async deleteBackup(backupPath: string): Promise<void> {
    await fs.unlink(backupPath);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
