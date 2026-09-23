import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  gitBranchNameSchema,
  type GitActionResult,
  type GitBranch,
  type GitChange,
  type GitOverview,
  type GitSyncAction,
} from '@kai/contracts';
import { isGitRepo } from './checkpoints';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 10 * 1024 * 1024;
const NETWORK_TIMEOUT_MS = 120_000;
const MAX_DIFF_CHARS = 100_000;

export class GitCommandError extends Error {
  /** Standard output captured before the failure; some commands (git diff --no-index) print their result and exit 1. */
  stdout = '';
}

async function run(command: string, cwd: string, args: string[], timeout = 30_000, trim = true): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      maxBuffer: MAX_BUFFER,
      timeout,
      windowsHide: true,
      // Never prompt in a terminal that does not exist; a missing login must fail fast with a clear message.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' },
    });
    // Porcelain formats start with a meaningful space, so callers that parse them ask for the raw text.
    return trim ? `${stdout}${stderr ? `\n${stderr}` : ''}`.trim() : stdout;
  } catch (error) {
    const failure = error as { stderr?: string; stdout?: string; message?: string; killed?: boolean };
    if (failure.killed) throw new GitCommandError(`${command} ${args[0] ?? ''} timed out.`);
    const wrapped = new GitCommandError((failure.stderr || failure.stdout || failure.message || 'The command failed.').toString().trim());
    wrapped.stdout = (failure.stdout ?? '').toString();
    throw wrapped;
  }
}

const git = (cwd: string, args: string[], timeout?: number): Promise<string> => run('git', cwd, args, timeout);
const gitRaw = (cwd: string, args: string[]): Promise<string> => run('git', cwd, args, 30_000, false);

/** "owner/name" for a github.com remote URL in https or ssh form. */
export function parseGithubRepository(url: string): string | null {
  const match = /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

/** Parse `git status --porcelain=v1 -z`. Renames list their old path as an extra entry, which is skipped. */
export function parseStatus(output: string): GitChange[] {
  const changes: GitChange[] = [];
  const entries = output.split('\0').filter(Boolean);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const indexState = entry[0] ?? ' ';
    const worktreeState = entry[1] ?? ' ';
    changes.push({
      path: entry.slice(3),
      index: indexState === ' ' ? '.' : indexState,
      worktree: worktreeState === ' ' ? '.' : worktreeState,
      staged: indexState !== ' ' && indexState !== '?',
      unstaged: worktreeState !== ' ' || indexState === '?',
    });
    if (indexState === 'R' || indexState === 'C') index += 1;
  }
  return changes;
}

export function parseBranches(output: string): GitBranch[] {
  return output.split('\n').filter(Boolean).map((line) => {
    const [head, name, upstream, subject] = line.split('\t');
    return { name: name ?? '', current: head === '*', upstream: upstream || null, subject: subject ?? '' };
  }).filter((branch) => branch.name && !branch.name.includes('HEAD detached'));
}

function parseCounts(output: string): { ahead: number; behind: number } {
  const [ahead, behind] = output.trim().split(/\s+/).map((value) => Number.parseInt(value, 10));
  return { ahead: Number.isFinite(ahead) ? ahead! : 0, behind: Number.isFinite(behind) ? behind! : 0 };
}

async function githubState(cwd: string): Promise<GitOverview['github']> {
  try {
    await run('gh', cwd, ['--version'], 10_000);
  } catch {
    return { cliAvailable: false, signedInAs: null };
  }
  try {
    const user = await run('gh', cwd, ['api', 'user', '--jq', '.login'], 15_000);
    return { cliAvailable: true, signedInAs: user.split('\n')[0]?.trim() || null };
  } catch {
    return { cliAvailable: true, signedInAs: null };
  }
}

export async function gitOverview(cwd: string): Promise<GitOverview> {
  const empty: GitOverview = {
    isRepository: false, branch: null, detached: false, upstream: null, ahead: 0, behind: 0, remotes: [],
    githubRepository: null, branches: [], changes: [], commits: [], github: { cliAvailable: false, signedInAs: null }, pullRequests: [],
  };
  if (!(await isGitRepo(cwd))) return empty;

  const safe = async (args: string[]): Promise<string> => git(cwd, args).catch(() => '');
  const [branchName, statusOutput, branchOutput, remoteOutput, logOutput] = await Promise.all([
    safe(['branch', '--show-current']),
    gitRaw(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).catch(() => ''),
    safe(['for-each-ref', '--format=%(HEAD)\t%(refname:short)\t%(upstream:short)\t%(contents:subject)', 'refs/heads']),
    safe(['remote', '-v']),
    safe(['log', '-n', '20', '--format=%h\t%s\t%an\t%aI']),
  ]);
  const branch = branchName.trim() || null;
  const upstream = branch ? (await safe(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim() || null : null;
  const counts = upstream ? parseCounts(await safe(['rev-list', '--left-right', '--count', 'HEAD...@{u}'])) : { ahead: 0, behind: 0 };

  const remotes = new Map<string, string>();
  for (const line of remoteOutput.split('\n')) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    if (match) remotes.set(match[1]!, match[2]!);
  }
  const origin = remotes.get('origin') ?? [...remotes.values()][0] ?? '';
  const githubRepository = parseGithubRepository(origin);

  const github = githubRepository ? await githubState(cwd) : { cliAvailable: false, signedInAs: null };
  let pullRequests: GitOverview['pullRequests'] = [];
  if (githubRepository && github.signedInAs && branch) {
    try {
      const listed = await run('gh', cwd, ['pr', 'list', '--head', branch, '--json', 'number,title,url,state', '--limit', '5'], 30_000);
      pullRequests = (JSON.parse(listed || '[]') as GitOverview['pullRequests']).map((pr) => ({ number: pr.number, title: pr.title, url: pr.url, state: pr.state }));
    } catch {
      pullRequests = [];
    }
  }

  return {
    isRepository: true,
    branch,
    detached: branch === null,
    upstream,
    ...counts,
    remotes: [...remotes].map(([name, url]) => ({ name, url })),
    githubRepository,
    branches: parseBranches(branchOutput),
    changes: parseStatus(statusOutput),
    commits: logOutput.split('\n').filter(Boolean).map((line) => {
      const [hash, subject, author, date] = line.split('\t');
      return { hash: hash ?? '', subject: subject ?? '', author: author ?? '', date: date ?? '' };
    }),
    github,
    pullRequests,
  };
}

export async function gitStage(cwd: string, paths: readonly string[], stage: boolean): Promise<GitActionResult> {
  // `--` keeps a path that looks like an option from being read as one.
  const output = stage
    ? await git(cwd, ['add', '--', ...paths])
    : await git(cwd, ['restore', '--staged', '--', ...paths]).catch(() => git(cwd, ['rm', '--cached', '-r', '--', ...paths]));
  return { output };
}

export async function gitCommit(cwd: string, message: string): Promise<GitActionResult> {
  const staged = await git(cwd, ['diff', '--cached', '--name-only']);
  if (!staged.trim()) throw new GitCommandError('Nothing is staged. Stage the files you want in the commit first.');
  // Repository hooks (pre-commit and so on) run as normal; KAI never skips them.
  return { output: await git(cwd, ['commit', '-m', message], 120_000) };
}

export async function gitCheckout(cwd: string, branch: string): Promise<GitActionResult> {
  gitBranchNameSchema.parse(branch);
  return { output: await git(cwd, ['switch', branch]) };
}

export async function gitCreateBranch(cwd: string, name: string, checkout: boolean): Promise<GitActionResult> {
  gitBranchNameSchema.parse(name);
  return { output: checkout ? await git(cwd, ['switch', '-c', name]) : await git(cwd, ['branch', name]) };
}

/** Fetch, fast-forward pull, or push the current branch. There is deliberately no force push. */
export async function gitSync(cwd: string, action: GitSyncAction): Promise<GitActionResult> {
  if (action === 'fetch') return { output: await git(cwd, ['fetch', '--prune'], NETWORK_TIMEOUT_MS) || 'Fetched.' };
  if (action === 'pull') return { output: await git(cwd, ['pull', '--ff-only'], NETWORK_TIMEOUT_MS) };
  const branch = (await git(cwd, ['branch', '--show-current'])).trim();
  if (!branch) throw new GitCommandError('Switch to a branch before pushing.');
  const hasUpstream = (await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '')).trim() !== '';
  return { output: await git(cwd, hasUpstream ? ['push'] : ['push', '-u', 'origin', branch], NETWORK_TIMEOUT_MS) };
}

export async function gitDiffFile(cwd: string, filePath: string, staged: boolean): Promise<GitActionResult> {
  const tracked = await git(cwd, ['ls-files', '--error-unmatch', '--', filePath]).then(() => true, () => false);
  const args = tracked
    ? ['diff', ...(staged ? ['--cached'] : []), '--no-color', '--', filePath]
    : ['diff', '--no-index', '--no-color', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', filePath];
  // `git diff --no-index` exits 1 when the files differ, which is the normal case here.
  const output = await git(cwd, args).catch((error: GitCommandError) => (args.includes('--no-index') && error.stdout ? error.stdout : Promise.reject(error)));
  return { output: output.length > MAX_DIFF_CHARS ? `${output.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated]` : output };
}

export async function gitCreatePullRequest(cwd: string, title: string, body: string): Promise<{ url: string }> {
  const branch = (await git(cwd, ['branch', '--show-current'])).trim();
  if (!branch) throw new GitCommandError('Switch to a branch before opening a pull request.');
  const output = await run('gh', cwd, ['pr', 'create', '--title', title, '--body', body, '--head', branch], NETWORK_TIMEOUT_MS);
  const url = output.split('\n').map((line) => line.trim()).find((line) => /^https:\/\/github\.com\/.+\/pull\/\d+/.test(line));
  if (!url) throw new GitCommandError(output || 'GitHub did not return a pull request address.');
  return { url };
}
