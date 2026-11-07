import { z } from 'zod';

// Branch names reach the git command line, so they may not start with a dash, contain "..", or use unusual characters.
export const gitBranchNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][\w./-]*$/, 'Use letters, numbers, dots, dashes, underscores and slashes.')
  .refine((name) => !name.includes('..') && !name.endsWith('/') && !name.endsWith('.lock') && !name.includes('//'), 'That is not a valid branch name.');

export const githubRepositoryRefSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'Use a GitHub owner/repository name.');

/**
 * A repository name reaches the `gh` command line, so it may not start with a dash. GitHub itself refuses names
 * ending in a dot or in ".git", and so does this, so the person hears it here rather than from the API.
 */
export const githubRepoNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][\w.-]*$/, 'Use letters, numbers, dots, dashes and underscores.')
  .refine((name) => !name.endsWith('.') && !name.toLowerCase().endsWith('.git'), 'A repository name cannot end with a dot or with ".git".');

export const gitChangeSchema = z
  .object({
    path: z.string().min(1),
    // One letter each, as in `git status --porcelain`: M modified, A added, D deleted, R renamed, ? untracked.
    index: z.string().length(1),
    worktree: z.string().length(1),
    staged: z.boolean(),
    unstaged: z.boolean(),
  })
  .strict();

export const gitBranchSchema = z
  .object({
    name: z.string().min(1),
    current: z.boolean(),
    upstream: z.string().nullable(),
    subject: z.string(),
  })
  .strict();

export const gitCommitSummarySchema = z
  .object({ hash: z.string().min(1), subject: z.string(), author: z.string(), date: z.string() })
  .strict();

// The combined state of a pull request's CI checks, rolled up from however many checks GitHub ran.
// "none" covers both a PR with no checks configured and one whose checks haven't started yet.
export const gitChecksStateSchema = z.enum(['passing', 'failing', 'pending', 'none']);

export const gitPullRequestSchema = z
  .object({ number: z.number().int(), title: z.string(), url: z.string(), state: z.string(), checksState: gitChecksStateSchema })
  .strict();

/** Whether the GitHub CLI is installed, and who it is signed in as. Useful before a project has a GitHub remote. */
export const gitGithubStateSchema = z.object({ cliAvailable: z.boolean(), signedInAs: z.string().nullable() }).strict();

export const gitOverviewSchema = z
  .object({
    isRepository: z.boolean(),
    branch: z.string().nullable(),
    detached: z.boolean(),
    upstream: z.string().nullable(),
    ahead: z.number().int().nonnegative(),
    behind: z.number().int().nonnegative(),
    remotes: z.array(z.object({ name: z.string(), url: z.string() }).strict()),
    // "owner/name" when origin points at GitHub.
    githubRepository: z.string().nullable(),
    branches: z.array(gitBranchSchema),
    changes: z.array(gitChangeSchema),
    commits: z.array(gitCommitSummarySchema),
    // GitHub CLI state: whether `gh` is installed and signed in, so pull requests can be offered.
    github: gitGithubStateSchema,
    pullRequests: z.array(gitPullRequestSchema),
  })
  .strict();

const projectInput = { projectId: z.string().min(1) };

export const gitStageInputSchema = z
  .object({ ...projectInput, paths: z.array(z.string().min(1).max(1_000)).min(1).max(500), stage: z.boolean() })
  .strict();
export const gitCommitInputSchema = z.object({ ...projectInput, message: z.string().trim().min(1).max(10_000) }).strict();
export const gitCheckoutInputSchema = z.object({ ...projectInput, branch: gitBranchNameSchema }).strict();
export const gitCreateBranchInputSchema = z.object({ ...projectInput, name: gitBranchNameSchema, checkout: z.boolean() }).strict();
export const gitSyncInputSchema = z.object({ ...projectInput, action: z.enum(['fetch', 'pull', 'push']) }).strict();
export const gitTeamBranchInputSchema = z.object({ ...projectInput, repository: githubRepositoryRefSchema, branch: gitBranchNameSchema }).strict();
export const gitTeamCloneInputSchema = z.object({ repository: githubRepositoryRefSchema }).strict();
export const gitTeamCloneResultSchema = z.object({ projectId: z.string().min(1), path: z.string().min(1) }).strict();
export const gitDiffInputSchema = z.object({ ...projectInput, path: z.string().min(1).max(1_000), staged: z.boolean() }).strict();
export const gitBlameInputSchema = z.object({ ...projectInput, path: z.string().min(1).max(1_000) }).strict();
/** Who last changed each line of a file, one entry per line in order. A line not committed yet has no `commit`. */
export const gitBlameResultSchema = z
  .object({
    lines: z.array(z.object({ commit: z.string().max(64).optional(), author: z.string().max(200), time: z.number().int().nonnegative(), summary: z.string().max(500) }).strict()).max(200_000),
  })
  .strict();
export type GitBlameResult = z.infer<typeof gitBlameResultSchema>;
/** Lines of a file that differ from the last commit, as ranges of the file as it is now (for the editor's change bars). */
export const gitChangesResultSchema = z
  .object({
    hunks: z.array(z.object({ start: z.number().int().min(1), count: z.number().int().min(0), kind: z.enum(['added', 'modified', 'deleted']) }).strict()).max(5_000),
  })
  .strict();
export type GitChangesResult = z.infer<typeof gitChangesResultSchema>;
/** To-do markers found across the project's files. */
export const todoScanInputSchema = z.object({ ...projectInput }).strict();
export const todoScanResultSchema = z
  .object({
    items: z.array(z.object({ path: z.string().max(1_000), line: z.number().int().min(1), kind: z.string().max(10), text: z.string().max(300) }).strict()).max(1_000),
    truncated: z.boolean(),
  })
  .strict();
export type TodoScanResult = z.infer<typeof todoScanResultSchema>;
export const gitPullRequestInputSchema = z
  .object({ ...projectInput, title: z.string().trim().min(1).max(256), body: z.string().max(20_000) })
  .strict();

export const gitCreateRepositoryInputSchema = z
  .object({ ...projectInput, name: githubRepoNameSchema, visibility: z.enum(['private', 'public']) })
  .strict();

export const gitActionResultSchema = z.object({ output: z.string() }).strict();
export const gitPullRequestResultSchema = z.object({ url: z.string() }).strict();
/** "owner/name" as GitHub reports it, plus the address to open. */
export const gitCreateRepositoryResultSchema = z.object({ repository: z.string().min(1), url: z.string() }).strict();

export type GitOverview = z.infer<typeof gitOverviewSchema>;
export type GitPullRequest = z.infer<typeof gitPullRequestSchema>;
export type GitChecksState = z.infer<typeof gitChecksStateSchema>;
export type GitGithubState = z.infer<typeof gitGithubStateSchema>;
export type GitChange = z.infer<typeof gitChangeSchema>;
export type GitBranch = z.infer<typeof gitBranchSchema>;
export type GitActionResult = z.infer<typeof gitActionResultSchema>;
export type GitSyncAction = z.infer<typeof gitSyncInputSchema>['action'];
export type GitCreateRepositoryResult = z.infer<typeof gitCreateRepositoryResultSchema>;
/** Who can see a repository on GitHub. Named explicitly at creation; there is no default. */
export type GitRepositoryVisibility = z.infer<typeof gitCreateRepositoryInputSchema>['visibility'];
