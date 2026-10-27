import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { resolveInside } from './project-files';

/**
 * Owns the project's spec folder. Every studio file lives under `.kai/spec` as plain text, so Git versions it and
 * any agent can read it without MCP — the studio is useful even with no design tool and no server running.
 *
 * This is the only writer. Artifacts, the board and the design pull all go through here, which is what makes
 * "Regenerate keeps the last good copy" true rather than hopeful.
 */

export const SPEC_ROOT = '.kai/spec';
export const SPEC_HISTORY_ROOT = `${SPEC_ROOT}/.history`;

/**
 * Keeps KAI's own pictures out of the project's Git history. The spec's text files are worth versioning; the
 * screenshots a visual check takes and the pictures the Equalizer compares are not. They are made again on every run,
 * in a new folder each time, so a project that commits everything put 74 of them (16MB) in front of the person as a
 * question. Written only when missing, so a person who edits or empties it keeps their own rules.
 */
export const SPEC_IGNORE_CONTENT = [
  '# Written by KAI. Check screenshots and Equalizer pictures are made again on every run, so they stay on this',
  '# machine. Edit this file if you want to version them after all.',
  'board/**/*.png',
  'equalizer/**/*.png',
  '',
].join('\n');

export async function ensureSpecIgnore(projectRoot: string): Promise<void> {
  const target = await resolveInside(projectRoot, path.join(SPEC_ROOT, '.gitignore'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.writeFile(target, SPEC_IGNORE_CONTENT, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

export interface SpecWriteResult {
  /** Project-relative path, with forward slashes so it reads the same on every platform. */
  path: string;
  /** 1 for the first rewrite of an existing file; 0 when there was nothing to keep. */
  version: number;
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

/**
 * Where the previous copy of an artifact is kept. The artifact keeps its own shape: `brief.md` is versioned under
 * `.kai/spec/.history/brief/v1/brief.md`, `design/tokens.json` under `.history/design/tokens/v1/tokens.json`.
 */
export function specHistoryPath(relativePath: string, version: number): string {
  const parsed = path.posix.parse(toPosix(relativePath));
  const folder = parsed.dir ? path.posix.join(parsed.dir, parsed.name) : parsed.name;
  return path.posix.join(SPEC_HISTORY_ROOT, folder, `v${version}`, parsed.base);
}

export class SpecStore {
  /** Reads a spec file, or null when it does not exist yet. */
  async read(projectRoot: string, relativePath: string): Promise<string | null> {
    const target = await resolveInside(projectRoot, path.join(SPEC_ROOT, relativePath));
    try {
      return await fs.readFile(target, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  /**
   * Writes a spec file, keeping the copy it replaced. The write is atomic: a crash mid-write leaves either the old
   * file or the new one, never a half-written brief on disk.
   */
  async write(projectRoot: string, relativePath: string, content: string): Promise<SpecWriteResult> {
    const target = await resolveInside(projectRoot, path.join(SPEC_ROOT, relativePath));
    const version = await this.archive(projectRoot, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, content, 'utf8');
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    return { path: toPosix(path.join(SPEC_ROOT, relativePath)), version };
  }

  /** Lists the artifact paths the studio has written, so the UI can show what exists without guessing. */
  async list(projectRoot: string): Promise<string[]> {
    const root = await resolveInside(projectRoot, SPEC_ROOT);
    const found: string[] = [];
    const walk = async (directory: string, prefix: string): Promise<void> => {
      let entries: Array<{ name: string; isDirectory(): boolean }>;
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        if (entry.name === '.history') continue;
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative);
        else found.push(relative);
      }
    };
    await walk(root, '');
    return found.sort();
  }

  /** Copies the file that is about to be replaced into `.kai/spec/.history`, and returns the version it got. */
  private async archive(projectRoot: string, relativePath: string): Promise<number> {
    const cached = await this.read(projectRoot, relativePath);
    if (cached === null) return 0;
    const version = (await this.lastVersion(projectRoot, relativePath)) + 1;
    const destination = await resolveInside(projectRoot, specHistoryPath(relativePath, version));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, cached, 'utf8');
    return version;
  }

  private async lastVersion(projectRoot: string, relativePath: string): Promise<number> {
    const parsed = path.posix.parse(toPosix(relativePath));
    const folder = parsed.dir ? path.posix.join(parsed.dir, parsed.name) : parsed.name;
    const versions = await resolveInside(projectRoot, path.posix.join(SPEC_HISTORY_ROOT, folder));
    let entries: string[];
    try {
      entries = await fs.readdir(versions);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
    return entries.reduce((highest, entry) => {
      const match = /^v(\d+)$/.exec(entry);
      return match ? Math.max(highest, Number(match[1])) : highest;
    }, 0);
  }
}
