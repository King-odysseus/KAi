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

    // Pair markers with a stack rather than a `start[\s\S]*?end` regex. A lazy
    // regex anchors on the *earliest* start marker, so one dangling start whose
    // partner another tool stripped would make every later write span from it to
    // the next end marker — swallowing all the unrelated config in between.
    const lines = existing.split('\n');
    const open: number[] = [];
    const paired = new Map<number, number>();
    const orphan = new Set<number>();

    for (let i = 0; i < lines.length; i++) {
      const marker = lines[i].trim();
      if (marker === start) {
        open.push(i);
      } else if (marker === end) {
        const opened = open.pop();
        if (opened === undefined) orphan.add(i);
        else paired.set(opened, i);
      }
    }
    // A start marker still on the stack never found its partner.
    for (const i of open) orphan.add(i);

    const out: string[] = [];
    let replaced = false;
    for (let i = 0; i < lines.length; i++) {
      if (orphan.has(i)) continue;
      const endIdx = paired.get(i);
      if (endIdx !== undefined) {
        // Keep the earliest block's position; any further pair is a duplicate.
        if (!replaced) { out.push(replacement); replaced = true; }
        i = endIdx;
        continue;
      }
      out.push(lines[i]);
    }

    if (replaced) {
      return out.join('\n');
    }

    // No block of ours existed, so append one. `out` is the base rather than
    // `existing` so a dangling marker is cleaned up in the same write instead of
    // lingering until the next one.
    const base = out.join('\n');
    const separator = base.trim().length > 0 ? '\n\n' : '';
    return `${base.trimEnd()}${separator}${replacement}\n`;
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

