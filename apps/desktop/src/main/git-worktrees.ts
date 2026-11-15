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
  // A scratch commit in a throwaway copy: its changes reach the project as a diff, never as this commit, so the project's
  // commit hooks have nothing to check. Running them only made a task whose title holds a banned word fail after the
  // whole agent run had been paid for.
  if (status) await git(directory, ['commit', '--no-verify', '-m', message]);
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

/** A bounded patch gives a clashing part its earlier intent without flooding its next prompt. */
export async function attemptDiff(directory: string, snapshot: string, commit: string): Promise<string> {
  const diff = await git(directory, ['diff', '--no-ext-diff', '--no-textconv', snapshot, commit, '--']);
  const note = '\n[diff shortened to 8,000 characters]';
  return diff.length > 8_000 ? `${diff.slice(0, 8_000 - note.length)}${note}` : diff;
}

export interface ApplyResult {
  applied: string[];
  /**
   * Files changed in the project after the snapshot, whose changes could not be combined with the part's (the same
   * lines changed both ways, or a file that is not text). These are left exactly as the project has them.
   */
  skipped: string[];
  /** Files changed both in the project and by the part, in different places, and combined. Also in `applied`. */
  merged: string[];
}

/**
 * Combines two changes to one file the way git does: the base the two started from, the project's version and the
 * part's. Null when the same lines were changed both ways, or either side is not text, so nothing is guessed.
 *
 * Without this every file two cards both touched was refused outright, and on a project where every card adds to
 * the same stylesheet and the same test script, most cards' work was thrown away and redone.
 *
 * `union` keeps both sides where they changed the same lines, which is right for a file every card only adds to (a test
 * script, a stylesheet): it was the same few files that clashed again and again, and each clash was a whole agent
 * attempt run again. A wrong combination is caught by the check, which costs what a clash cost.
 */
export async function mergeFileThreeWay(current: Buffer, base: Buffer, theirs: Buffer, union = false): Promise<Buffer | null> {
  if ([current, base, theirs].some((content) => content.includes(0))) return null;
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-merge-'));
  try {
    const [ours, original, other] = ['project', 'base', 'part'].map((name) => path.join(folder, name));
    await Promise.all([fs.writeFile(ours!, current), fs.writeFile(original!, base), fs.writeFile(other!, theirs)]);
    return await new Promise<Buffer | null>((resolve) => {
      execFile('git', ['merge-file', '-p', ...(union ? ['--union'] : []), '-L', 'project', '-L', 'base', '-L', 'part', ours!, original!, other!], { encoding: 'buffer', maxBuffer: MAX_BUFFER, windowsHide: true }, (error, stdout) => {
        // Exit 0 is a clean merge; a positive exit is the number of conflicts, and anything else is a failure.
        if (error) return resolve(null);
        // Keeping both sides where they changed the same lines doubles a file when one side rewrote all of it: on 22 October
        // a card that reformatted Zuri's smoke script came out as that script twice over, 14,580 lines of it, which could not
        // start, and every check after it failed. What both sides legitimately add is the project's own length plus what the
        // card added to the base; a result well past that is not a combination of two additions, so it is refused.
        resolve(union && !plausibleUnion(current, base, theirs, stdout) ? null : stdout);
      });
    });
  } finally {
    await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Slack for the few lines an honest combination can add beyond the two sides' own: a repeated closing brace, a blank line. */
const UNION_SLACK_LINES = 12;

/** Whether a union merge is about the size two sets of added lines make, and not one side's file stacked on the other's. */
export function plausibleUnion(current: Buffer, base: Buffer, theirs: Buffer, result: Buffer): boolean {
  const lines = (content: Buffer): number => content.toString('utf8').split('\n').length;
  const addedByTheirs = Math.max(0, lines(theirs) - lines(base));
  return lines(result) <= lines(current) + addedByTheirs + UNION_SLACK_LINES;
}

/**
 * Puts a commit's changes into a worktree without committing them, on top of whatever the worktree holds now. Used
 * to carry a card's previous attempt into the fresh copy its next attempt starts from. False, and the worktree left
 * as it was, when the changes do not apply cleanly.
 */
export async function carryCommit(directory: string, commit: string): Promise<boolean> {
  const picked = await runGit(directory, ['cherry-pick', '--no-commit', commit]);
  if (picked.code === 0) return true;
  await runGit(directory, ['cherry-pick', '--abort']);
  await runGit(directory, ['reset', '--hard', '-q']);
  return false;
}

/**
 * Copies a wave's result into the real working tree. A file is only written when it still matches the snapshot the
 * wave started from, so nothing the user (or another agent) did meanwhile is ever overwritten.
 */
export async function applyToWorkingTree(root: string, snapshot: string, integration: string, changes: readonly FileChange[], unionFiles: ReadonlySet<string> = new Set()): Promise<ApplyResult> {
  const applied: string[] = [];
  const skipped: string[] = [];
  const merged: string[] = [];
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
      // Changed in the project since the snapshot. Two changes to different lines are combined; anything else is left
      // as the project has it, which protects a person's own edit as much as another card's.
      let combined = current !== null && base !== null && result !== null ? await mergeFileThreeWay(current, base, result) : null;
      if (!combined && unionFiles.has(change.file) && current !== null && base !== null && result !== null) combined = await mergeFileThreeWay(current, base, result, true);
      if (!combined) {
        skipped.push(change.file);
        continue;
      }
      await fs.writeFile(live, combined);
      applied.push(change.file);
      merged.push(change.file);
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
  return { applied, skipped, merged };
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

const inside = (base: string, candidate: string): boolean => {
  const relative = path.relative(base, candidate);
  return relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** Only visit real directories; unlink dependency links before any recursive removal. */
async function unlinkDependencyLinks(directory: string): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) {
      if (entry.name === 'node_modules') await fs.unlink(target);
    } else if (stat.isDirectory() && entry.name !== '.git') {
      await unlinkDependencyLinks(target);
    }
  }
}

/** Startup recovery is restricted to KAI's temporary copies, even if git lists other worktrees. */
export async function cleanupParallelWorktrees(
  projects: readonly string[],
  options: { baseDirectory?: string; activeDirectories?: () => readonly string[]; now?: number; log?: (message: string) => void } = {},
): Promise<void> {
  const base = path.resolve(options.baseDirectory ?? path.join(os.tmpdir(), 'kai-parallel'));
  const baseStat = await fs.lstat(base).catch(() => null);
  if (baseStat?.isSymbolicLink()) return;
  const realBase = await fs.realpath(base).catch(() => base);
  // Git can return a long Windows path while the running wave still holds its 8.3 temporary path.
  const canonical = (candidate: string): string => inside(base, candidate) ? path.join(realBase, path.relative(base, candidate)) : candidate;
  const active = (candidate: string): boolean => {
    const target = canonical(candidate);
    return (options.activeDirectories?.() ?? []).some((item) => {
      const resolved = canonical(path.resolve(item));
      return resolved === target || inside(resolved, target) || inside(target, resolved);
    });
  };
  const safe = async (candidate: string): Promise<boolean> => {
    if (!inside(base, candidate) && !inside(realBase, candidate)) return false;
    // Resolve the nearest existing ancestor as well, so a missing checkout below a junction is never removed.
    let ancestor = candidate;
    for (;;) {
      const resolved = await fs.realpath(ancestor).catch(() => null);
      if (resolved) return resolved === realBase || inside(realBase, resolved);
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return false;
      ancestor = parent;
    }
  };
  for (const project of projects) {
    try {
      const repository = await repositoryFor(project);
      if (!repository) continue;
      await git(repository.root, ['worktree', 'prune']);
      const listing = await git(repository.root, ['worktree', 'list', '--porcelain', '-z']);
      for (const field of listing.split('\0')) {
        if (!field.startsWith('worktree ')) continue;
        const candidate = path.resolve(field.slice(9));
        if (!(await safe(candidate)) || active(candidate)) continue;
        const stat = await fs.lstat(candidate).catch(() => null);
        if (stat?.isSymbolicLink()) continue;
        if (stat) await unlinkDependencyLinks(candidate);
        if (active(candidate)) continue;
        await removeWorktree(repository.root, candidate);
        options.log?.(`Removed leftover parallel worktree: ${candidate}`);
      }
    } catch (error) {
      options.log?.(`Could not clean parallel copies for ${project}: ${String(error)}`);
    }
  }
  const cutoff = (options.now ?? Date.now()) - 60 * 60_000;
  for (const entry of await fs.readdir(base, { withFileTypes: true }).catch(() => [])) {
    const candidate = path.join(base, entry.name);
    const stat = await fs.lstat(candidate).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink() || stat.mtimeMs >= cutoff || !(await safe(candidate)) || active(candidate)) continue;
    await unlinkDependencyLinks(candidate);
    if (active(candidate)) continue;
    await fs.rm(candidate, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    options.log?.(`Removed old parallel folder: ${candidate}`);
  }
}
