import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { FileChange } from './checkpoints';

const execFileAsync = promisify(execFile);

// Every worktree git call disables autocrlf: on this project's Windows git
// config, a plain `git worktree add`/checkout silently converts an LF file
// to CRLF on checkout (confirmed by this module's own tests) — that would
// make an agent's real one-line edit look like a whole-file rewrite in the
// diff, and risks introducing CRLF back into the main (LF) tree on apply.
// -c core.autocrlf=false keeps every checkout inside a compare worktree
// byte-identical to the main repo's blobs.
const NO_AUTOCRLF = ['-c', 'core.autocrlf=false'];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...NO_AUTOCRLF, ...args], { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

/**
 * Runs git with text piped to its stdin (`git apply -`, for instance).
 * Node's async `execFile` has no `input` option — only the synchronous
 * `execFileSync` does — so this pipes to the child process directly rather
 * than (incorrectly) passing `input` through `execFile`'s options, which is
 * silently ignored there.
 */
function gitWithStdin(cwd: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...NO_AUTOCRLF, ...args], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `git ${args.join(' ')} exited with code ${code}`));
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

/**
 * Creates a git worktree checked out from the repo's current HEAD, in a
 * fresh temp directory, so an agent can edit freely without touching the
 * real workspace — used by Compare mode so two agents can run at once
 * without either seeing (or overwriting) the other's edits.
 */
export async function createCompareWorktree(repoCwd: string, label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `kai-compare-${label}-`));
  // The worktree dir must not exist yet for `git worktree add` to create it;
  // mkdtemp already created it, so remove it first and let git recreate it.
  await fs.rmdir(dir);
  await git(repoCwd, ['worktree', 'add', '--detach', dir, 'HEAD']);
  return dir;
}

/** Removes a compare worktree. `--force` discards any uncommitted changes
 * in it — safe here, since a worktree's changes are captured as a patch
 * before this is ever called, if they're wanted. */
export async function removeCompareWorktree(repoCwd: string, worktreePath: string): Promise<void> {
  try {
    await git(repoCwd, ['worktree', 'remove', '--force', worktreePath]);
  } catch {
    // Best effort — an orphaned worktree entry is harmless clutter, never
    // worth failing the user's action over.
  }
}

/** File changes (added/removed lines) in a worktree since its HEAD,
 * tracked and untracked. */
export async function worktreeChanges(worktreePath: string): Promise<FileChange[]> {
  const numstat = await git(worktreePath, ['diff', '--numstat', 'HEAD', '--']);
  const changes = numstat
    .split('\n').map((l) => l.trim()).filter(Boolean)
    .map((line) => {
      const [added, removed, ...pathParts] = line.split('\t');
      return { path: pathParts.join('\t'), added: added === '-' ? 0 : parseInt(added, 10) || 0, removed: removed === '-' ? 0 : parseInt(removed, 10) || 0 };
    });
  const untracked = (await git(worktreePath, ['ls-files', '--others', '--exclude-standard']))
    .split('\n').map((l) => l.trim()).filter(Boolean);
  for (const p of untracked) {
    if (!changes.some((c) => c.path === p)) changes.push({ path: p, added: 0, removed: 0 });
  }
  return changes;
}

/**
 * A single patch covering both tracked and untracked changes in a
 * worktree, suitable for `git apply` onto the main tree (same repo, same
 * HEAD, so a clean apply is expected unless the user changed the same
 * lines in between). New files are added via `git add -N` (intent-to-add)
 * first so a plain `git diff` includes them as additions.
 */
export async function worktreeDiffPatch(worktreePath: string): Promise<string> {
  const untracked = (await git(worktreePath, ['ls-files', '--others', '--exclude-standard']))
    .split('\n').map((l) => l.trim()).filter(Boolean);
  if (untracked.length > 0) {
    await git(worktreePath, ['add', '-N', '--', ...untracked]);
  }
  return git(worktreePath, ['diff', 'HEAD', '--']);
}

/** Applies a worktree's patch onto the main working tree — the "Pick this
 * one" action. Throws if the patch doesn't apply cleanly (e.g. the user
 * edited the same lines since the compare started). */
export async function applyWorktreePatch(repoCwd: string, patch: string): Promise<void> {
  if (!patch.trim()) return; // nothing changed on this side
  await gitWithStdin(repoCwd, ['apply', '--whitespace=nowarn', '-'], patch);
}
