import { ChevronDown, ChevronRight, Copy, ExternalLink, FileText, Folder, FolderOpen, Pencil, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import type { GitChange } from '@kai/contracts';
import { unwrap } from '../types';
import { GitBadge } from './GitBadge';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { confirmDialog, promptDialog } from './AppDialog';
import {
  CHANGE_BADGE,
  CHANGE_LABEL,
  buildTree,
  changeMap,
  describeChange,
  foldersWithoutChanges,
  summarizeChanges,
  visibleRows,
  type ChangeKind,
} from './project-files-tree';
import { UiButton } from './UiButton';
import { UiTextInput } from './UiTextInput';

type Mode = 'changes' | 'all';

const KIND_ORDER: ChangeKind[] = ['conflict', 'modified', 'added', 'renamed', 'deleted', 'untracked'];

/**
 * The project's files beside the conversation threads: what the agents changed, including files Git does not track yet,
 * and the rest of the tree when you want to look around. Clicking a file opens it in the code editor.
 */
export function ProjectFilesPanel({
  projectId,
  refreshKey,
  onOpenFile,
}: {
  projectId: string | null;
  /** Changes when a run finishes, so the list catches up with what the agent just did. */
  refreshKey: string;
  onOpenFile: (path: string) => void;
}): ReactNode {
  const [files, setFiles] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [changes, setChanges] = useState<GitChange[]>([]);
  const [isRepository, setIsRepository] = useState(true);
  const [branch, setBranch] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('changes');
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; kind: 'file' | 'folder'; path: string } | null>(null);

  async function renamePath(target: { kind: 'file' | 'folder'; path: string }): Promise<void> {
    if (!projectId) return;
    const to = (await promptDialog({
      title: `Rename ${target.kind}`,
      label: 'New project-relative path',
      initialValue: target.path,
      confirmLabel: 'Rename',
      validate: (value) => {
        const next = value.trim();
        if (!next) return 'A new path is required.';
        if (next === target.path) return 'That is the path it already has.';
        return next.startsWith('/') || /^[A-Za-z]:/.test(next) ? 'Use a project-relative path.' : null;
      },
    }))?.trim();
    if (!to || to === target.path) return;
    const response = await window.kaiDesktop.renameProjectPath({ projectId, from: target.path, to });
    if (!response.ok) {
      setError(response.error.message);
      return;
    }
    await load();
  }

  async function deletePath(target: { kind: 'file' | 'folder'; path: string }): Promise<void> {
    if (!projectId) return;
    const confirmed = await confirmDialog({
      title: `Delete ${target.kind === 'folder' ? 'folder' : 'file'} "${target.path}"?`,
      detail: `${target.kind === 'folder' ? 'Everything inside the folder is deleted. ' : ''}This cannot be undone from KAI.`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!confirmed) return;
    const response = await window.kaiDesktop.deleteProjectPath({ projectId, path: target.path });
    if (!response.ok) {
      setError(response.error.message);
      return;
    }
    await load();
  }

  function menuItems(): ContextMenuItem[] {
    if (!menu || !projectId) return [];
    const target = menu;
    const items: ContextMenuItem[] = [];
    if (target.kind === 'file') items.push({ label: 'Open', icon: <FileText size={13} />, onSelect: () => onOpenFile(target.path) });
    items.push({ label: 'Rename', icon: <Pencil size={13} />, onSelect: () => void renamePath(target) });
    items.push({ label: 'Delete', icon: <Trash2 size={13} />, danger: true, onSelect: () => void deletePath(target) });
    items.push({ label: '', separator: true, onSelect: () => undefined });
    items.push({ label: 'Copy relative path', icon: <Copy size={13} />, onSelect: () => void navigator.clipboard?.writeText(target.path) });
    items.push({ label: 'Reveal in Explorer', icon: <ExternalLink size={13} />, onSelect: () => void window.kaiDesktop.revealProjectPath({ projectId, path: target.path }) });
    return items;
  }

  const load = useCallback(async (): Promise<void> => {
    if (!projectId) {
      setFiles([]);
      setChanges([]);
      return;
    }
    setLoading(true);
    try {
      const [tree, overview] = await Promise.all([
        window.kaiDesktop.projectFileTree(projectId).then(unwrap),
        window.kaiDesktop.gitOverview(projectId).then(unwrap),
      ]);
      setFiles(tree.files.map((file) => file.path));
      setTruncated(tree.truncated);
      setChanges(overview.changes);
      setIsRepository(overview.isRepository);
      setBranch(overview.branch);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The project files could not be listed.');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // Coming back to the window after working elsewhere is when files have most likely changed.
  useEffect(() => {
    const onFocus = (): void => { void load(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const changeByPath = useMemo(() => changeMap(changes), [changes]);
  const summary = useMemo(() => summarizeChanges(changeByPath), [changeByPath]);
  // Without Git there is nothing to compare against, so the whole tree is all there is to show.
  const effectiveMode: Mode = isRepository ? mode : 'all';
  const tree = useMemo(() => buildTree(files, changeByPath, effectiveMode === 'changes'), [files, changeByPath, effectiveMode]);

  // The all-files view opens with folders that hold no changes closed, so changed files stay in sight.
  useEffect(() => {
    setCollapsed(effectiveMode === 'all' ? foldersWithoutChanges(tree) : new Set());
    // Only when the mode or the set of files changes, not on every refresh of the same tree.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveMode, files.length, changes.length]);

  const rows = useMemo(() => visibleRows(tree, collapsed), [tree, collapsed]);
  const search = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!search || effectiveMode !== 'all') return [];
    const paths = new Set([...files, ...changeByPath.keys()]);
    return [...paths].filter((path) => path.toLowerCase().includes(search)).sort().slice(0, 300);
  }, [search, effectiveMode, files, changeByPath]);

  function toggle(path: string): void {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  if (!projectId) return <div className="files-panel"><div className="empty-list">Open a project to see its files.</div></div>;

  return (
    <div className="files-panel">
      <div className="files-toolbar">
        {isRepository ? (
          <div className="ops-segment" role="group" aria-label="Which files to show">
            <UiButton type="button" aria-pressed={mode === 'changes'} className={mode === 'changes' ? 'active' : ''} onClick={() => setMode('changes')}>Changes{summary.total > 0 ? ` (${summary.total})` : ''}</UiButton>
            <UiButton type="button" aria-pressed={mode === 'all'} className={mode === 'all' ? 'active' : ''} onClick={() => setMode('all')}>All files</UiButton>
          </div>
        ) : (
          <span className="files-note">Not a Git repository, so changes cannot be tracked.</span>
        )}
        <UiButton type="button" className="icon-button compact" title="Refresh the file list" aria-label="Refresh the file list" disabled={loading} onClick={() => void load()}>
          <RefreshCw size={13} className={loading ? 'spin' : undefined} />
        </UiButton>
      </div>

      {isRepository && (
        <div className="files-summary" aria-label="Change summary">
          {branch && <span className="files-branch">{branch}</span>}
          {summary.total === 0
            ? <span>No changes. The working tree matches the last commit.</span>
            : KIND_ORDER.filter((kind) => summary.counts[kind] > 0).map((kind) => (
              <span key={kind} className={`files-count ${kind}`}><i>{CHANGE_BADGE[kind]}</i>{summary.counts[kind]} {CHANGE_LABEL[kind].toLowerCase()}</span>
            ))}
        </div>
      )}

      {effectiveMode === 'all' && (
        <label className="files-search"><Search size={13} /><UiTextInput value={query} placeholder="Find a file" onChange={(event) => setQuery(event.target.value)} /></label>
      )}

      {error && <div className="proxy-error" role="alert"><span>{error}</span></div>}

      <div className="files-list" role="tree" aria-label="Project files">
        {search && effectiveMode === 'all' ? (
          matches.length > 0
            ? matches.map((path) => {
              const change = changeByPath.get(path) ?? null;
              return (
                <FileRow
                  key={path}
                  name={path}
                  title={path}
                  depth={0}
                  change={change}
                  onOpen={change?.kind === 'deleted' ? undefined : () => onOpenFile(path)}
                  onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, kind: 'file', path }); }}
                />
              );
            })
            : <div className="empty-list">No file matches “{query.trim()}”.</div>
        ) : rows.length > 0 ? (
          rows.map(({ node, depth }) => node.type === 'dir' ? (
            <UiButton
              key={node.path}
              type="button"
              role="treeitem"
              aria-expanded={!collapsed.has(node.path)}
              className="files-row dir"
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() => toggle(node.path)}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ x: event.clientX, y: event.clientY, kind: 'folder', path: node.path });
              }}
              title={node.path}
            >
              {collapsed.has(node.path) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              {collapsed.has(node.path) ? <Folder size={13} /> : <FolderOpen size={13} />}
              <span className="truncate">{node.name}</span>
              {node.changed > 0 && <b className="files-folder-count" title={`${node.changed} changed file${node.changed === 1 ? '' : 's'} in this folder`}>{node.changed}</b>}
            </UiButton>
          ) : (
            <FileRow
              key={node.path}
              name={node.name}
              title={node.path}
              depth={depth}
              change={node.change}
              onOpen={node.change?.kind === 'deleted' ? undefined : () => onOpenFile(node.path)}
              onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, kind: 'file', path: node.path }); }}
            />
          ))
        ) : (
          <div className="empty-list">
            {effectiveMode === 'changes' ? 'Nothing has changed yet. Files an agent edits or creates will appear here.' : loading ? 'Loading files…' : 'No files to show.'}
          </div>
        )}
        {truncated && effectiveMode === 'all' && <div className="files-note">Large project: only the first files are listed.</div>}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems()} onClose={() => setMenu(null)} />}
    </div>
  );
}

function FileRow({ name, title, depth, change, onOpen, onContextMenu }: {
  name: string;
  title: string;
  depth: number;
  change: import('./project-files-tree').FileChange | null;
  onOpen?: () => void;
  onContextMenu?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}): ReactNode {
  return (
    <UiButton
      type="button"
      role="treeitem"
      className={`files-row file ${change ? change.kind : ''}`}
      style={{ paddingLeft: 8 + depth * 12 + 16 }}
      disabled={!onOpen}
      onClick={onOpen}
      onContextMenu={onContextMenu}
      title={change ? `${title}\n${describeChange(change)}` : title}
    >
      <FileText size={13} />
      <span className="truncate">{name}</span>
      {change && <GitBadge change={change} />}
    </UiButton>
  );
}
