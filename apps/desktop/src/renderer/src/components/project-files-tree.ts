import type { GitChange } from '@kai/contracts';

/**
 * The project file tree with Git state laid over it, for the Files tab beside Threads.
 *
 * The project tree comes from the file listing and the state from `git status`, so the two are merged here: each file
 * is marked with what happened to it, folders count how many changed files they hold, and files Git reports as deleted
 * (which the listing no longer contains) are added back so they can still be seen.
 */

export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict';

export interface FileChange {
  kind: ChangeKind;
  staged: boolean;
  unstaged: boolean;
}

export const CHANGE_LABEL: Record<ChangeKind, string> = {
  modified: 'Modified',
  added: 'Added',
  deleted: 'Deleted',
  renamed: 'Renamed',
  untracked: 'Untracked',
  conflict: 'Conflict',
};

/** The one-letter badge shown beside a file. */
export const CHANGE_BADGE: Record<ChangeKind, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflict: '!',
};

const CONFLICTS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/** What a `git status --porcelain` pair of letters means for one file, with conflicts and untracked files singled out. */
export function changeKindOf(change: Pick<GitChange, 'index' | 'worktree'>): ChangeKind {
  const { index, worktree } = change;
  if (index === '?' || worktree === '?') return 'untracked';
  if (CONFLICTS.has(`${index === '.' ? ' ' : index}${worktree === '.' ? ' ' : worktree}`)) return 'conflict';
  if (index === 'D' || worktree === 'D') return 'deleted';
  if (index === 'R' || worktree === 'R' || index === 'C' || worktree === 'C') return 'renamed';
  if (index === 'A') return 'added';
  return 'modified';
}

/** Say in a sentence where a change stands, for a tooltip. */
export function describeChange(change: FileChange): string {
  const label = CHANGE_LABEL[change.kind];
  if (change.kind === 'untracked') return 'Untracked: new file Git is not tracking yet';
  if (change.kind === 'conflict') return 'Conflict: resolve it before committing';
  if (change.staged && change.unstaged) return `${label}, with more changes not yet staged`;
  return change.staged ? `${label}, staged for commit` : `${label}, not staged`;
}

export interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  change: FileChange | null;
  /** How many changed files sit at or below this node. */
  changed: number;
  children: TreeNode[];
}

export interface ChangeSummary {
  total: number;
  counts: Record<ChangeKind, number>;
}

export function summarizeChanges(changes: ReadonlyMap<string, FileChange>): ChangeSummary {
  const counts: Record<ChangeKind, number> = { modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 0, conflict: 0 };
  for (const change of changes.values()) counts[change.kind] += 1;
  return { total: changes.size, counts };
}

export function changeMap(changes: readonly GitChange[]): Map<string, FileChange> {
  const map = new Map<string, FileChange>();
  for (const change of changes) {
    const path = change.path.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!path) continue;
    map.set(path, { kind: changeKindOf(change), staged: change.staged, unstaged: change.unstaged });
  }
  return map;
}

function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Build the tree. With `changesOnly`, only changed files and the folders leading to them are kept. Changed paths missing
 * from `files` (deleted files) are added so they still appear.
 */
export function buildTree(files: readonly string[], changes: ReadonlyMap<string, FileChange>, changesOnly: boolean): TreeNode[] {
  const paths = new Set<string>();
  for (const file of files) paths.add(file.replace(/\\/g, '/'));
  for (const path of changes.keys()) paths.add(path);

  const root: TreeNode = { name: '', path: '', type: 'dir', change: null, changed: 0, children: [] };
  const folders = new Map<string, TreeNode>([['', root]]);

  for (const path of [...paths].sort()) {
    const change = changes.get(path) ?? null;
    if (changesOnly && !change) continue;
    const parts = path.split('/');
    let parent = root;
    let prefix = '';
    for (let i = 0; i < parts.length - 1; i++) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
      let folder = folders.get(prefix);
      if (!folder) {
        folder = { name: parts[i], path: prefix, type: 'dir', change: null, changed: 0, children: [] };
        folders.set(prefix, folder);
        parent.children.push(folder);
      }
      parent = folder;
    }
    parent.children.push({ name: parts[parts.length - 1], path, type: 'file', change, changed: change ? 1 : 0, children: [] });
  }

  const finish = (node: TreeNode): number => {
    node.children.sort(compareNodes);
    let changed = node.type === 'file' ? node.changed : 0;
    for (const child of node.children) changed += finish(child);
    node.changed = changed;
    return changed;
  };
  finish(root);
  return root.children;
}

export interface TreeRow {
  node: TreeNode;
  depth: number;
}

/** The rows to draw: a folder's children appear only while it is not collapsed. */
export function visibleRows(tree: readonly TreeNode[], collapsed: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (nodes: readonly TreeNode[], depth: number): void => {
    for (const node of nodes) {
      rows.push({ node, depth });
      if (node.type === 'dir' && !collapsed.has(node.path)) walk(node.children, depth + 1);
    }
  };
  walk(tree, 0);
  return rows;
}

/** Folders that hold no changed file, which the "all files" view starts with closed so changes stay in sight. */
export function foldersWithoutChanges(tree: readonly TreeNode[]): Set<string> {
  const quiet = new Set<string>();
  const walk = (nodes: readonly TreeNode[]): void => {
    for (const node of nodes) {
      if (node.type !== 'dir') continue;
      if (node.changed === 0) quiet.add(node.path);
      walk(node.children);
    }
  };
  walk(tree);
  return quiet;
}
