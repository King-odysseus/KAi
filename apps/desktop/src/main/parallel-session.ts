import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  addWorktree,
  attemptDiff,
  carryCommit,
  applyToWorkingTree,
  changedFiles,
  commitWorktree,
  headCommit,
  mergeCommit,
  removeWorktree,
  repositoryFor,
  snapshotWorkingTree,
} from './git-worktrees';

export interface IntegrationResult {
  /** Parts whose changes clashed with an earlier part's; their work was not applied. */
  conflicts: Array<{ stepId: string; files: string[]; diff?: string; commit?: string }>;
  applied: string[];
  /** Files changed in the real project while the parts worked; the user's version was kept. */
  skipped: string[];
  /** The merged result, kept in the repository's objects so a skipped file can still be looked at. */
  integrationCommit: string;
  /** Files the project had changed too, in other places, that were combined with the parts' changes. */
  merged?: string[];
  /**
   * Puts back every file this merge changed in the project exactly as it was before. For a part whose check then
   * failed, so its changes do not stay in the project and fail everyone else's check as well.
   */
  undo?: () => Promise<void>;
}

/** One wave of parts running side by side, each in its own checkout of the same snapshot. */
export interface ParallelSession {
  /** A separate checkout for a part; returns the folder the part should work in. */
  checkout(stepId: string): Promise<string>;
  /** Records what the part changed; the snapshot itself when it changed nothing. */
  commit(stepId: string, message: string): Promise<string>;
  /** The files a commit changed against the snapshot the wave started from, as paths from the repository root. */
  filesChanged(commit: string): Promise<string[]>;
  /** Merges the parts' commits in the given order and copies the result into the real project. */
  integrate(commits: ReadonlyArray<{ stepId: string; commit: string }>): Promise<IntegrationResult>;
  /**
   * Puts an earlier commit's changes into a part's fresh checkout, uncommitted, so the part carries on from it
   * instead of starting over. False when they no longer apply cleanly; the checkout is then left as it was.
   */
  carry?(stepId: string, commit: string): Promise<boolean>;
  /** Removes every checkout. Safe to call more than once. */
  dispose(): Promise<void>;
}

const safeName = (value: string): string => value.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60) || 'part';
const activeDirectories = new Set<string>();

export function activeParallelDirectories(): string[] {
  return [...activeDirectories];
}

/**
 * Starts a wave for a project: a snapshot of its working tree now, and a folder of checkouts outside the project.
 * Null when the project is not a git repository with at least one commit, in which case parts run one at a time.
 */
export async function createParallelSession(
  projectPath: string,
  key: string,
  baseDirectory = path.join(os.tmpdir(), 'kai-parallel'),
): Promise<ParallelSession | null> {
  const repository = await repositoryFor(projectPath);
  if (!repository) return null;
  const directory = path.join(baseDirectory, safeName(key));
  activeDirectories.add(path.resolve(directory));
  let snapshot: string;
  try {
    // A wave that crashed before cleaning up may have left its checkouts behind; start from nothing.
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    snapshot = await snapshotWorkingTree(repository.root);
  } catch (error) {
    activeDirectories.delete(path.resolve(directory));
    throw error;
  }
  const checkouts = new Map<string, string>();
  const workFolder = (checkout: string): string => (repository.prefix ? path.join(checkout, repository.prefix) : checkout);

  return {
    async checkout(stepId) {
      const folder = path.join(directory, safeName(stepId));
      await addWorktree(repository.root, folder, snapshot);
      checkouts.set(stepId, folder);
      return workFolder(folder);
    },

    async commit(stepId, message) {
      const folder = checkouts.get(stepId);
      if (!folder) throw new Error(`No checkout was made for "${stepId}".`);
      return commitWorktree(folder, message);
    },

    async filesChanged(commit) {
      if (commit === snapshot) return [];
      return (await changedFiles(repository.root, snapshot, commit)).map((change) => change.file);
    },

    async integrate(commits) {
      const integration = path.join(directory, '_integration');
      await addWorktree(repository.root, integration, snapshot, false);
      checkouts.set('\0integration', integration);
      const conflicts: IntegrationResult['conflicts'] = [];
      for (const { stepId, commit } of commits) {
        if (commit === snapshot) continue;
        const merged = await mergeCommit(integration, commit, `KAI: merge ${stepId}`);
        if (!merged.ok) conflicts.push({ stepId, files: merged.files, commit, diff: await attemptDiff(repository.root, snapshot, commit) });
      }
      const integrationCommit = await headCommit(integration);
      const changes = await changedFiles(integration, snapshot, integrationCommit);
      // The project's own copy of every file the merge may touch, so the merge can be taken back out whole.
      const before = await Promise.all(changes.map(async (change) => ({
        file: change.file,
        content: await fs.readFile(path.join(repository.root, change.file)).catch(() => null),
      })));
      const { applied, skipped, merged } = await applyToWorkingTree(repository.root, snapshot, integration, changes);
      const undo = async (): Promise<void> => {
        for (const { file, content } of before) {
          if (!applied.includes(file)) continue;
          const live = path.join(repository.root, file);
          if (content === null) {
            await fs.rm(live, { force: true });
          } else {
            await fs.mkdir(path.dirname(live), { recursive: true });
            await fs.writeFile(live, content);
          }
        }
      };
      return { conflicts, applied, skipped, merged, integrationCommit, undo };
    },

    async carry(stepId, commit) {
      const folder = checkouts.get(stepId);
      if (!folder) return false;
      return carryCommit(folder, commit);
    },

    async dispose() {
      for (const folder of checkouts.values()) await removeWorktree(repository.root, folder).catch(() => undefined);
      checkouts.clear();
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
      activeDirectories.delete(path.resolve(directory));
    },
  };
}
