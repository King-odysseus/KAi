import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Checkpoints for a folder that is not a Git repository: a plain copy of its files, taken before a run. It skips
 * dependency and build folders, and gives up (no checkpoint) when the project is too big to copy quickly.
 */
const REF_PREFIX = 'copy:';
const MAX_FILES = 3_000;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const KEEP_SNAPSHOTS = 20;
const IGNORED = new Set(['.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'out', 'release', 'coverage', '.next', '.venv', '__pycache__', 'target']);

let snapshotRoot = path.join(os.tmpdir(), 'kai-checkpoints');

/** Where copies are kept. The app points this at its data folder so they outlive a temp-folder cleanup. */
export function configureCopyCheckpoints(directory: string): void {
  snapshotRoot = directory;
}

export function isCopyRef(ref: string): boolean {
  return ref.startsWith(REF_PREFIX);
}

function snapshotDirectory(ref: string): string {
  const id = ref.slice(REF_PREFIX.length);
  if (!/^[\w-]+$/.test(id)) throw new Error('Invalid checkpoint reference.');
  return path.join(snapshotRoot, id);
}

/** Every file worth copying, as project-relative paths with forward slashes, or null when there are too many or too big. */
async function listFiles(cwd: string): Promise<string[] | null> {
  const files: string[] = [];
  let bytes = 0;
  const pending = [''];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(path.join(cwd, directory), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relative = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!IGNORED.has(entry.name)) pending.push(relative);
      } else if (entry.isFile()) {
        const stat = await fs.stat(path.join(cwd, relative)).catch(() => null);
        if (!stat) continue;
        bytes += stat.size;
        files.push(relative);
        if (files.length > MAX_FILES || bytes > MAX_TOTAL_BYTES) return null;
      }
    }
  }
  return files.sort();
}

/** Copy the folder. Returns null when it is too large, so the run simply goes without a checkpoint. */
export async function createCopySnapshot(cwd: string): Promise<{ ref: string } | null> {
  const files = await listFiles(cwd);
  if (!files) return null;
  const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const target = path.join(snapshotRoot, id);
  await fs.mkdir(target, { recursive: true });
  for (const file of files) {
    const destination = path.join(target, file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(cwd, file), destination);
  }
  await pruneSnapshots();
  return { ref: `${REF_PREFIX}${id}` };
}

async function pruneSnapshots(): Promise<void> {
  try {
    const entries = await fs.readdir(snapshotRoot, { withFileTypes: true });
    const dated = await Promise.all(
      entries.filter((entry) => entry.isDirectory()).map(async (entry) => ({
        name: entry.name,
        modified: (await fs.stat(path.join(snapshotRoot, entry.name))).mtimeMs,
      })),
    );
    for (const stale of dated.sort((a, b) => b.modified - a.modified).slice(KEEP_SNAPSHOTS)) {
      await fs.rm(path.join(snapshotRoot, stale.name), { recursive: true, force: true }).catch(() => undefined);
    }
  } catch {
    // Pruning is housekeeping; a failure must never fail the run.
  }
}

export interface CopyChange {
  path: string;
  status: 'A' | 'M' | 'D';
  added: number;
  removed: number;
}

function lineCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

/** Lines only in one side, counted as a multiset, so a moved line is not reported as a change. */
function lineDelta(before: Buffer, after: Buffer): { added: number; removed: number } {
  if (before.includes(0) || after.includes(0)) return { added: 0, removed: 0 };
  const left = lineCounts(before.toString('utf8'));
  const right = lineCounts(after.toString('utf8'));
  let added = 0;
  let removed = 0;
  for (const [line, count] of right) added += Math.max(0, count - (left.get(line) ?? 0));
  for (const [line, count] of left) removed += Math.max(0, count - (right.get(line) ?? 0));
  return { added, removed };
}

export async function diffAgainstCopy(cwd: string, ref: string): Promise<CopyChange[]> {
  const base = snapshotDirectory(ref);
  const before = (await listFilesIn(base)) ?? [];
  const now = (await listFiles(cwd)) ?? [];
  const beforeSet = new Set(before);
  const nowSet = new Set(now);
  const changes: CopyChange[] = [];
  for (const file of now) {
    const current = await fs.readFile(path.join(cwd, file)).catch(() => null);
    if (!current) continue;
    if (!beforeSet.has(file)) {
      changes.push({ path: file, status: 'A', added: lineDelta(Buffer.alloc(0), current).added, removed: 0 });
      continue;
    }
    const original = await fs.readFile(path.join(base, file)).catch(() => null);
    if (original && !original.equals(current)) changes.push({ path: file, status: 'M', ...lineDelta(original, current) });
  }
  for (const file of before) {
    if (nowSet.has(file)) continue;
    const original = await fs.readFile(path.join(base, file)).catch(() => Buffer.alloc(0));
    changes.push({ path: file, status: 'D', added: 0, removed: lineDelta(original, Buffer.alloc(0)).removed });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

async function listFilesIn(directory: string): Promise<string[] | null> {
  // The snapshot holds only what listFiles chose, so it can be listed without the ignore rules or size limits.
  const files: string[] = [];
  const pending = [''];
  while (pending.length > 0) {
    const relativeDirectory = pending.pop()!;
    const entries = await fs.readdir(path.join(directory, relativeDirectory), { withFileTypes: true }).catch(() => null);
    if (!entries) continue;
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) pending.push(relative);
      else if (entry.isFile()) files.push(relative);
    }
  }
  return files.sort();
}

export async function readCopiedFile(ref: string, file: string): Promise<string> {
  const base = snapshotDirectory(ref);
  const target = path.resolve(base, file);
  if (path.relative(base, target).startsWith('..')) throw new Error('Checkpoint path escapes the snapshot.');
  return fs.readFile(target, 'utf8').catch(() => '');
}

/** Put one file back to its checkpointed bytes, or remove it when it did not exist then. */
export async function restoreCopiedFile(cwd: string, ref: string, change: CopyChange): Promise<'restored' | 'deleted'> {
  const root = path.resolve(cwd);
  const destination = path.resolve(root, change.path);
  if (path.relative(root, destination).startsWith('..') || path.isAbsolute(path.relative(root, destination))) {
    throw new Error('Checkpoint path escapes the active project.');
  }
  if (change.status === 'A') {
    await fs.unlink(destination).catch(() => undefined);
    return 'deleted';
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(path.join(snapshotDirectory(ref), change.path), destination);
  return 'restored';
}
