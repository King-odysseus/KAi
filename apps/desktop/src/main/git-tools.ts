import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  gitBranchNameSchema,
  githubRepositoryRefSchema,
  githubRepoNameSchema,
  type GitActionResult,
  type GitBranch,
  type GitChange,
  type GitChecksState,
  type GitCreateRepositoryResult,
  type GitOverview,
  type GitRepositoryVisibility,
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

/** GitHub account readiness is useful even before a project has a GitHub remote. */
export async function githubCliStatus(cwd: string): Promise<GitOverview['github']> {
  return githubState(cwd);
}

// One entry of `gh pr list --json statusCheckRollup`. A check run (from GitHub Actions) reports `status` and
// `conclusion`; an older-style commit status reports `state` instead. A pull request can have either kind, or both.
interface PullRequestCheckRollupEntry {
  status?: string | null;
  conclusion?: string | null;
  state?: string | null;
}

/** Rolls up a pull request's individual checks into one state, the way GitHub's own PR page does. */
export function rollUpChecksState(rollup: readonly PullRequestCheckRollupEntry[]): GitChecksState {
  if (rollup.length === 0) return 'none';
  let sawFailure = false;
  let sawPending = false;
  for (const entry of rollup) {
    const status = entry.status?.toUpperCase();
    const conclusion = entry.conclusion?.toUpperCase();
    const state = entry.state?.toUpperCase();
    if (status && status !== 'COMPLETED') {
      sawPending = true;
      continue;
    }
    if (conclusion) {
      if (conclusion === 'FAILURE' || conclusion === 'TIMED_OUT' || conclusion === 'CANCELLED' || conclusion === 'ACTION_REQUIRED') sawFailure = true;
      else if (conclusion !== 'SUCCESS' && conclusion !== 'NEUTRAL' && conclusion !== 'SKIPPED') sawPending = true;
      continue;
    }
    if (state) {
      if (state === 'FAILURE' || state === 'ERROR') sawFailure = true;
      else if (state === 'PENDING') sawPending = true;
    }
  }
  if (sawFailure) return 'failing';
  if (sawPending) return 'pending';
  return 'passing';
}

/**
 * Starts a repository in the project folder, and answers with the overview the Git page needs either way.
 *
 * `git init` is idempotent, so this is safe to offer as a plain button. The initial branch is named explicitly
 * because an empty repository otherwise sits on an unborn branch whose name the page cannot show, and a person is
 * left with no branch to choose.
 */
export async function gitInit(cwd: string): Promise<GitOverview> {
  await git(cwd, ['init']);
  await git(cwd, ['symbolic-ref', 'HEAD', 'refs/heads/main']).catch(() => '');
  return gitOverview(cwd);
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
      const listed = await run('gh', cwd, ['pr', 'list', '--head', branch, '--json', 'number,title,url,state,statusCheckRollup', '--limit', '5'], 30_000);
      const parsed = JSON.parse(listed || '[]') as Array<{ number: number; title: string; url: string; state: string; statusCheckRollup?: PullRequestCheckRollupEntry[] | null }>;
      pullRequests = parsed.map((pr) => ({
        number: pr.number,
        title: pr.title,
        url: pr.url,
        state: pr.state,
        checksState: rollUpChecksState(pr.statusCheckRollup ?? []),
      }));
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

/** Bring a teammate's published branch into a clean checkout of the same GitHub repository. */
export async function gitPullTeamBranch(cwd: string, repository: string, branch: string): Promise<GitActionResult> {
  githubRepositoryRefSchema.parse(repository);
  gitBranchNameSchema.parse(branch);
  const origin = parseGithubRepository(await git(cwd, ['remote', 'get-url', 'origin']));
  if (origin?.toLowerCase() !== repository.toLowerCase()) throw new GitCommandError('This folder is linked to a different GitHub repository.');
  if ((await git(cwd, ['status', '--porcelain', '--untracked-files=all'])).trim()) throw new GitCommandError('Commit or stash local changes before switching branches.');
  await git(cwd, ['fetch', '--prune', 'origin', branch], NETWORK_TIMEOUT_MS);
  await git(cwd, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
  const local = await git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);
  if (local && !(await git(cwd, ['merge-base', '--is-ancestor', `refs/heads/${branch}`, `refs/remotes/origin/${branch}`]).then(() => true, () => false))) {
    throw new GitCommandError('The local branch has diverged from the teammate’s branch. Review it in Git before switching.');
  }
  await git(cwd, local ? ['switch', branch] : ['switch', '--track', '-c', branch, `origin/${branch}`]);
  const output = await git(cwd, ['merge', '--ff-only', `origin/${branch}`]);
  return { output: output || `Switched to ${branch} and brought it up to date.` };
}

/** Clone a named GitHub repository into a new folder beneath the directory the user chose. */
export async function gitCloneTeamRepository(parent: string, repository: string): Promise<string> {
  githubRepositoryRefSchema.parse(repository);
  const name = repository.split('/')[1]!;
  const destination = join(parent, name);
  if (await access(destination).then(() => true, () => false)) throw new GitCommandError(`A folder named ${name} already exists there. Choose another parent folder.`);
  await git(parent, ['clone', `https://github.com/${repository}.git`, name], NETWORK_TIMEOUT_MS);
  return destination;
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

/**
 * Who last changed each line, for the editor's inline blame. `--line-porcelain` repeats the commit's header for every
 * line, so the result is one entry per line in file order with no bookkeeping. A file Git does not know (new, ignored,
 * outside a repository) has nothing to blame and gives no lines rather than an error.
 */
export async function gitBlameFile(cwd: string, filePath: string): Promise<{ lines: Array<{ commit?: string; author: string; time: number; summary: string }> }> {
  const output = await git(cwd, ['blame', '--line-porcelain', '--', filePath]).catch(() => '');
  const lines: Array<{ commit?: string; author: string; time: number; summary: string }> = [];
  let current: { commit?: string; author: string; time: number; summary: string } | null = null;
  for (const row of output.split(/\r?\n/)) {
    const header = /^([0-9a-f]{40}) \d+ \d+/.exec(row);
    if (header) {
      current = { commit: /^0+$/.test(header[1]!) ? undefined : header[1]!.slice(0, 8), author: '', time: 0, summary: '' };
    } else if (current && row.startsWith('author ')) current.author = row.slice(7, 207);
    else if (current && row.startsWith('author-time ')) current.time = Number.parseInt(row.slice(12), 10) || 0;
    else if (current && row.startsWith('summary ')) current.summary = row.slice(8, 508);
    else if (current && row.startsWith('\t')) {
      lines.push(current);
      current = null;
    }
  }
  return { lines: lines.slice(0, 200_000) };
}

/**
 * Everything a file changed against the last commit, staged or not, as one diff. A file that is untracked (new) is
 * compared with nothing. This is what a review should read: the unstaged-only diff is empty for a change that has
 * already been staged.
 */
export async function gitDiffAgainstHead(cwd: string, filePath: string): Promise<string> {
  // Whether the file is in the last commit decides how to read it, not whether Git tracks it now: a staged deletion is
  // no longer tracked but still has a diff, and a staged new file is tracked but has nothing to compare with.
  const inHead = await git(cwd, ['cat-file', '-e', `HEAD:${filePath}`]).then(() => true, () => false);
  const output = inHead
    ? await git(cwd, ['diff', 'HEAD', '--no-color', '--', filePath]).catch(() => '')
    : await git(cwd, ['diff', '--no-index', '--no-color', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', filePath])
      // `git diff --no-index` exits 1 when the files differ, which is the normal case here.
      .catch((error: GitCommandError) => error.stdout ?? '');
  return output.length > MAX_DIFF_CHARS ? `${output.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated]` : output;
}

/**
 * The `gh repo create` arguments for a repository that is already a folder on disk: the repository is named, its
 * visibility is stated outright rather than left to a prompt, and `--source . --remote origin` makes this folder the
 * repository's working copy. There is deliberately no `--push`, so creating the repository never uploads code; the
 * Publish branch button is the one confirmed step that sends work off the machine.
 */
export function createRepositoryArgs(name: string, visibility: GitRepositoryVisibility): string[] {
  return ['repo', 'create', name, visibility === 'private' ? '--private' : '--public', '--source', '.', '--remote', 'origin'];
}

/**
 * Creates the repository on GitHub under the signed-in account and wires it up as `origin`. Nothing is uploaded:
 * a repository with no commits is a valid result, and the Git page offers Publish branch next.
 */
export async function gitCreateRepository(cwd: string, name: string, visibility: GitRepositoryVisibility): Promise<GitCreateRepositoryResult> {
  githubRepoNameSchema.parse(name);
  const output = await run('gh', cwd, createRepositoryArgs(name, visibility), NETWORK_TIMEOUT_MS);
  const url = output.split('\n').map((line) => line.trim()).find((line) => /^https:\/\/github\.com\//.test(line)) ?? '';
  const repository = parseGithubRepository(url) ?? name;
  return { repository, url: url || `https://github.com/${repository}` };
}

export async function gitCreatePullRequest(cwd: string, title: string, body: string): Promise<{ url: string }> {
  const branch = (await git(cwd, ['branch', '--show-current'])).trim();
  if (!branch) throw new GitCommandError('Switch to a branch before opening a pull request.');
  const output = await run('gh', cwd, ['pr', 'create', '--title', title, '--body', body, '--head', branch], NETWORK_TIMEOUT_MS);
  const url = output.split('\n').map((line) => line.trim()).find((line) => /^https:\/\/github\.com\/.+\/pull\/\d+/.test(line));
  if (!url) throw new GitCommandError(output || 'GitHub did not return a pull request address.');
  return { url };
}
