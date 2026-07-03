import * as fs from 'fs/promises';
import * as path from 'path';

export interface ConfigBlock {
  id: string;
  content: string;
}

export interface ConfigWriteResult {
  targetPath: string;
  backupPath?: string;
  changed: boolean;
  blockId: string;
}

export class ConfigWriter {
  constructor(private readonly backupRootName = '.kai-backups') {}

  async mergeBlock(targetPath: string, block: ConfigBlock): Promise<ConfigWriteResult> {
    const existing = await this.readOptional(targetPath);
    const next = this.upsertBlock(existing, block);

    if (existing === next) {
      return { targetPath, changed: false, blockId: block.id };
    }

    const backupPath = await this.backupExisting(targetPath, existing);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, next, 'utf8');

    return { targetPath, backupPath, changed: true, blockId: block.id };
  }

  upsertBlock(existing: string, block: ConfigBlock): string {
    const start = this.startMarker(block.id);
    const end = this.endMarker(block.id);
    const normalizedContent = block.content.trimEnd();
    const replacement = `${start}\n${normalizedContent}\n${end}`;
    const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`, 'm');

    if (pattern.test(existing)) {
      return existing.replace(pattern, replacement);
    }

    const separator = existing.trim().length > 0 ? '\n\n' : '';
    return `${existing.trimEnd()}${separator}${replacement}\n`;
  }

  private async readOptional(targetPath: string): Promise<string> {
    try {
      return await fs.readFile(targetPath, 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return '';
      }
      throw error;
    }
  }

  private async backupExisting(targetPath: string, existing: string): Promise<string | undefined> {
    if (existing.length === 0) {
      return undefined;
    }

    const backupDir = path.join(path.dirname(targetPath), this.backupRootName);
    await fs.mkdir(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `${path.basename(targetPath)}.${stamp}.bak`);
    await fs.writeFile(backupPath, existing, 'utf8');
    return backupPath;
  }

  private startMarker(id: string): string {
    return `# >>> KAI ${id}`;
  }

  private endMarker(id: string): string {
    return `# <<< KAI ${id}`;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

