import { z } from 'zod';

// Branch names reach the git command line, so they may not start with a dash, contain "..", or use unusual characters.
export const gitBranchNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][\w./-]*$/, 'Use letters, numbers, dots, dashes, underscores and slashes.')
  .refine((name) => !name.includes('..') && !name.endsWith('/') && !name.endsWith('.lock') && !name.includes('//'), 'That is not a valid branch name.');

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

export const gitPullRequestSchema = z
  .object({ number: z.number().int(), title: z.string(), url: z.string(), state: z.string() })
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
export const gitDiffInputSchema = z.object({ ...projectInput, path: z.string().min(1).max(1_000), staged: z.boolean() }).strict();
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
export type GitGithubState = z.infer<typeof gitGithubStateSchema>;
export type GitChange = z.infer<typeof gitChangeSchema>;
export type GitBranch = z.infer<typeof gitBranchSchema>;
export type GitActionResult = z.infer<typeof gitActionResultSchema>;
export type GitSyncAction = z.infer<typeof gitSyncInputSchema>['action'];
export type GitCreateRepositoryResult = z.infer<typeof gitCreateRepositoryResultSchema>;
/** Who can see a repository on GitHub. Named explicitly at creation; there is no default. */
export type GitRepositoryVisibility = z.infer<typeof gitCreateRepositoryInputSchema>['visibility'];
