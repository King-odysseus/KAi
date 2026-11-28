import { useEffect, useState } from 'react';
import type { ConversationRecord, ProjectRecord } from '@kai/contracts';
import { WorkspaceFilePreview } from './WorkspaceFilePreview';
import { workspaceEdits } from './workspace-code-follow';
import { Toggle } from './ui/Toggle';
import { UiButton } from './UiButton';
import { unwrap } from '../types';
import type { EditorView } from '../editor-view';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export function WorkspaceCodePanel({ project, conversation, path, line, visible, dirty, follow, onFollow, onSelect, onDirty, onClose, formatOnSave, editorView }: {
  project: ProjectRecord | null; conversation: ConversationRecord | null; path: string | null; dirty: boolean; follow: boolean;
  line?: number; visible: boolean;
  onFollow(value: boolean): void; onSelect(path: string): void; onDirty(value: boolean): void; onClose(): void;
  formatOnSave: boolean; editorView: EditorView;
}) {
  const edits = workspaceEdits(conversation);
  const index = path ? edits.paths.indexOf(path) : -1;
  const navigate = (step: number) => {
    if (!edits.paths.length || dirty) return;
    const next = edits.paths[(Math.max(0, index) + step + edits.paths.length) % edits.paths.length];
    if (next) { onFollow(false); onSelect(next); }
  };
  const [diff, setDiff] = useState<string | null>(null);
  const [diffError, setDiffError] = useState('');
  useEffect(() => { setDiff(null); setDiffError(''); }, [project?.id, path]);
  useEffect(() => {
    if (visible && follow && !dirty && edits.latest && edits.latest.path !== path) onSelect(edits.latest.path);
  }, [visible, follow, dirty, edits.latest?.key, edits.latest?.path]);
  return <section className="workspace-code-panel" aria-label="Workspace code view">
    <div className="workspace-code-toolbar">
      <Toggle checked={follow} onChange={onFollow} label="Follow Builder" ariaLabel="Follow Builder" />
      <UiButton type="button" className="icon-button compact" aria-label="Previous changed file" title="Previous changed file" disabled={dirty || !edits.paths.length} onClick={() => navigate(-1)}><ChevronLeft size={16} /></UiButton>
      <span aria-label="Changed file position">{index >= 0 ? index + 1 : 0} / {edits.paths.length}</span>
      <UiButton type="button" className="icon-button compact" aria-label="Next changed file" title="Next changed file" disabled={dirty || !edits.paths.length} onClick={() => navigate(1)}><ChevronRight size={16} /></UiButton>
      <small>{dirty ? 'Following paused while you have unsaved edits.' : 'Shows real file changes as they arrive; whole edits may appear at once.'}</small>
      <UiButton type="button" className="secondary-button" disabled={!project || !path} onClick={() => {
        if (!project || !path) return;
        if (diff !== null) { setDiff(null); return; }
        setDiffError('');
        void window.kaiDesktop.gitDiff(project.id, path, false).then(unwrap).then((result) => setDiff(result.output || 'No working-tree diff for this file.')).catch((caught) => setDiffError(String(caught.message)));
      }}>{diff !== null ? 'Hide diff' : 'Working-tree diff'}</UiButton>
    </div>
    <div className="workspace-code-files" aria-label="Builder changed files">{[...new Set([...(path ? [path] : []), ...edits.paths])].map((file) => <UiButton key={file} type="button" className="secondary-button" aria-pressed={path === file} onClick={() => { onFollow(false); onSelect(file); }}>{file}</UiButton>)}</div>
    {diffError && <p role="alert">{diffError}</p>}
    {diff !== null && <details open className="workspace-code-diff"><summary>Current working-tree changes (includes any manual edits)</summary><pre>{diff}</pre></details>}
    {project && path ? <WorkspaceFilePreview key={`${project.id}:${path}`} projectId={project.id} path={path} line={line} changedRange={edits.ranges[path]} refreshToken={edits.revision} followChanges={follow && visible} formatOnSave={formatOnSave} editorView={editorView} onClose={onClose} onDirtyChange={onDirty} /> : <p className="lead-empty">Choose a file in the explorer, or enable Follow Builder to see the file it edits.</p>}
  </section>;
}
