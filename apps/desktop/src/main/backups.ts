import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ConfigBackup } from '@kai/contracts';
import type { DesktopPaths } from './paths';

interface BackupManifest {
  id: string;
  name: string;
  createdAt: string;
  files: string[];
}

export class DesktopConfigBackupStore {
  constructor(private readonly paths: DesktopPaths) {}

  async list(): Promise<ConfigBackup[]> {
    await fs.mkdir(this.root, { recursive: true });
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    const backups: ConfigBackup[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifest = await this.readManifest(path.join(this.root, entry.name));
      if (!manifest) continue;
      backups.push({
        id: manifest.id,
        name: manifest.name,
        createdAt: manifest.createdAt,
        path: path.join(this.root, entry.name),
        sizeBytes: await directorySize(path.join(this.root, entry.name)),
      });
    }
    return backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async create(requestedName?: string): Promise<ConfigBackup> {
    const now = new Date().toISOString();
    const id = `backup_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const directory = path.join(this.root, id);
    const files: string[] = [];
    await fs.mkdir(directory, { recursive: true });
    for (const source of [this.paths.settings, this.paths.preferences]) {
      const exists = await fs.stat(source).then((stats) => stats.isFile()).catch(() => false);
      if (!exists) continue;
      const fileName = path.basename(source);
      await fs.copyFile(source, path.join(directory, fileName));
      files.push(fileName);
    }
    const name = sanitizeName(requestedName) || `KAI backup ${now.slice(0, 16).replace('T', ' ')}`;
    const manifest: BackupManifest = { id, name, createdAt: now, files };
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    return {
      id,
      name,
      createdAt: now,
      path: directory,
      sizeBytes: await directorySize(directory),
    };
  }

  async restore(id: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid backup identifier.');
    const directory = path.join(this.root, id);
    const manifest = await this.readManifest(directory);
    if (!manifest || manifest.id !== id) throw new Error('Backup not found.');
    const settingsSource = path.join(directory, 'settings.json');
    if (manifest.files.includes('settings.json')) await restoreFile(settingsSource, this.paths.settings);
    const preferencesSource = path.join(directory, 'project-preferences.json');
    if (manifest.files.includes('project-preferences.json')) {
      await restoreFile(preferencesSource, this.paths.preferences);
    }
  }

  async delete(id: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid backup identifier.');
    const directory = path.join(this.root, id);
    const manifest = await this.readManifest(directory);
    if (!manifest || manifest.id !== id) throw new Error('Backup not found.');
    await fs.rm(directory, { recursive: true, force: true });
  }

  private get root(): string {
    return path.join(this.paths.root, 'backups');
  }

  private async readManifest(directory: string): Promise<BackupManifest | null> {
    try {
      const raw = await fs.readFile(path.join(directory, 'manifest.json'), 'utf8');
      const value = JSON.parse(raw) as Partial<BackupManifest>;
      if (
        typeof value.id !== 'string' ||
        typeof value.name !== 'string' ||
        typeof value.createdAt !== 'string' ||
        !Array.isArray(value.files)
      ) return null;
      return {
        id: value.id,
        name: value.name,
        createdAt: value.createdAt,
        files: value.files.filter((file): file is string => typeof file === 'string'),
      };
    } catch {
      return null;
    }
  }
}

async function restoreFile(source: string, target: string): Promise<void> {
  const data = await fs.readFile(source);
  const temporary = `${target}.restore-${crypto.randomUUID()}`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temporary, data);
  await fs.rename(temporary, target);
}

function sanitizeName(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

async function directorySize(directory: string): Promise<number> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySize(target);
    else total += (await fs.stat(target)).size;
  }
  return total;
}
