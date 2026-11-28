import { AlignLeft, Eye, FileCode2, Pencil, RefreshCw, Save, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type * as Monaco from 'monaco-editor';
import type { OpenedFile } from '@kai/contracts';
import { loadMonaco, monacoThemeName } from '../monaco-loader';
import { editorViewOptions, type EditorView } from '../editor-view';
import { unwrap } from '../types';
import { confirmDialog } from './AppDialog';
import { MockupFrame } from './MockupFrame';
import { UiButton } from './UiButton';
import { changedLineRange } from './workspace-code-follow';

/** The same editor as Learn & Code, kept beside the conversation and composer. */
export function WorkspaceFilePreview(props: { projectId: string; path: string; line?: number; changedRange?: { start: number; end: number }; refreshToken?: string; followChanges?: boolean; formatOnSave: boolean; editorView?: EditorView; onClose: () => void; onDirtyChange: (dirty: boolean) => void }): ReactNode {
  return IMAGE_PATH.test(props.path) ? <WorkspaceImagePreview projectId={props.projectId} path={props.path} onClose={props.onClose} onDirtyChange={props.onDirtyChange} /> : <WorkspaceCodePreview {...props} />;
}

const IMAGE_PATH = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

/** A picture in the project (a mockup an agent saved), shown as itself because the code editor cannot open it. */
function WorkspaceImagePreview({ projectId, path, onClose, onDirtyChange }: { projectId: string; path: string; onClose: () => void; onDirtyChange: (dirty: boolean) => void }): ReactNode {
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => { onDirtyChange(false); }, [onDirtyChange]);
  useEffect(() => {
    let cancelled = false;
    setImage(null);
    setError(null);
    void window.kaiDesktop.readProjectImage(projectId, path).then(unwrap).then((file) => {
      if (!cancelled) setImage(file.dataUrl);
    }).catch((caught: unknown) => {
      if (!cancelled) setError(caught instanceof Error ? caught.message : 'This picture could not be opened.');
    });
    return () => { cancelled = true; };
  }, [projectId, path, reload]);
  return (
    <aside className="workspace-file-preview" aria-label={`Picture preview: ${path}`}>
      <header className="workspace-file-preview-head">
        <FileCode2 size={16} />
        <strong title={path}>{path}</strong>
        <UiButton type="button" className="icon-button compact" aria-label="Reload picture" title="Reload picture" onClick={() => setReload((value) => value + 1)}><RefreshCw size={14} /></UiButton>
        <UiButton type="button" className="icon-button compact" aria-label="Close file preview" title="Close file preview" onClick={onClose}><X size={15} /></UiButton>
      </header>
      {error && <div className="workspace-file-preview-status" role="alert">{error}</div>}
      {!image && !error && <div className="workspace-file-preview-status" role="status">Opening picture…</div>}
      {image && <div className="workspace-file-preview-image"><img src={image} alt={path} /></div>}
    </aside>
  );
}

function WorkspaceCodePreview({ projectId, path, line, changedRange, refreshToken, followChanges, formatOnSave, editorView, onClose, onDirtyChange }: { projectId: string; path: string; line?: number; changedRange?: { start: number; end: number }; refreshToken?: string; followChanges?: boolean; formatOnSave: boolean; editorView?: EditorView; onClose: () => void; onDirtyChange: (dirty: boolean) => void }): ReactNode {
  const [opened, setOpened] = useState<OpenedFile | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formatting, setFormatting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [live, setLive] = useState(false);
  const isHtml = /\.html?$/i.test(path);
  const lineRef = useRef(line);
  lineRef.current = line;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const changedDecorations = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  const highlightRef = useRef({ range: changedRange, follow: followChanges });
  highlightRef.current = { range: changedRange, follow: followChanges };
  function highlight(range = highlightRef.current.range): void {
    const editor = editorRef.current;
    if (!range || !editor) return;
    const lines = editor.getModel()?.getLineCount() ?? 1;
    const start = Math.min(Math.max(1, range.start), lines);
    const end = Math.min(Math.max(start, range.end), lines);
    changedDecorations.current ??= editor.createDecorationsCollection();
    changedDecorations.current.set([{ range: { startLineNumber: start, endLineNumber: end, startColumn: 1, endColumn: 1 }, options: { isWholeLine: true, className: 'workspace-code-changed-line' } }]);
    if (highlightRef.current.follow) editor.revealLineInCenter(start);
  }
  const modelRef = useRef<Monaco.editor.ITextModel | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const saveRef = useRef<() => Promise<void>>(async () => undefined);
  const dirty = opened !== null && draft !== opened.content;
  const loadedRef = useRef(opened);
  loadedRef.current = opened;

  useEffect(() => {
    if (!refreshToken || dirty || editing || saving || !opened) return;
    let alive = true;
    void window.kaiDesktop.readProjectFile(projectId, path).then(unwrap).then((file) => {
      if (!alive || editingRef.current || loadedRef.current?.hash === file.hash) return;
      const range = changedLineRange(loadedRef.current?.content ?? '', file.content);
      setOpened(file); setDraft(file.content);
      modelRef.current?.setValue(file.content);
      if (range && editorRef.current) {
        highlight(range);
      }
    }).catch((caught) => { if (alive) setError(String(caught.message)); });
    return () => { alive = false; };
  }, [projectId, path, refreshToken, dirty, editing, saving, Boolean(opened)]);

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
        ...(editorView ? editorViewOptions(editorView) : { minimap: { enabled: false } }),
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
      highlight();
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
      changedDecorations.current?.clear();
      changedDecorations.current = null;
      editorRef.current?.dispose();
      modelRef.current?.dispose();
      editorRef.current = null;
      modelRef.current = null;
    };
    // Keep the model mounted when saving changes opened.hash.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, path, reload, Boolean(opened)]);

  useEffect(() => { if (!dirty && !editing) highlight(); }, [changedRange?.start, changedRange?.end, followChanges, dirty, editing]);

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
        {isHtml && <UiButton type="button" className="secondary-button" aria-label={live ? 'Show code' : 'Show live preview'} onClick={() => setLive((value) => !value)}><Eye size={13} /><span>{live ? 'Code' : 'Preview'}</span></UiButton>}
        {opened && !live && <UiButton type="button" className="secondary-button" aria-label={editing ? 'View file' : 'Edit file'} onClick={() => setEditing((value) => !value)}><Pencil size={13} /><span>{editing ? 'View' : 'Edit'}</span></UiButton>}
        {editing && <UiButton type="button" className="secondary-button" aria-label="Format file" disabled={formatting || saving || !opened} onClick={() => void formatFile()}><AlignLeft size={13} /><span>{formatting ? 'Formatting…' : 'Format'}</span></UiButton>}
        {editing && <UiButton type="button" className="secondary-button" aria-label="Save file" disabled={!dirty || saving || formatting} onClick={() => void saveFile()}><Save size={13} /><span>{saving ? 'Saving…' : 'Save'}</span></UiButton>}
        <UiButton type="button" className="icon-button compact" aria-label="Reload file" title="Reload file" onClick={() => void reloadFile()}><RefreshCw size={14} /></UiButton>
        <UiButton type="button" className="icon-button compact" aria-label="Close file preview" title="Close file preview" onClick={onClose}><X size={15} /></UiButton>
      </header>
      {error && <div className="workspace-file-preview-status" role="alert">{error}</div>}
      {opened === null && !error && <div className="workspace-file-preview-status" role="status">Opening file…</div>}
      {live && isHtml && <div className="workspace-file-preview-live"><MockupFrame key={`${path}:${reload}:${opened?.hash ?? ''}`} projectId={projectId} path={path} title={`Live preview of ${path}`} height="100%" /></div>}
      <div className="workspace-file-preview-monaco" ref={containerRef} hidden={live} aria-label={`${editing ? 'Edit' : 'View'} ${path}`} />
    </aside>
  );
}

function languageForPath(monaco: typeof Monaco, filePath: string): string {
  const fileName = filePath.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? '';
  const extension = fileName.includes('.') ? `.${fileName.split('.').at(-1)}` : '';
  return monaco.languages.getLanguages().find((language) => language.filenames?.some((name) => name.toLowerCase() === fileName)
    || language.extensions?.some((candidate) => candidate.toLowerCase() === extension))?.id ?? 'plaintext';
}
