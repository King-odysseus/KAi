import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

/**
 * Git plumbing for running parts of a job side by side: a snapshot of the working tree (uncommitted and new files
 * included), a disposable worktree per part, a merge of what each part did, and a careful copy of the result back.
 * Nothing here touches the user's branches, index or stash.
 */

const IDENTITY = ['-c', 'user.name=KAI', '-c', 'user.email=kai@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false'];
const MAX_BUFFER = 256 * 1024 * 1024;

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', [...IDENTITY, ...args], { cwd, env: { ...process.env, ...env }, maxBuffer: MAX_BUFFER, windowsHide: true }, (error, stdout, stderr) => {
      const raw = (error as { code?: unknown } | null)?.code;
      // A process that ran and failed reports its exit code; one that could not start reports a name like ENOENT.
      resolve({ stdout, stderr, code: error ? (typeof raw === 'number' ? raw : 1) : 0 });
    });
  });
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await runGit(cwd, args, env);
  if (result.code !== 0) throw new Error(`git ${args[0] ?? ''} failed: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
  return result.stdout;
}

function blob(cwd: string, spec: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile('git', ['cat-file', 'blob', spec], { cwd, encoding: 'buffer', maxBuffer: MAX_BUFFER, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

export interface RepositoryInfo {
  /** The top of the repository, which is where worktrees and merges happen. */
  root: string;
  /** The project's own folder relative to the root (empty unless the project is a subfolder of a bigger repo). */
  prefix: string;
}

/** The repository a project lives in, or null when it is not a git project with at least one commit. */
export async function repositoryFor(projectPath: string): Promise<RepositoryInfo | null> {
  const top = await runGit(projectPath, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return null;
  if ((await runGit(projectPath, ['rev-parse', '--verify', 'HEAD'])).code !== 0) return null;
  const prefix = (await runGit(projectPath, ['rev-parse', '--show-prefix'])).stdout.trim().replace(/\/+$/, '');
  return { root: path.normalize(top.stdout.trim()), prefix };
}

/**
 * A commit holding the working tree exactly as it is now, new files included and ignored files left out. Built in
 * a throwaway index, so the user's own index, branches and stash are never changed.
 */
export async function snapshotWorkingTree(root: string): Promise<string> {
  const index = path.join(os.tmpdir(), `kai-index-${crypto.randomUUID()}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    await git(root, ['read-tree', 'HEAD'], env);
    await git(root, ['add', '-A'], env);
    const tree = (await git(root, ['write-tree'], env)).trim();
    return (await git(root, ['commit-tree', tree, '-p', 'HEAD', '-m', 'KAI snapshot before a parallel wave'])).trim();
  } finally {
    await fs.rm(index, { force: true });
  }
}

/** A disposable checkout of a snapshot. Its node_modules, when the project has one, is linked rather than copied. */
export async function addWorktree(root: string, directory: string, commit: string, linkNodeModules = true): Promise<void> {
  await fs.mkdir(path.dirname(directory), { recursive: true });
  await git(root, ['worktree', 'add', '--detach', '--force', directory, commit]);
  if (linkNodeModules) {
    const source = path.join(root, 'node_modules');
    const target = path.join(directory, 'node_modules');
    const [hasSource, hasTarget] = await Promise.all([exists(source), exists(target)]);
    // A project that tracks its node_modules already has one in the checkout; only link a missing one.
    if (hasSource && !hasTarget) await fs.symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir').catch(() => undefined);
  }
}

/** Records everything a part changed as one commit in its worktree and returns it (the base when nothing changed). */
export async function commitWorktree(directory: string, message: string): Promise<string> {
  // node_modules is never part of a part's work: it may be a link to the project's real one, which git can see as a
  // file when .gitignore only matches the folder form ("node_modules/").
  // Staging everything and then resetting node_modules back to the snapshot drops a staged link, and leaves a
  // project that tracks its node_modules exactly as the snapshot had it. (An exclude pathspec fails outright when
  // the folder is also ignored.)
  await git(directory, ['add', '-A']);
  await git(directory, ['reset', '-q', '--', ':(glob)node_modules', ':(glob)**/node_modules']);
  const status = (await git(directory, ['status', '--porcelain'])).trim();
  if (status) await git(directory, ['commit', '-m', message]);
  return (await git(directory, ['rev-parse', 'HEAD'])).trim();
}

export type MergeResult = { ok: true } | { ok: false; files: string[] };

/** Merges a part's commit into an integration worktree. A conflict is undone and reported, never left half done. */
export async function mergeCommit(directory: string, commit: string, message: string): Promise<MergeResult> {
  const merged = await runGit(directory, ['merge', '--no-edit', '--no-ff', '-m', message, commit]);
  if (merged.code === 0) return { ok: true };
  const conflicts = (await runGit(directory, ['diff', '--name-only', '--diff-filter=U'])).stdout.split(/\r?\n/).filter(Boolean);
  await runGit(directory, ['merge', '--abort']);
  // A failed merge with no listed conflict (a bad commit, a lock) is still a failure to report, not a success.
  return { ok: false, files: conflicts.length > 0 ? conflicts : ['(the merge could not be completed)'] };
}

export interface FileChange {
  status: 'added' | 'modified' | 'deleted';
  file: string;
}

/** Files that differ between two commits, as paths from the repository root. */
export async function changedFiles(directory: string, from: string, to: string): Promise<FileChange[]> {
  const output = await git(directory, ['diff', '--name-status', '--no-renames', '-z', from, to]);
  const parts = output.split('\0').filter((part) => part.length > 0);
  const changes: FileChange[] = [];
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const code = (parts.at(index) ?? '').charAt(0);
    changes.push({ status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified', file: parts.at(index + 1) ?? '' });
  }
  return changes;
}

export interface ApplyResult {
  applied: string[];
  /** Files the user changed after the snapshot; these are left exactly as the user has them. */
  skipped: string[];
}

/**
 * Copies a wave's result into the real working tree. A file is only written when it still matches the snapshot the
 * wave started from, so nothing the user (or another agent) did meanwhile is ever overwritten.
 */
export async function applyToWorkingTree(root: string, snapshot: string, integration: string, changes: readonly FileChange[]): Promise<ApplyResult> {
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const change of changes) {
    if (isDependencyPath(change.file)) continue;
    const live = path.join(root, change.file);
    const fromIntegration = path.join(integration, change.file);
    const [current, base, result] = await Promise.all([
      fs.readFile(live).catch(() => null),
      blob(root, `${snapshot}:${change.file}`),
      change.status === 'deleted' ? Promise.resolve(null) : fs.readFile(fromIntegration).catch(() => null),
    ]);
    const unchanged = current === null ? base === null : base !== null && current.equals(base);
    const alreadyThere = current !== null && result !== null && current.equals(result);
    if (alreadyThere || (current === null && result === null)) {
      applied.push(change.file);
      continue;
    }
    if (!unchanged) {
      skipped.push(change.file);
      continue;
    }
    if (change.status === 'deleted') {
      await fs.rm(live, { force: true });
    } else {
      await fs.mkdir(path.dirname(live), { recursive: true });
      await fs.copyFile(fromIntegration, live);
    }
    applied.push(change.file);
  }
  return { applied, skipped };
}

/**
 * Deletes a worktree. A linked node_modules is unlinked first, so removing the checkout can never reach into the
 * project's real dependencies.
 */
export async function removeWorktree(root: string, directory: string): Promise<void> {
  const link = path.join(directory, 'node_modules');
  const stat = await fs.lstat(link).catch(() => null);
  if (stat?.isSymbolicLink() || (stat && process.platform === 'win32' && (await isLinkedDirectory(link, root)))) {
    // rmdir removes a junction or symlink itself; it does not follow it.
    await fs.rmdir(link).catch(() => fs.unlink(link).catch(() => undefined));
  }
  await runGit(root, ['worktree', 'remove', '--force', directory]);
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  await runGit(root, ['worktree', 'prune']);
}

/** The current commit of a checkout. */
export async function headCommit(directory: string): Promise<string> {
  return (await git(directory, ['rev-parse', 'HEAD'])).trim();
}

function isDependencyPath(file: string): boolean {
  return file.split('/').includes('node_modules');
}

async function isLinkedDirectory(candidate: string, root: string): Promise<boolean> {
  const [real, expected] = await Promise.all([fs.realpath(candidate).catch(() => candidate), fs.realpath(path.join(root, 'node_modules')).catch(() => '')]);
  return real === expected;
}

async function exists(target: string): Promise<boolean> {
  return fs.access(target).then(() => true, () => false);
}
