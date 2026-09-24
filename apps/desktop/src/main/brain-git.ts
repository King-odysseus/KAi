import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { promisify } from 'node:util';
import type { BrainGitStatus, BrainGitSyncAction, BrainGitSyncResult } from '@kai/contracts';

const execFileAsync = promisify(execFile);
const OUTPUT_LIMIT = 2_000;
const NETWORK_TIMEOUT_MS = 120_000;

/** Inspect the shared C1 brain repository without changing it. */
export async function brainGitStatus(brainPath: string): Promise<BrainGitStatus> {
  const base: BrainGitStatus = {
    repository: false,
    branch: null,
    remote: null,
    clean: true,
    changedFiles: 0,
    ahead: 0,
    behind: 0,
    path: brainPath,
    error: null,
  };
  try {
    await fs.access(brainPath);
    // An existing folder that has not been initialized is a valid actionable state, not an error.
    const repository = (await git(brainPath, ['rev-parse', '--is-inside-work-tree']).catch(() => 'false')).trim() === 'true';
    if (!repository) return base;
    const [branchOutput, remoteOutput, statusOutput, upstreamOutput] = await Promise.all([
      git(brainPath, ['branch', '--show-current']).catch(() => ''),
      git(brainPath, ['remote', 'get-url', 'origin']).catch(() => ''),
      git(brainPath, ['status', '--porcelain=v1', '--untracked-files=all']).catch(() => ''),
      git(brainPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => ''),
    ]);
    const branch = branchOutput.trim() || null;
    const upstream = upstreamOutput.trim();
    const counts = upstream
      ? await git(brainPath, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']).catch(() => '0\t0')
      : '0\t0';
    const [ahead = 0, behind = 0] = counts.trim().split(/\s+/).map((value) => Number.parseInt(value, 10) || 0);
    const changes = statusOutput.split('\n').filter(Boolean);
    return {
      repository: true,
      branch,
      remote: remoteOutput.trim() || null,
      clean: changes.length === 0,
      changedFiles: changes.length,
      ahead,
      behind,
      path: brainPath,
      error: null,
    };
  } catch (error) {
    return { ...base, error: messageOf(error) };
  }
}

/** Run one explicit brain sync action. Network operations never prompt interactively. */
export async function syncBrainGit(brainPath: string, action: BrainGitSyncAction): Promise<BrainGitSyncResult> {
  let message = '';
  try {
    await fs.mkdir(brainPath, { recursive: true });
    let status = await brainGitStatus(brainPath);
    if (action === 'init') {
      if (!status.repository) {
        message = (await git(brainPath, ['init'])).trim() || 'Initialized the brain repository.';
      } else {
        message = 'The brain is already a Git repository.';
      }
    } else if (!status.repository) {
      throw new Error('Initialize the brain repository before using Git sync.');
    } else if (action === 'commit') {
      await git(brainPath, ['add', '-A']);
      const staged = (await git(brainPath, ['diff', '--cached', '--name-only'])).trim();
      message = staged
        ? (await git(brainPath, ['commit', '-m', `KAI brain sync ${new Date().toISOString()}`], NETWORK_TIMEOUT_MS)).trim() || 'Committed brain changes.'
        : 'No brain changes to commit.';
    } else if (action === 'pull') {
      message = (await git(brainPath, ['pull', '--ff-only'], NETWORK_TIMEOUT_MS)).trim() || 'Pulled brain changes.';
    } else {
      const branch = status.branch;
      if (!branch) throw new Error('The brain repository is not on a branch.');
      const upstream = (await git(brainPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '')).trim();
      message = (await git(brainPath, upstream ? ['push'] : ['push', '-u', 'origin', branch], NETWORK_TIMEOUT_MS)).trim() || 'Pushed brain changes.';
    }
    status = await brainGitStatus(brainPath);
    return { action, success: true, message: truncate(message), status };
  } catch (error) {
    return {
      action,
      success: false,
      message: truncate(messageOf(error)),
      status: await brainGitStatus(brainPath),
    };
  }
}

async function git(cwd: string, args: string[], timeout = 30_000): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' },
    });
    return `${stdout}${stderr ? `\n${stderr}` : ''}`;
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error((failure.stderr || failure.stdout || failure.message || 'Git failed.').trim());
  }
}

function truncate(value: string): string {
  const clean = value.trim();
  return clean.length > OUTPUT_LIMIT ? `${clean.slice(0, OUTPUT_LIMIT)}\n[truncated]` : clean;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
