import {
  Braces,
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  FilePlus,
  Folder,
  PanelRightOpen,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type * as Monaco from 'monaco-editor';
import type {
  GitFileInfo,
  LearningAction,
  LearningAssistance,
  LearningEvaluationResult,
  LearningProgress,
  LearningTutorRequest,
  OpenedFile,
  ProjectFileEntry,
  ProjectRecord,
  TeachingDraft,
  TeachingDraftGenerateInput,
  TeachingLibrary,
  TeachingLibraryEntryInput,
  TeachingLibrarySaveInput,
} from '@kai/contracts';
import { loadMonaco, monacoThemeName } from '../monaco-loader';
import { unwrap } from '../types';
import { LearningPanel } from './LearningPanel';

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  file: boolean;
}

interface OpenDocument {
  opened: OpenedFile;
  model: Monaco.editor.ITextModel;
  savedValue: string;
  language: string;
}

const normalise = (text: string): string => text.replace(/\r\n/g, '\n');
const POLL_MS = 3_000;
const MAX_LEARNING_CODE = 120_000;

function buildTree(files: readonly ProjectFileEntry[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map(), file: false };
  for (const entry of files) {
    let node = root;
    const parts = entry.path.split('/');
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join('/');
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path, children: new Map(), file: index === parts.length - 1 };
        node.children.set(part, child);
      }
      node = child;
    });
  }
  return root;
}

function sortedChildren(node: TreeNode): TreeNode[] {
  return [...node.children.values()].sort((left, right) => Number(left.file) - Number(right.file) || left.name.localeCompare(right.name));
}

function languageForPath(filePath: string): string {
  const extension = filePath.split('.').at(-1)?.toLowerCase() ?? '';
  const names: Record<string, string> = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    json: 'json', html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
    md: 'markdown', markdown: 'markdown', py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
    java: 'java', cs: 'csharp', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
    php: 'php', swift: 'swift', kt: 'kotlin', kts: 'kotlin', sql: 'sql', sh: 'shell',
    bash: 'shell', zsh: 'shell', ps1: 'powershell', yml: 'yaml', yaml: 'yaml', xml: 'xml',
    toml: 'ini', ini: 'ini', dockerfile: 'dockerfile', vue: 'html', svelte: 'html',
  };
  return names[extension] ?? 'plaintext';
}

function boundedCode(value: string, selectedStartLine: number): string {
  if (value.length <= MAX_LEARNING_CODE) return value;
  const lines = value.split('\n');
  const marker = Math.max(0, Math.min(lines.length - 1, selectedStartLine - 1));
  const head = lines.slice(0, Math.max(1, marker - 350)).join('\n');
  const middle = lines.slice(Math.max(0, marker - 350), marker + 350).join('\n');
  const tail = lines.slice(marker + 350).join('\n');
  return `${head}\n\n[KAI omitted code above the active area]\n\n${middle}\n\n[KAI omitted code below the active area]\n\n${tail}`.slice(0, MAX_LEARNING_CODE);
}

export function CodeView({ activeProject }: { activeProject: ProjectRecord | null }): ReactNode {
  const projectId = activeProject?.id ?? null;
  const [files, setFiles] = useState<ProjectFileEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [openPaths, setOpenPaths] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [diskChanged, setDiskChanged] = useState<string | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const [tutorOpen, setTutorOpen] = useState(true);
  const [progress, setProgress] = useState<LearningProgress | null>(null);
  const [learningResult, setLearningResult] = useState<LearningEvaluationResult | null>(null);
  const [learningBusy, setLearningBusy] = useState<LearningAction | 'record' | null>(null);
  const [learningError, setLearningError] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [gitInfo, setGitInfo] = useState<GitFileInfo | null>(null);
  const [formatting, setFormatting] = useState(false);
  const [teachingLibrary, setTeachingLibrary] = useState<TeachingLibrary | null>(null);
  const [teachingBusy, setTeachingBusy] = useState<string | null>(null);
  const assistance = progress?.preferences.assistance ?? 'guided';
  const inlineSuggestions = progress?.preferences.inlineSuggestions ?? false;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const documents = useRef(new Map<string, OpenDocument>());
  const activeRef = useRef<string | null>(null);
  const lastLearningRequest = useRef<LearningTutorRequest | null>(null);
  const learningActionRef = useRef<(action: LearningAction) => Promise<LearningEvaluationResult | null>>(async () => null);
  const projectIdRef = useRef<string | null>(projectId);
  const learningStateRef = useRef({ projectId, filePath: activePath, assistance, inlineSuggestions, progress });
  activeRef.current = activePath;
  projectIdRef.current = projectId;
  learningStateRef.current = { projectId, filePath: activePath, assistance, inlineSuggestions, progress };

  const loadTree = useCallback(async () => {
    if (!projectId) return;
    try {
      const tree = unwrap(await window.kaiDesktop.projectFileTree(projectId));
      setFiles(tree.files);
      setTruncated(tree.truncated);
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : 'Files could not be listed.');
    }
  }, [projectId]);

  const loadTeachingLibrary = useCallback(async () => {
    try {
      setTeachingLibrary(unwrap(await window.kaiDesktop.teachingLibrary()));
    } catch (caught) {
      setLearningError(caught instanceof Error ? caught.message : 'The KAI teaching library could not be loaded.');
    }
  }, []);

  useEffect(() => {
    void loadTeachingLibrary();
  }, [loadTeachingLibrary]);

  // Start clean whenever the project changes.
  useEffect(() => {
    for (const document of documents.current.values()) document.model.dispose();
    documents.current.clear();
    setOpenPaths([]);
    setActivePath(null);
    setDirty({});
    setDiskChanged(null);
    setNotice(null);
    setFiles([]);
    setProgress(null);
    setLearningResult(null);
    setLearningError(null);
    setQuestion('');
    setGitInfo(null);
    void loadTree();
    if (projectId) {
      void window.kaiDesktop.learningProgress(projectId).then(unwrap).then(setProgress).catch((caught) => {
        setLearningError(caught instanceof Error ? caught.message : 'Learning progress could not be loaded.');
      });
    }
  }, [loadTree, projectId]);

  // Create the editor once, on first use.
  useEffect(() => {
    let disposed = false;
    let observer: MutationObserver | null = null;
    const disposables: Monaco.IDisposable[] = [];
    void loadMonaco().then((monaco) => {
      if (disposed || !containerRef.current) return;
      monacoRef.current = monaco;
      const editor = monaco.editor.create(containerRef.current, {
        model: null,
        theme: monacoThemeName(),
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 13,
        scrollBeyondLastLine: false,
        renderWhitespace: 'selection',
        inlineSuggest: { enabled: true },
      });
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveActive());
      editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.Backslash, () => editor.trigger('keyboard', 'editor.action.inlineSuggest.trigger', {}));

      disposables.push(monaco.languages.registerCodeActionProvider('*', {
        provideCodeActions(model) {
          const actions = [
            ['Explain selection', 'explain-selection'],
            ['Explain file', 'explain-file'],
            ['Hint', 'hint'],
            ['Check code', 'check-code'],
            ['Next learning step', 'next-step'],
            ['Complete with tutor', 'complete'],
          ] as const;
          return {
            actions: actions.map(([title, action]) => ({
              title: `KAI: ${title}`,
              kind: 'quickfix' as const,
              command: {
                id: `kai.learning.${action}`,
                title,
                arguments: [action],
              },
            })),
            dispose: () => undefined,
          };
        },
      }));

      for (const action of ['explain-selection', 'explain-file', 'hint', 'check-code', 'next-step', 'complete'] as LearningAction[]) {
        editor.addAction({
          id: `kai.learning.${action}`,
          label: `KAI Learning: ${action.replace('-', ' ')}`,
          run: () => void learningActionRef.current(action),
        });
      }

      disposables.push(monaco.languages.registerInlineCompletionsProvider('*', {
        async provideInlineCompletions(model, position, context, token) {
          if (context.triggerKind !== monaco.languages.InlineCompletionTriggerKind.Explicit) return { items: [] };
          const state = learningStateRef.current;
          if (!state.projectId || !state.filePath || state.assistance !== 'copilot' || !state.inlineSuggestions) return { items: [] };
          const result = await learningActionRef.current('complete');
          if (token.isCancellationRequested || !result?.response.suggestion) return { items: [] };
          const selection = editor.getSelection();
          const range = selection && !selection.isEmpty()
            ? selection
            : new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column);
          return {
            items: [{
              insertText: result.response.suggestion.code,
              range,
              complete: true,
            }],
          };
        },
        disposeInlineCompletions() {},
      }));

      disposables.push(monaco.languages.registerHoverProvider('*', {
        provideHover() {
          const state = learningStateRef.current;
          const top = progressRef(state.progress)[0];
          const contents = [
            '**KAI Learning Mode**',
            `Assistance: ${state.assistance}`,
            top ? `Current focus: ${top.name} (${top.mastery})` : 'No concept evidence recorded yet.',
            'Use a KAI code action or the learning panel. Press Alt+\\ in Copilot mode for a manual completion.',
          ].join('\n\n');
          return { contents: [{ value: contents }] };
        },
      }));

      editorRef.current = editor;
      observer = new MutationObserver(() => monaco.editor.setTheme(monacoThemeName()));
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      setEditorReady(true);
    }).catch((caught) => setNotice(caught instanceof Error ? caught.message : 'The editor could not be loaded.'));
    return () => {
      disposed = true;
      observer?.disconnect();
      disposables.forEach((disposable) => disposable.dispose());
      editorRef.current?.dispose();
      editorRef.current = null;
      for (const document of documents.current.values()) document.model.dispose();
      documents.current.clear();
    };
    // The first editor is intentionally created once for the lifetime of the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Warn when the open file changes on disk, for example because an agent edited it.
  useEffect(() => {
    if (!projectId) return;
    const timer = window.setInterval(() => {
      const path = activeRef.current;
      const document = path ? documents.current.get(path) : undefined;
      if (!path || !document) return;
      void window.kaiDesktop.projectFileChanged(projectId, path, document.opened.hash).then((response) => {
        if (response.ok && response.data && activeRef.current === path) setDiskChanged(path);
      });
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !activePath) {
      setGitInfo(null);
      return;
    }
    let cancelled = false;
    setGitInfo(null);
    void window.kaiDesktop.gitFileInfo(projectId, activePath).then(unwrap).then((info) => {
      if (!cancelled) setGitInfo(info);
    }).catch(() => {
      if (!cancelled) setGitInfo(null);
    });
    return () => { cancelled = true; };
  }, [projectId, activePath]);

  async function openFile(path: string): Promise<void> {
    if (!projectId || !monacoRef.current || !editorRef.current) return;
    setDiskChanged(null);
    let document = documents.current.get(path);
    if (!document) {
      try {
        const opened = unwrap(await window.kaiDesktop.readProjectFile(projectId, path));
        const monaco = monacoRef.current;
        const language = languageForPath(path);
        const model = monaco.editor.createModel(opened.content, language, monaco.Uri.file(`/${path}`));
        model.setEOL(opened.eol === 'crlf' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
        document = { opened, model, savedValue: normalise(opened.content), language };
        documents.current.set(path, document);
        const created = document;
        model.onDidChangeContent(() => setDirty((current) => ({ ...current, [path]: normalise(model.getValue()) !== created.savedValue })));
        setNotice(null);
      } catch (caught) {
        setNotice(caught instanceof Error ? caught.message : 'That file could not be opened.');
        return;
      }
    }
    editorRef.current.setModel(document.model);
    setOpenPaths((current) => (current.includes(path) ? current : [...current, path]));
    setActivePath(path);
    setLearningResult(null);
    setLearningError(null);
  }

  async function saveActive(): Promise<void> {
    const path = activeRef.current;
    const document = path ? documents.current.get(path) : undefined;
    const currentProjectId = projectIdRef.current;
    if (!currentProjectId || !path || !document) return;
    const content = document.model.getValue();
    const response = await window.kaiDesktop.writeProjectFile({
      projectId: currentProjectId,
      path,
      content,
      expectedHash: document.opened.hash,
      eol: document.opened.eol,
      bom: document.opened.bom,
    });
    if (!response.ok) {
      if (response.error.code === 'CONFLICT') setDiskChanged(path);
      setNotice(response.error.message);
      return;
    }
    document.opened = { ...document.opened, hash: response.data.hash, mtimeMs: response.data.mtimeMs, size: response.data.size };
    document.savedValue = normalise(content);
    setDirty((current) => ({ ...current, [path]: false }));
    setNotice(`Saved ${path}`);
    setDiskChanged(null);
  }

  /** Re-read the file from disk. With keepEdits, only the stored hash moves, so the next save knowingly overwrites. */
  async function refreshFromDisk(keepEdits: boolean): Promise<void> {
    const path = activeRef.current;
    const document = path ? documents.current.get(path) : undefined;
    if (!projectId || !path || !document) return;
    try {
      const fresh = unwrap(await window.kaiDesktop.readProjectFile(projectId, path));
      document.opened = fresh;
      if (!keepEdits) {
        document.model.setValue(fresh.content);
        document.savedValue = normalise(fresh.content);
        setDirty((current) => ({ ...current, [path]: false }));
      }
      setDiskChanged(null);
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : 'The file could not be reloaded.');
    }
  }

  function closeFile(path: string): void {
    if (dirty[path] && !window.confirm(`Discard unsaved changes to ${path}?`)) return;
    documents.current.get(path)?.model.dispose();
    documents.current.delete(path);
    const remaining = openPaths.filter((item) => item !== path);
    setOpenPaths(remaining);
    setDirty(({ [path]: _removed, ...rest }) => rest);
    if (activePath === path) {
      const next = remaining.at(-1) ?? null;
      setActivePath(null);
      if (next) void openFile(next);
      else editorRef.current?.setModel(null);
    }
  }

  async function createFile(): Promise<void> {
    if (!projectId) return;
    const path = window.prompt('New file path, relative to the project (for example src/util.ts)')?.trim();
    if (!path) return;
    const response = await window.kaiDesktop.writeProjectFile({ projectId, path, content: '', expectedHash: null, eol: 'lf', bom: false });
    if (!response.ok) {
      setNotice(response.error.message);
      return;
    }
    await loadTree();
    await openFile(path);
  }

  async function runLearningAction(action: LearningAction): Promise<LearningEvaluationResult | null> {
    const path = activeRef.current;
    const document = path ? documents.current.get(path) : undefined;
    const editor = editorRef.current;
    if (!projectId || !path || !document || !editor) {
      setLearningError('Open a file before using Learning Mode.');
      return null;
    }
    if (action === 'explain-selection' && editor.getSelection()?.isEmpty()) {
      setLearningError('Select some code before asking for a selection explanation.');
      return null;
    }
    let errorText: string | undefined;
    if (action === 'explain-error') {
      errorText = window.prompt('Paste the exact error message to investigate:')?.trim() || undefined;
      if (!errorText) return null;
    }
    const selection = editor.getSelection();
    const selectedText = selection && !selection.isEmpty() ? document.model.getValueInRange(selection).slice(0, 50_000) : undefined;
    const request: LearningTutorRequest = {
      projectId,
      filePath: path,
      language: document.language,
      action,
      assistance,
      code: boundedCode(document.model.getValue(), selection?.startLineNumber ?? 1),
      ...(selectedText ? { selectedText } : {}),
      cursorLine: editor.getPosition()?.lineNumber ?? 1,
      ...(errorText ? { errorText } : {}),
      ...(question.trim() ? { question: question.trim().slice(0, 4_000) } : {}),
    };
    setLearningBusy(action);
    setLearningError(null);
    try {
      const result = unwrap(await window.kaiDesktop.evaluateLearning(request));
      lastLearningRequest.current = request;
      setLearningResult(result);
      setProgress(result.progress);
      return result;
    } catch (caught) {
      setLearningError(caught instanceof Error ? caught.message : 'The tutor request failed.');
      return null;
    } finally {
      setLearningBusy(null);
    }
  }
  learningActionRef.current = runLearningAction;

  async function updatePreferences(nextAssistance: LearningAssistance, nextInline: boolean): Promise<void> {
    if (!projectId) return;
    const previous = progress;
    setLearningError(null);
    setProgress((current) => current
      ? { ...current, preferences: { assistance: nextAssistance, inlineSuggestions: nextInline } }
      : current);
    try {
      const updated = unwrap(await window.kaiDesktop.updateLearningPreferences({
        projectId,
        assistance: nextAssistance,
        inlineSuggestions: nextInline,
      }));
      setProgress(updated);
    } catch (caught) {
      setProgress(previous);
      setLearningError(caught instanceof Error ? caught.message : 'Learning preferences could not be saved.');
    }
  }

  function insertSuggestion(): void {
    const suggestion = learningResult?.response.suggestion;
    const editor = editorRef.current;
    const path = activeRef.current;
    const document = path ? documents.current.get(path) : undefined;
    const monaco = monacoRef.current;
    if (!suggestion || !editor || !document || !monaco) return;
    const selection = editor.getSelection();
    const range = suggestion.replaceSelection && selection && !selection.isEmpty()
      ? selection
      : new monaco.Range(
          selection?.positionLineNumber ?? 1,
          selection?.positionColumn ?? 1,
          selection?.positionLineNumber ?? 1,
          selection?.positionColumn ?? 1,
        );
    document.model.pushEditOperations([], [{ range, text: suggestion.code }], () => selection ? [selection] : null);
    setNotice('Inserted the tutor suggestion. Review it, run the relevant check, and save when you are satisfied.');
  }

  async function recordLesson(): Promise<void> {
    const request = lastLearningRequest.current;
    const response = learningResult?.response;
    if (!projectId || !request || !response) return;
    setLearningBusy('record');
    setLearningError(null);
    try {
      const result = unwrap(await window.kaiDesktop.recordLearningLesson({
        projectId,
        filePath: request.filePath,
        request,
        response,
      }));
      setNotice(`Recorded the lesson in ${result.path}.`);
    } catch (caught) {
      setLearningError(caught instanceof Error ? caught.message : 'The lesson could not be recorded.');
    } finally {
      setLearningBusy(null);
    }
  }

  async function saveTeachingEntry(input: TeachingLibrarySaveInput): Promise<void> {
    setTeachingBusy(`save:${input.kind}`);
    setLearningError(null);
    try {
      setTeachingLibrary(unwrap(await window.kaiDesktop.saveTeachingEntry(input)));
      setNotice(`Saved ${input.title} in the KAI teaching library.`);
    } catch (caught) {
      setLearningError(caught instanceof Error ? caught.message : 'The teaching entry could not be saved.');
      throw caught;
    } finally {
      setTeachingBusy(null);
    }
  }

  async function deleteTeachingEntry(input: TeachingLibraryEntryInput): Promise<void> {
    setTeachingBusy(`delete:${input.kind}`);
    setLearningError(null);
    try {
      setTeachingLibrary(unwrap(await window.kaiDesktop.deleteTeachingEntry(input)));
      setNotice('Removed the custom teaching entry.');
    } catch (caught) {
      setLearningError(caught instanceof Error ? caught.message : 'The teaching entry could not be removed.');
      throw caught;
    } finally {
      setTeachingBusy(null);
    }
  }

  async function resetTeachingEntry(input: TeachingLibraryEntryInput): Promise<void> {
    setTeachingBusy(`reset:${input.kind}`);
    setLearningError(null);
    try {
      setTeachingLibrary(unwrap(await window.kaiDesktop.resetTeachingEntry(input)));
      setNotice('Restored the built-in KAI teaching entry.');
    } catch (caught) {
      setLearningError(caught instanceof Error ? caught.message : 'The teaching entry could not be reset.');
      throw caught;
    } finally {
      setTeachingBusy(null);
    }
  }

  async function generateTeachingDraft(input: TeachingDraftGenerateInput): Promise<TeachingDraft> {
    setTeachingBusy(`generate:${input.kind}`);
    setLearningError(null);
    try {
      return unwrap(await window.kaiDesktop.generateTeachingDraft(input));
    } catch (caught) {
      setLearningError(caught instanceof Error ? caught.message : 'The teaching draft could not be generated.');
      throw caught;
    } finally {
      setTeachingBusy(null);
    }
  }

  async function formatActive(): Promise<void> {
    const path = activeRef.current;
    const document = path ? documents.current.get(path) : undefined;
    if (!projectId || !path || !document) return;
    setFormatting(true);
    setNotice(null);
    try {
      const result = unwrap(await window.kaiDesktop.formatCode({ projectId, filePath: path, content: document.model.getValue() }));
      if (!result.changed) {
        setNotice(`${path} is already formatted.`);
        return;
      }
      document.model.pushEditOperations([], [{ range: document.model.getFullModelRange(), text: result.formatted }], () => null);
      setNotice(`Formatted ${path} with Prettier (${result.parser}).`);
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : 'The file could not be formatted.');
    } finally {
      setFormatting(false);
    }
  }

  const root = useMemo(() => buildTree(files), [files]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? files.filter((file) => file.path.toLowerCase().includes(needle)).slice(0, 200) : null;
  }, [files, query]);

  function renderNode(node: TreeNode, depth: number): ReactNode {
    return sortedChildren(node).map((child) => {
      if (child.file) {
        return (
          <button key={child.path} type="button" className={`code-tree-item ${activePath === child.path ? 'active' : ''}`} style={{ paddingLeft: 8 + depth * 12 }} onClick={() => void openFile(child.path)} title={child.path}>
            <FileIcon size={12} /><span className="truncate">{child.name}</span>{dirty[child.path] && <span className="code-dirty" aria-label="Unsaved changes">●</span>}
          </button>
        );
      }
      const open = expanded.has(child.path);
      return (
        <div key={child.path}>
          <button type="button" className="code-tree-item folder" style={{ paddingLeft: 8 + depth * 12 }} aria-expanded={open} onClick={() => setExpanded((current) => {
            const next = new Set(current);
            if (open) next.delete(child.path);
            else next.add(child.path);
            return next;
          })}>
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}<Folder size={12} /><span className="truncate">{child.name}</span>
          </button>
          {open && renderNode(child, depth + 1)}
        </div>
      );
    });
  }

  if (!activeProject) {
    return (
      <div className="page-view">
        <header className="page-header"><div><h1>Code</h1><p>Open a project to browse and edit its files</p></div></header>
        <div className="empty-list">No project is open</div>
      </div>
    );
  }

  return (
    <div className={`code-view ${tutorOpen ? 'learning-open' : ''}`}>
      <aside className="code-sidebar" aria-label="Project files">
        <div className="code-sidebar-head">
          <label className="input-with-icon"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search files" aria-label="Search files" /></label>
          <button type="button" className="icon-button compact" title="New file" aria-label="New file" onClick={() => void createFile()}><FilePlus size={14} /></button>
          <button type="button" className="icon-button compact" title="Refresh files" aria-label="Refresh files" onClick={() => void loadTree()}><RefreshCw size={14} /></button>
        </div>
        <div className="code-tree">
          {filtered
            ? filtered.map((file) => <button key={file.path} type="button" className={`code-tree-item ${activePath === file.path ? 'active' : ''}`} onClick={() => void openFile(file.path)} title={file.path}><FileIcon size={12} /><span className="truncate">{file.path}</span></button>)
            : renderNode(root, 0)}
          {files.length === 0 && <div className="empty-list">No editable files</div>}
          {truncated && <div className="settings-note">Showing the first {files.length} files.</div>}
        </div>
      </aside>
      <section className="code-main">
        <div className="code-tabs" role="tablist" aria-label="Open files">
          {openPaths.map((path) => (
            <div key={path} className={`code-tab ${activePath === path ? 'active' : ''}`} role="tab" aria-selected={activePath === path}>
              <button type="button" className="code-tab-name" onClick={() => void openFile(path)}><span className="truncate">{path.split('/').at(-1)}</span>{dirty[path] && <span className="code-dirty">●</span>}</button>
              <button type="button" className="icon-button compact" aria-label={`Close ${path}`} onClick={() => closeFile(path)}><X size={11} /></button>
            </div>
          ))}
          <span className="code-tabs-spacer" />
          <button type="button" className="icon-button compact" title="Format with Prettier" aria-label="Format with Prettier" disabled={!activePath || formatting} onClick={() => void formatActive()}><Braces size={14} /></button>
          <button type="button" className={`icon-button compact ${tutorOpen ? 'active' : ''}`} title={tutorOpen ? 'Hide learning tutor' : 'Show learning tutor'} aria-label={tutorOpen ? 'Hide learning tutor' : 'Show learning tutor'} onClick={() => setTutorOpen((current) => !current)}><PanelRightOpen size={14} /></button>
          <button type="button" className="secondary-button" disabled={!activePath || !dirty[activePath]} onClick={() => void saveActive()}><Save size={13} /><span>Save</span></button>
        </div>
        {diskChanged && (
          <div className="workbench-notice usage-banner warning" role="alert">
            <span>{diskChanged} changed on disk after you opened it{dirty[diskChanged] ? ' and you have unsaved edits' : ''}.</span>
            <span className="code-banner-actions">
              <button type="button" className="secondary-button" onClick={() => void refreshFromDisk(false)}>Reload from disk</button>
              {dirty[diskChanged] && <button type="button" className="secondary-button" onClick={() => void refreshFromDisk(true)}>Keep my version</button>}
            </span>
          </div>
        )}
        {notice && <div className="workbench-notice" role="status"><span>{notice}</span><button type="button" className="icon-button compact" aria-label="Dismiss" onClick={() => setNotice(null)}><X size={12} /></button></div>}
        <div className="code-editor-host" ref={containerRef} aria-label="Code editor" />
        {editorReady && openPaths.length === 0 && <div className="code-empty"><Sparkles size={18} /><span>Choose a file from the list to edit it</span></div>}
      </section>
      {tutorOpen && (
        <LearningPanel
          progress={progress}
          result={learningResult}
          gitInfo={gitInfo}
          busy={learningBusy}
          formatting={formatting}
          error={learningError}
          question={question}
          onQuestionChange={setQuestion}
          onAction={(action) => void runLearningAction(action)}
          onPreferences={(nextAssistance, nextInline) => void updatePreferences(nextAssistance, nextInline)}
          onInsertSuggestion={insertSuggestion}
          onRecordLesson={() => void recordLesson()}
          onFormat={() => void formatActive()}
          teachingLibrary={teachingLibrary}
          teachingBusy={teachingBusy}
          onSaveTeachingEntry={saveTeachingEntry}
          onDeleteTeachingEntry={deleteTeachingEntry}
          onResetTeachingEntry={resetTeachingEntry}
          onGenerateTeachingDraft={generateTeachingDraft}
          onClose={() => setTutorOpen(false)}
        />
      )}
    </div>
  );
}

function learningState(
  projectId: string | null,
  filePath: string | null,
  assistance: LearningAssistance,
  inlineSuggestions: boolean,
): { projectId: string; filePath: string; assistance: LearningAssistance; inlineSuggestions: boolean } | null {
  return projectId && filePath ? { projectId, filePath, assistance, inlineSuggestions } : null;
}

function progressRef(progress: LearningProgress | null): LearningProgress['concepts'] {
  return progress?.concepts ?? [];
}
