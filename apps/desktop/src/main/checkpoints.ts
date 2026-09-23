import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CheckpointRecord, TurnFileChange } from '@kai/contracts';

const execFileAsync = promisify(execFile);
const MAX_GIT_BUFFER = 10 * 1024 * 1024;

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: MAX_GIT_BUFFER });
  return stdout;
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

export async function createCheckpoint(cwd: string): Promise<CheckpointRecord> {
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

export async function restoreCheckpoint(
  cwd: string,
  checkpoint: CheckpointRecord,
): Promise<{ restored: string[]; deleted: string[] }> {
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
