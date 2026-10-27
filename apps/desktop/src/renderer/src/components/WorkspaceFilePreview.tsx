import { AlignLeft, FileCode2, Pencil, RefreshCw, Save, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type * as Monaco from 'monaco-editor';
import type { OpenedFile } from '@kai/contracts';
import { loadMonaco, monacoThemeName } from '../monaco-loader';
import { unwrap } from '../types';
import { confirmDialog } from './AppDialog';
import { UiButton } from './UiButton';

/** The same editor as Learn & Code, kept beside the conversation and composer. */
export function WorkspaceFilePreview({ projectId, path, line, formatOnSave, onClose, onDirtyChange }: { projectId: string; path: string; line?: number; formatOnSave: boolean; onClose: () => void; onDirtyChange: (dirty: boolean) => void }): ReactNode {
  const [opened, setOpened] = useState<OpenedFile | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formatting, setFormatting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const lineRef = useRef(line);
  lineRef.current = line;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<Monaco.editor.ITextModel | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const saveRef = useRef<() => Promise<void>>(async () => undefined);
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

  useEffect(() => {
    if (!opened || !containerRef.current) return;
    let disposed = false;
    let observer: MutationObserver | null = null;
    void loadMonaco().then((monaco) => {
      if (disposed || !containerRef.current) return;
      const model = monaco.editor.createModel(opened.content, languageForPath(monaco, path), monaco.Uri.parse(`inmemory://kai-workspace/${encodeURIComponent(projectId)}/${path.split('/').map(encodeURIComponent).join('/')}`));
      model.setEOL(opened.eol === 'crlf' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
      modelRef.current = model;
      const editor = monaco.editor.create(containerRef.current, {
        model,
        theme: monacoThemeName(),
        readOnly: !editingRef.current,
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 13,
        scrollBeyondLastLine: false,
        renderWhitespace: 'selection',
      });
      const target = lineRef.current;
      if (target && target > 0) {
        const targetLine = Math.min(target, model.getLineCount());
        editor.setPosition({ lineNumber: targetLine, column: 1 });
        editor.revealLineInCenter(targetLine);
      }
      editorRef.current = editor;
      editor.onDidChangeModelContent(() => setDraft(model.getValue()));
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { if (editingRef.current) void saveRef.current(); });
      observer = new MutationObserver(() => monaco.editor.setTheme(monacoThemeName()));
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }).catch((caught: unknown) => {
      if (!disposed) setError(caught instanceof Error ? caught.message : 'The code editor could not open.');
    });
    return () => {
      disposed = true;
      observer?.disconnect();
      editorRef.current?.dispose();
      modelRef.current?.dispose();
      editorRef.current = null;
      modelRef.current = null;
    };
    // Keep the model mounted when saving changes opened.hash.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, path, reload, Boolean(opened)]);

  useEffect(() => {
    if (!line || line < 1) return;
    const editor = editorRef.current;
    const lineCount = editor?.getModel()?.getLineCount();
    if (!editor || !lineCount) return;
    const targetLine = Math.min(line, lineCount);
    editor.setPosition({ lineNumber: targetLine, column: 1 });
    editor.revealLineInCenter(targetLine);
  }, [line]);

  useEffect(() => { editorRef.current?.updateOptions({ readOnly: !editing }); }, [editing]);

  async function reloadFile(): Promise<void> {
    if (dirty && !(await confirmDialog({ title: 'Discard unsaved changes?', detail: `${path} has unsaved changes.`, confirmLabel: 'Discard', destructive: true }))) return;
    setOpened(null);
    setDraft('');
    setReload((value) => value + 1);
  }

  async function formatDraft(): Promise<string | null> {
    const model = modelRef.current;
    if (!model) return null;
    const version = model.getVersionId();
    const result = unwrap(await window.kaiDesktop.formatCode({ projectId, filePath: path, content: model.getValue() }));
    if (result.skipped) return result.skipped.reason;
    if (model.getVersionId() !== version) return 'The file changed while formatting; try again.';
    if (result.changed) model.pushEditOperations([], [{ range: model.getFullModelRange(), text: result.formatted }], () => null);
    return null;
  }

  async function formatFile(): Promise<void> {
    if (!opened || formatting || saving) return;
    setFormatting(true);
    setError(null);
    try { setError(await formatDraft()); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'The file could not be formatted.'); }
    finally { setFormatting(false); }
  }

  async function saveFile(): Promise<void> {
    if (!opened || !dirty || saving || formatting) return;
    setSaving(true);
    setError(null);
    try {
      if (formatOnSave) {
        const note = await formatDraft();
        if (note) setError(note);
      }
      const savedText = modelRef.current?.getValue() ?? draft;
      const saved = unwrap(await window.kaiDesktop.writeProjectFile({ projectId, path, content: savedText, expectedHash: opened.hash, eol: opened.eol, bom: opened.bom }));
      setOpened({ ...opened, ...saved, content: savedText });
      setDraft(savedText);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The file could not be saved. Reload to see changes on disk.');
    } finally {
      setSaving(false);
    }
  }
  saveRef.current = saveFile;

  return (
    <aside className="workspace-file-preview" aria-label={`File preview: ${path}`}>
      <header className="workspace-file-preview-head">
        <FileCode2 size={16} />
        <strong title={path}>{path}</strong>
        {dirty && <span className="workspace-file-preview-dirty">Unsaved</span>}
        {opened && <UiButton type="button" className="secondary-button" aria-label={editing ? 'View file' : 'Edit file'} onClick={() => setEditing((value) => !value)}><Pencil size={13} /><span>{editing ? 'View' : 'Edit'}</span></UiButton>}
        {editing && <UiButton type="button" className="secondary-button" aria-label="Format file" disabled={formatting || saving || !opened} onClick={() => void formatFile()}><AlignLeft size={13} /><span>{formatting ? 'Formatting…' : 'Format'}</span></UiButton>}
        {editing && <UiButton type="button" className="secondary-button" aria-label="Save file" disabled={!dirty || saving || formatting} onClick={() => void saveFile()}><Save size={13} /><span>{saving ? 'Saving…' : 'Save'}</span></UiButton>}
        <UiButton type="button" className="icon-button compact" aria-label="Reload file" title="Reload file" onClick={() => void reloadFile()}><RefreshCw size={14} /></UiButton>
        <UiButton type="button" className="icon-button compact" aria-label="Close file preview" title="Close file preview" onClick={onClose}><X size={15} /></UiButton>
      </header>
      {error && <div className="workspace-file-preview-status" role="alert">{error}</div>}
      {opened === null && !error && <div className="workspace-file-preview-status" role="status">Opening file…</div>}
      <div className="workspace-file-preview-monaco" ref={containerRef} aria-label={`${editing ? 'Edit' : 'View'} ${path}`} />
    </aside>
  );
}

function languageForPath(monaco: typeof Monaco, filePath: string): string {
  const fileName = filePath.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? '';
  const extension = fileName.includes('.') ? `.${fileName.split('.').at(-1)}` : '';
  return monaco.languages.getLanguages().find((language) => language.filenames?.some((name) => name.toLowerCase() === fileName)
    || language.extensions?.some((candidate) => candidate.toLowerCase() === extension))?.id ?? 'plaintext';
}
