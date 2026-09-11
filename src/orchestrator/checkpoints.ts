import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';

const execFileAsync = promisify(execFile);

export interface Checkpoint {
  /** A commit-ish that captures the working tree at checkpoint time.
   * `git stash create` when there were uncommitted changes, or HEAD when
   * the tree was already clean. Never touches the working tree itself. */
  ref: string;
  /** Untracked (and not gitignored) files that existed at checkpoint time —
   * used to tell "files the agent created" apart from pre-existing ones on
   * undo. */
  untracked: string[];
  createdAt: string;
}

export interface FileChange {
  path: string;
  added: number;
  removed: number;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

/** Whether `cwd` is inside a git working tree. Checkpoint features are
 * disabled entirely outside one. */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const out = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Captures the working tree's current state without modifying it.
 * `git stash create` builds a commit object from the working tree + index
 * without touching either; on a clean tree it prints nothing, so we fall
 * back to HEAD (nothing to capture beyond it).
 */
export async function createCheckpoint(cwd: string): Promise<Checkpoint> {
  let ref: string;
  try {
    const stashOut = (await git(cwd, ['stash', 'create'])).trim();
    ref = stashOut || (await git(cwd, ['rev-parse', 'HEAD'])).trim();
  } catch {
    ref = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
  }
  const untrackedOut = await git(cwd, ['ls-files', '--others', '--exclude-standard']);
  const untracked = untrackedOut.split('\n').map((l) => l.trim()).filter(Boolean);
  return { ref, untracked, createdAt: new Date().toISOString() };
}

/** Files changed between a checkpoint and the current working tree, with
 * added/removed line counts (from `git diff --numstat`) plus any files the
 * agent created that didn't exist at checkpoint time. */
export async function diffFromCheckpoint(cwd: string, checkpoint: Checkpoint): Promise<FileChange[]> {
  const numstat = await git(cwd, ['diff', '--numstat', checkpoint.ref, '--']);
  const changes: FileChange[] = numstat
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [added, removed, ...pathParts] = line.split('\t');
      return {
        path: pathParts.join('\t'),
        added: added === '-' ? 0 : parseInt(added, 10) || 0,
        removed: removed === '-' ? 0 : parseInt(removed, 10) || 0,
      };
    });

  const untrackedNow = (await git(cwd, ['ls-files', '--others', '--exclude-standard']))
    .split('\n').map((l) => l.trim()).filter(Boolean);
  const newFiles = untrackedNow.filter((f) => !checkpoint.untracked.includes(f));
  for (const path of newFiles) {
    if (!changes.some((c) => c.path === path)) {
      changes.push({ path, added: 0, removed: 0 });
    }
  }
  return changes;
}

/**
 * Restores the working tree to the checkpoint: reverts every file that
 * differs from `checkpoint.ref` back to its checkpoint content, and removes
 * any untracked file the agent created since (present now, absent at
 * checkpoint time). Never touches files outside the diff — safe to call
 * even if the user made unrelated edits in between.
 */
export async function restoreCheckpoint(cwd: string, checkpoint: Checkpoint): Promise<{ restored: string[]; deleted: string[] }> {
  const changes = await diffFromCheckpoint(cwd, checkpoint);
  const untrackedNow = (await git(cwd, ['ls-files', '--others', '--exclude-standard']))
    .split('\n').map((l) => l.trim()).filter(Boolean);
  const newFiles = new Set(untrackedNow.filter((f) => !checkpoint.untracked.includes(f)));

  const restored: string[] = [];
  const deleted: string[] = [];
  for (const change of changes) {
    if (newFiles.has(change.path)) {
      await fs.unlink(path.join(cwd, change.path));
      deleted.push(change.path);
    } else {
      await writeCheckpointContent(cwd, checkpoint, change.path);
      restored.push(change.path);
    }
  }
  return { restored, deleted };
}

/** Restores a single file from the checkpoint — used by "Reject" in the
 * diff editor. Exported as `restoreOneFile` from the orchestrator to avoid
 * a name clash with its own restoreFile-shaped public method. */
export async function restoreFile(cwd: string, checkpoint: Checkpoint, filePath: string): Promise<void> {
  if (checkpoint.untracked.includes(filePath)) return; // existed before; nothing to revert to besides itself
  await writeCheckpointContent(cwd, checkpoint, filePath);
}

/**
 * Writes a file's exact checkpoint content straight to disk via `fs.writeFile`
 * rather than `git checkout`. `git checkout` runs the working-tree checkout
 * filters (notably `core.autocrlf`), which on a Windows checkout of an LF
 * repo silently rewrites the restored file to CRLF — a real corruption bug
 * caught by this module's own tests. Reading the blob with `git show` and
 * writing it directly bypasses those filters and restores the exact bytes.
 */
async function writeCheckpointContent(cwd: string, checkpoint: Checkpoint, filePath: string): Promise<void> {
  const content = await readFileAtCheckpoint(cwd, checkpoint, filePath);
  await fs.mkdir(path.dirname(path.join(cwd, filePath)), { recursive: true });
  await fs.writeFile(path.join(cwd, filePath), content, 'utf8');
}

/** Reads a file's content as it was at the checkpoint — used by the
 * kai-checkpoint: content provider backing the diff editor's "before" side. */
export async function readFileAtCheckpoint(cwd: string, checkpoint: Checkpoint, path: string): Promise<string> {
  try {
    return await git(cwd, ['show', `${checkpoint.ref}:${path}`]);
  } catch {
    return ''; // file didn't exist at checkpoint time
  }
}
