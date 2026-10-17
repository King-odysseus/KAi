import { FileCode2, Pencil, RefreshCw, Save, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { OpenedFile } from '@kai/contracts';
import { unwrap } from '../types';
import { confirmDialog } from './AppDialog';

/** A file view and editor that keeps the conversation and composer in sight. */
export function WorkspaceFilePreview({ projectId, path, onClose, onDirtyChange }: { projectId: string; path: string; onClose: () => void; onDirtyChange: (dirty: boolean) => void }): ReactNode {
  const [opened, setOpened] = useState<OpenedFile | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const dirty = opened !== null && draft !== opened.content;

  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);

  useEffect(() => {
    let cancelled = false;
    setOpened(null);
    setError(null);
    void window.kaiDesktop.readProjectFile(projectId, path).then(unwrap).then((file) => {
      if (!cancelled) { setOpened(file); setDraft(file.content); }
    }).catch((caught: unknown) => {
      if (!cancelled) setError(caught instanceof Error ? caught.message : 'This file could not be opened.');
    });
    return () => { cancelled = true; };
  }, [projectId, path, reload]);

  async function reloadFile(): Promise<void> {
    if (dirty && !(await confirmDialog({ title: 'Discard unsaved changes?', detail: `${path} has unsaved changes.`, confirmLabel: 'Discard', destructive: true }))) return;
    setReload((value) => value + 1);
  }

  async function saveFile(): Promise<void> {
    if (!opened || !dirty || saving) return;
    const savedText = draft;
    setSaving(true);
    setError(null);
    try {
      const saved = unwrap(await window.kaiDesktop.writeProjectFile({
        projectId, path, content: savedText, expectedHash: opened.hash, eol: opened.eol, bom: opened.bom,
      }));
      setOpened({ ...opened, ...saved, content: savedText });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The file could not be saved. Reload to see changes on disk.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <aside className="workspace-file-preview" aria-label={`File preview: ${path}`}>
      <header className="workspace-file-preview-head">
        <FileCode2 size={16} />
        <strong title={path}>{path}</strong>
        {dirty && <span className="workspace-file-preview-dirty">Unsaved</span>}
        {opened && <button type="button" className="secondary-button" aria-label={editing ? 'View file' : 'Edit file'} onClick={() => setEditing((value) => !value)}><Pencil size={13} /><span>{editing ? 'View' : 'Edit'}</span></button>}
        {editing && <button type="button" className="secondary-button" aria-label="Save file" disabled={!dirty || saving} onClick={() => void saveFile()}><Save size={13} /><span>{saving ? 'Saving…' : 'Save'}</span></button>}
        <button type="button" className="icon-button compact" aria-label="Reload file" title="Reload file" onClick={() => void reloadFile()}><RefreshCw size={14} /></button>
        <button type="button" className="icon-button compact" aria-label="Close file preview" title="Close file preview" onClick={onClose}><X size={15} /></button>
      </header>
      {error && <div className="workspace-file-preview-status" role="alert">{error}</div>}
      {opened === null ? <div className="workspace-file-preview-status" role="status">Opening file…</div>
        : editing ? <textarea className="workspace-file-preview-content workspace-file-preview-editor" aria-label={`Edit ${path}`} value={draft} spellCheck={false} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void saveFile(); } }} />
          : <pre className="workspace-file-preview-content"><code>{draft}</code></pre>}
    </aside>
  );
}
