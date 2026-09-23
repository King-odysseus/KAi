import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TurnFileChange } from '@kai/contracts';

const execFileAsync = promisify(execFile);
const NO_AUTOCRLF = ['-c', 'core.autocrlf=false'];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...NO_AUTOCRLF, ...args], {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

function gitWithStdin(cwd: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...NO_AUTOCRLF, ...args], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `git ${args.join(' ')} exited with code ${code}`));
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

export async function createCompareWorktree(repoCwd: string, label: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `kai-compare-${label}-`));
  await fs.rm(directory, { recursive: true, force: true });
  await git(repoCwd, ['worktree', 'add', '--detach', directory, 'HEAD']);
  return directory;
}

export async function removeCompareWorktree(repoCwd: string, worktreePath: string): Promise<void> {
  try {
    await git(repoCwd, ['worktree', 'remove', '--force', worktreePath]);
  } catch {
    await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function worktreeChanges(worktreePath: string): Promise<TurnFileChange[]> {
  const changes: TurnFileChange[] = (await git(worktreePath, ['diff', '--numstat', 'HEAD', '--']))
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
  const untracked = (await git(worktreePath, ['ls-files', '--others', '--exclude-standard']))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (const filePath of untracked) {
    if (!changes.some((change) => change.path === filePath)) {
      changes.push({ path: filePath, added: 0, removed: 0 });
    }
  }
  return changes;
}

export async function worktreeDiffPatch(worktreePath: string): Promise<string> {
  const untracked = (await git(worktreePath, ['ls-files', '--others', '--exclude-standard']))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (untracked.length > 0) await git(worktreePath, ['add', '-N', '--', ...untracked]);
  return git(worktreePath, ['diff', 'HEAD', '--']);
}

export async function applyWorktreePatch(repoCwd: string, patch: string): Promise<void> {
  if (!patch.trim()) return;
  await gitWithStdin(repoCwd, ['apply', '--whitespace=nowarn', '-'], patch);
}
