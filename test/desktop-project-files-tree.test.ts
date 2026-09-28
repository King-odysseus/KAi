import { describe, expect, it } from 'vitest';
import type { GitChange } from '@kai/contracts';
import {
  buildTree,
  changeKindOf,
  changeMap,
  describeChange,
  foldersWithoutChanges,
  summarizeChanges,
  visibleRows,
} from '../apps/desktop/src/renderer/src/components/project-files-tree';
import { stageState } from '../apps/desktop/src/renderer/src/components/GitBadge';

const change = (path: string, index: string, worktree: string): GitChange => ({
  path,
  index,
  worktree,
  staged: index !== '.' && index !== '?',
  unstaged: worktree !== '.' || index === '?',
});

const files = [
  'README.md',
  'src/app.ts',
  'src/util/format.ts',
  'src/util/parse.ts',
  'docs/guide.md',
  'test/app.test.ts',
];

describe('change kinds', () => {
  it('reads git status letters the way a person would', () => {
    expect(changeKindOf({ index: '.', worktree: 'M' })).toBe('modified');
    expect(changeKindOf({ index: 'M', worktree: '.' })).toBe('modified');
    expect(changeKindOf({ index: 'A', worktree: '.' })).toBe('added');
    expect(changeKindOf({ index: '.', worktree: 'D' })).toBe('deleted');
    expect(changeKindOf({ index: 'D', worktree: '.' })).toBe('deleted');
    expect(changeKindOf({ index: 'R', worktree: '.' })).toBe('renamed');
    expect(changeKindOf({ index: '?', worktree: '?' })).toBe('untracked');
  });

  it('singles out conflicts before anything else', () => {
    expect(changeKindOf({ index: 'U', worktree: 'U' })).toBe('conflict');
    expect(changeKindOf({ index: 'A', worktree: 'A' })).toBe('conflict');
    expect(changeKindOf({ index: 'D', worktree: 'D' })).toBe('conflict');
  });

  it('explains staged, unstaged and untracked files in a tooltip', () => {
    expect(describeChange({ kind: 'modified', staged: true, unstaged: false })).toBe('Modified, staged for commit');
    expect(describeChange({ kind: 'modified', staged: false, unstaged: true })).toBe('Modified, not staged');
    expect(describeChange({ kind: 'modified', staged: true, unstaged: true })).toContain('more changes not yet staged');
    expect(describeChange({ kind: 'untracked', staged: false, unstaged: true })).toContain('Git is not tracking');
  });
});

describe('project file tree', () => {
  const changes = changeMap([
    change('src/app.ts', '.', 'M'),
    change('src/util/parse.ts', 'A', '.'),
    change('src/util/new-helper.ts', '?', '?'),
    change('docs/old.md', '.', 'D'),
  ]);

  it('marks changed files, counts them on their folders, and adds back deleted files', () => {
    const tree = buildTree(files, changes, false);
    const src = tree.find((node) => node.path === 'src');
    const util = src?.children.find((node) => node.path === 'src/util');
    expect(src?.changed).toBe(3);
    expect(util?.changed).toBe(2);
    expect(util?.children.map((node) => node.name)).toEqual(['format.ts', 'new-helper.ts', 'parse.ts']);
    expect(util?.children.find((node) => node.name === 'new-helper.ts')?.change?.kind).toBe('untracked');
    const docs = tree.find((node) => node.path === 'docs');
    expect(docs?.children.find((node) => node.name === 'old.md')?.change?.kind).toBe('deleted');
    expect(tree.find((node) => node.path === 'README.md')?.change).toBeNull();
  });

  it('lists folders before files, alphabetically', () => {
    const tree = buildTree(files, changes, false);
    expect(tree.map((node) => node.name)).toEqual(['docs', 'src', 'test', 'README.md']);
  });

  it('keeps only changed files and the folders leading to them in changes-only view', () => {
    const tree = buildTree(files, changes, true);
    expect(tree.map((node) => node.name)).toEqual(['docs', 'src']);
    const rows = visibleRows(tree, new Set()).map((row) => row.node.path);
    expect(rows).toEqual(['docs', 'docs/old.md', 'src', 'src/util', 'src/util/new-helper.ts', 'src/util/parse.ts', 'src/app.ts']);
    expect(rows).not.toContain('README.md');
    expect(rows).not.toContain('test/app.test.ts');
  });

  it('hides the children of a collapsed folder and records the depth of each row', () => {
    const tree = buildTree(files, changes, true);
    const rows = visibleRows(tree, new Set(['src']));
    expect(rows.map((row) => row.node.path)).toEqual(['docs', 'docs/old.md', 'src']);
    expect(visibleRows(tree, new Set()).find((row) => row.node.path === 'src/util/parse.ts')?.depth).toBe(2);
  });

  it('starts the all-files view with quiet folders closed so changes stay in sight', () => {
    const tree = buildTree(files, changes, false);
    expect([...foldersWithoutChanges(tree)]).toEqual(['test']);
  });

  it('summarises changes by kind', () => {
    const summary = summarizeChanges(changes);
    expect(summary.total).toBe(4);
    expect(summary.counts).toMatchObject({ modified: 1, added: 1, untracked: 1, deleted: 1, renamed: 0, conflict: 0 });
  });

  it('handles Windows separators and trailing slashes in reported paths', () => {
    const map = changeMap([change('src\\win.ts', '.', 'M'), change('build/', '?', '?')]);
    expect([...map.keys()]).toEqual(['src/win.ts', 'build']);
  });

  it('returns an empty tree when there is nothing to show', () => {
    expect(buildTree([], new Map(), false)).toEqual([]);
    expect(buildTree(files, new Map(), true)).toEqual([]);
  });
});

describe('the staged state a Git badge shows', () => {
  it('is solid when staged, outlined when not, and split when partly staged', () => {
    const states = changeMap([
      change('staged.ts', 'M', '.'),
      change('edited.ts', '.', 'M'),
      change('both.ts', 'M', 'M'),
      change('new.ts', '?', '?'),
      change('clash.ts', 'U', 'U'),
    ]);
    expect([...states.entries()].map(([path, item]) => [path, stageState(item)])).toEqual([
      ['staged.ts', 'staged'],
      ['edited.ts', 'unstaged'],
      ['both.ts', 'partly-staged'],
      ['new.ts', ''],
      ['clash.ts', ''],
    ]);
  });
});
