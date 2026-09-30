import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CheckpointRecord, TurnFileChange } from '@kai/contracts';
import { createCopySnapshot, diffAgainstCopy, isCopyRef, readCopiedFile, restoreCopiedFile } from './copy-checkpoints';

const execFileAsync = promisify(execFile);
const MAX_GIT_BUFFER = 10 * 1024 * 1024;

export async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: MAX_GIT_BUFFER, ...(env ? { env } : {}) });
  return stdout;
}

async function gitBytes(cwd: string, args: string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: MAX_GIT_BUFFER * 5, encoding: 'buffer' });
  return stdout;
}

/**
 * Write a tree of everything in the work tree that Git does not ignore, untracked files included, without touching
 * the real index. Line endings are stored as-is so restoring a file gives back the exact bytes.
 */
async function snapshotTree(cwd: string): Promise<string> {
  const indexFile = path.join(os.tmpdir(), `kai-index-${randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  const raw = ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false'];
  try {
    await git(cwd, [...raw, 'add', '-A', '--', '.'], env);
    return (await git(cwd, ['write-tree'], env)).trim();
  } finally {
    await fs.rm(indexFile, { force: true }).catch(() => undefined);
  }
}

/** New checkpoints are tree objects; older ones are stash or HEAD commits and keep their original handling. */
async function isTreeSnapshot(cwd: string, ref: string): Promise<boolean> {
  try {
    return (await git(cwd, ['cat-file', '-t', ref])).trim() === 'tree';
  } catch {
    return false;
  }
}

interface TreeChange extends TurnFileChange {
  status: 'A' | 'M' | 'D';
}

async function diffAgainstTree(cwd: string, ref: string): Promise<TreeChange[]> {
  const now = await snapshotTree(cwd);
  const diffArgs = ['-c', 'core.quotepath=off', 'diff', '--no-renames', '-z'];
  const statuses = (await git(cwd, [...diffArgs, '--name-status', ref, now])).split('\0').filter(Boolean);
  const counts = new Map<string, { added: number; removed: number }>();
  for (const entry of (await git(cwd, [...diffArgs, '--numstat', ref, now])).split('\0').filter(Boolean)) {
    const [added, removed, ...pathParts] = entry.split('	');
    counts.set(pathParts.join('	'), {
      added: added === '-' ? 0 : Number.parseInt(added, 10) || 0,
      removed: removed === '-' ? 0 : Number.parseInt(removed, 10) || 0,
    });
  }
  const changes: TreeChange[] = [];
  for (let index = 0; index + 1 < statuses.length; index += 2) {
    const status = statuses[index]!.charAt(0);
    const filePath = statuses[index + 1]!;
    if (status !== 'A' && status !== 'M' && status !== 'D') continue;
    changes.push({ path: filePath, status, ...(counts.get(filePath) ?? { added: 0, removed: 0 }) });
  }
  return changes;
}

async function restoreTreeChange(cwd: string, ref: string, change: TreeChange): Promise<'restored' | 'deleted'> {
  const target = resolveInside(cwd, change.path);
  if (change.status === 'A') {
    await fs.unlink(target).catch(() => undefined);
    return 'deleted';
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, await gitBytes(cwd, ['cat-file', 'blob', `${ref}:${change.path}`]));
  return 'restored';
}

export async function gitDiffStat(cwd: string): Promise<string> {
  try {
    return (await git(cwd, ['diff', '--stat', 'HEAD'])).trim();
  } catch {
    return '';
  }
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
}

/** A checkpoint for any project: Git when it is a repository, otherwise a copy of its files. Null when neither works. */
export async function createProjectCheckpoint(cwd: string): Promise<CheckpointRecord | null> {
  if (await isGitRepo(cwd)) return createCheckpoint(cwd);
  const copy = await createCopySnapshot(cwd);
  return copy ? { ref: copy.ref, untracked: [], createdAt: new Date().toISOString() } : null;
}

export async function createCheckpoint(cwd: string): Promise<CheckpointRecord> {
  try {
    return { ref: await snapshotTree(cwd), untracked: [], createdAt: new Date().toISOString() };
  } catch {
    // Fall back to the stash-based snapshot below (for example a repository with no commits and a locked index).
  }
  let ref: string;
  try {
    ref = (await git(cwd, ['stash', 'create'])).trim() || (await git(cwd, ['rev-parse', 'HEAD'])).trim();
  } catch {
    ref = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
  }
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard']))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return { ref, untracked, createdAt: new Date().toISOString() };
}

export async function diffFromCheckpoint(cwd: string, checkpoint: CheckpointRecord): Promise<TurnFileChange[]> {
  if (isCopyRef(checkpoint.ref)) {
    return (await diffAgainstCopy(cwd, checkpoint.ref)).map(({ path: filePath, added, removed }) => ({ path: filePath, added, removed }));
  }
  if (await isTreeSnapshot(cwd, checkpoint.ref)) {
    return (await diffAgainstTree(cwd, checkpoint.ref)).map(({ path: filePath, added, removed }) => ({ path: filePath, added, removed }));
  }
  const numstat = await git(cwd, ['diff', '--numstat', checkpoint.ref, '--']);
  const changes: TurnFileChange[] = numstat
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [added, removed, ...pathParts] = line.split('\t');
      return {
        path: pathParts.join('\t'),
        added: added === '-' ? 0 : Number.parseInt(added, 10) || 0,
        removed: removed === '-' ? 0 : Number.parseInt(removed, 10) || 0,
      };
    });
  const untrackedNow = (await git(cwd, ['ls-files', '--others', '--exclude-standard']))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (const filePath of untrackedNow.filter((candidate) => !checkpoint.untracked.includes(candidate))) {
    if (!changes.some((change) => change.path === filePath)) {
      changes.push({ path: filePath, added: 0, removed: 0 });
    }
  }
  return changes;
}

/** The unified diff of everything that changed since the checkpoint, cut to a size a model can read. */
export async function textDiffFromCheckpoint(cwd: string, checkpoint: CheckpointRecord, maxCharacters = 60_000): Promise<string> {
  // A copy checkpoint has no Git history to diff against, so there is no text diff to hand a reviewer.
  if (isCopyRef(checkpoint.ref)) return '';
  try {
    const args = (await isTreeSnapshot(cwd, checkpoint.ref))
      ? ['diff', '--no-renames', '--no-color', '--unified=3', checkpoint.ref, await snapshotTree(cwd)]
      : ['diff', '--no-renames', '--no-color', '--unified=3', checkpoint.ref];
    const diff = await git(cwd, args);
    return diff.length > maxCharacters ? `${diff.slice(0, maxCharacters)}
... (diff cut at ${maxCharacters} characters)` : diff;
  } catch {
    return '';
  }
}

export async function restoreCheckpoint(
  cwd: string,
  checkpoint: CheckpointRecord,
): Promise<{ restored: string[]; deleted: string[] }> {
  if (isCopyRef(checkpoint.ref)) {
    const result: { restored: string[]; deleted: string[] } = { restored: [], deleted: [] };
    for (const change of await diffAgainstCopy(cwd, checkpoint.ref)) {
      result[await restoreCopiedFile(cwd, checkpoint.ref, change)].push(change.path);
    }
    return result;
  }
  if (await isTreeSnapshot(cwd, checkpoint.ref)) {
    const result: { restored: string[]; deleted: string[] } = { restored: [], deleted: [] };
    for (const change of await diffAgainstTree(cwd, checkpoint.ref)) {
      result[await restoreTreeChange(cwd, checkpoint.ref, change)].push(change.path);
    }
    return result;
  }
  const changes = await diffFromCheckpoint(cwd, checkpoint);
  const untrackedNow = (await git(cwd, ['ls-files', '--others', '--exclude-standard']))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const newFiles = new Set(untrackedNow.filter((filePath) => !checkpoint.untracked.includes(filePath)));
  const restored: string[] = [];
  const deleted: string[] = [];
  for (const change of changes) {
    if (newFiles.has(change.path)) {
      await fs.unlink(path.join(cwd, change.path)).catch(() => undefined);
      deleted.push(change.path);
    } else {
      await writeCheckpointContent(cwd, checkpoint, change.path);
      restored.push(change.path);
    }
  }
  return { restored, deleted };
}

export async function restoreCheckpointFile(
  cwd: string,
  checkpoint: CheckpointRecord,
  filePath: string,
): Promise<{ restored: string[]; deleted: string[] }> {
  const safePath = resolveInside(cwd, filePath);
  if (isCopyRef(checkpoint.ref)) {
    const change = (await diffAgainstCopy(cwd, checkpoint.ref)).find((candidate) => candidate.path === filePath);
    if (!change) return { restored: [], deleted: [] };
    const outcome = await restoreCopiedFile(cwd, checkpoint.ref, change);
    return outcome === 'deleted' ? { restored: [], deleted: [filePath] } : { restored: [filePath], deleted: [] };
  }
  if (await isTreeSnapshot(cwd, checkpoint.ref)) {
    const change = (await diffAgainstTree(cwd, checkpoint.ref)).find((candidate) => candidate.path === filePath);
    if (!change) return { restored: [], deleted: [] };
    const outcome = await restoreTreeChange(cwd, checkpoint.ref, change);
    return outcome === 'deleted' ? { restored: [], deleted: [filePath] } : { restored: [filePath], deleted: [] };
  }
  const changes = await diffFromCheckpoint(cwd, checkpoint);
  if (!changes.some((change) => change.path === filePath)) return { restored: [], deleted: [] };
  const untrackedNow = (await git(cwd, ['ls-files', '--others', '--exclude-standard']))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (untrackedNow.includes(filePath) && !checkpoint.untracked.includes(filePath)) {
    await fs.unlink(safePath).catch(() => undefined);
    return { restored: [], deleted: [filePath] };
  }
  await writeCheckpointContent(cwd, checkpoint, filePath);
  return { restored: [filePath], deleted: [] };
}

export async function readFileAtCheckpoint(cwd: string, checkpoint: CheckpointRecord, filePath: string): Promise<string> {
  if (isCopyRef(checkpoint.ref)) return readCopiedFile(checkpoint.ref, filePath);
  try {
    return await git(cwd, ['show', `${checkpoint.ref}:${filePath}`]);
  } catch {
    return '';
  }
}

async function writeCheckpointContent(cwd: string, checkpoint: CheckpointRecord, filePath: string): Promise<void> {
  const content = await readFileAtCheckpoint(cwd, checkpoint, filePath);
  const target = resolveInside(cwd, filePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

function resolveInside(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relativePath);
  if (!insideRoot(resolvedRoot, target)) throw new Error('Checkpoint path escapes the active project.');
  return target;
}

function insideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
