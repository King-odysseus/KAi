/**
 * Which name this project is filed under in the C1 brain.
 *
 * Agents file memories under a project name, and C1 matches that name exactly when it recalls them. KAI used to guess
 * the name from package.json, so a repo whose folder is `KAi` but whose manifest says "KAI Agent Workbench" asked for a
 * project the brain had never heard of and silently got nothing back. Resolution now prefers a name the brain actually
 * holds, and reports when it had to guess so the caller can say so instead of showing an empty list.
 */

export interface KnownBrainProject {
  name: string;
  /** Where the brain believes the project lives, when its notes record a path. */
  path?: string | null;
}

export interface BrainProjectCandidates {
  /** Absolute path of the open project. */
  projectPath: string;
  /** What KAI calls the project, which is usually its folder name. */
  projectName: string;
  packageName?: string | null;
  packageDisplayName?: string | null;
}

export type BrainProjectSource = 'override' | 'path' | 'name' | 'fallback';

export interface BrainProjectResolution {
  name: string;
  source: BrainProjectSource;
  /** False when nothing in the brain matched, so a recall is expected to come back empty. */
  matched: boolean;
}

/** Compare names the way a person would: case, spaces, dashes and underscores do not make two names different. */
function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizePath(value: string): string {
  return value.trim().toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
}

function folderNameOf(projectPath: string): string {
  const segments = normalizePath(projectPath).split('/').filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : '';
}

export function resolveBrainProject(
  candidates: BrainProjectCandidates,
  known: readonly KnownBrainProject[] = [],
  override?: string | null,
): BrainProjectResolution {
  const chosen = override?.trim();
  if (chosen) return { name: chosen, source: 'override', matched: true };

  const projectPath = normalizePath(candidates.projectPath);
  if (projectPath) {
    for (const entry of known) {
      if (entry.path && normalizePath(entry.path) === projectPath) {
        return { name: entry.name, source: 'path', matched: true };
      }
    }
  }

  // The folder name comes before the manifest because that is what agents pass when they file a memory.
  const folder = folderNameOf(candidates.projectPath);
  const ordered = [candidates.projectName, folder, candidates.packageDisplayName, candidates.packageName];
  for (const candidate of ordered) {
    const normalized = candidate ? normalizeName(candidate) : '';
    if (!normalized) continue;
    for (const entry of known) {
      if (normalizeName(entry.name) === normalized) {
        return { name: entry.name, source: 'name', matched: true };
      }
    }
  }

  const fallback = candidates.projectName.trim() || folder;
  return { name: fallback, source: 'fallback', matched: false };
}

/** Why a recall came back empty, in words the context panel can show. */
export function brainProjectNote(resolution: BrainProjectResolution, recalled: number): string {
  if (recalled > 0) return `${recalled} memor${recalled === 1 ? 'y' : 'ies'} recalled from "${resolution.name}".`;
  if (!resolution.matched) {
    return `No memories yet. C1 has nothing filed under "${resolution.name}", so this project starts empty.`;
  }
  return `No memories matched this request under "${resolution.name}".`;
}
