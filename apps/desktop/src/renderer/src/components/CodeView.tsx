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
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type * as Monaco from 'monaco-editor';
import type {
  GitFileInfo,
  EditorWindowSnapshot,
  LearningAction,
  LearningAssistance,
  LearningEvaluationResult,
  LearningProgress,
  LearningReadiness,
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
import { LearningPanel, type LearningSelectionPreview } from './LearningPanel';
import { confirmDialog, promptDialog } from './AppDialog';

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
  version: number;
}

const normalise = (text: string): string => text.replace(/\r\n/g, '\n');
const POLL_MS = 3_000;
const MAX_LEARNING_CODE = 120_000;
const DEFAULT_FILE_PANE_WIDTH = 230;
const DEFAULT_LEARNING_PANE_WIDTH = 360;
const MAX_LEARNING_PANE_WIDTH = 760;

function sameLearningSelection(
  left: LearningSelectionPreview | null,
  right: LearningSelectionPreview | null,
): boolean {
  return left === right || Boolean(left && right
    && left.filePath === right.filePath
    && left.startLine === right.startLine
    && left.startColumn === right.startColumn
    && left.endLine === right.endLine
    && left.endColumn === right.endColumn
    && left.text === right.text);
}

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

export function boundedCode(
  value: string,
  selectedStartLine: number,
  selectedEndLine = selectedStartLine,
): string {
  if (value.length <= MAX_LEARNING_CODE) return value;
  const startLine = Math.max(1, selectedStartLine);
  const endLine = Math.max(startLine, selectedEndLine);
  const startOffset = offsetForLine(value, startLine);
  const endOffset = offsetForLine(value, endLine + 1);
  const selectionLength = Math.max(0, endOffset - startOffset);
  let rawBudget = MAX_LEARNING_CODE;
  let rendered = '';

  // Line-number prefixes count toward the tutor request schema, so shrink the raw slice until the final
  // numbered excerpt fits rather than only bounding the unnumbered source.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const { excerptStart, excerptEnd } = excerptRange(value, startOffset, endOffset, selectionLength, rawBudget);
    const firstLine = lineAtOffset(value, excerptStart);
    const lastLine = lineAtOffset(value, excerptEnd);
    const excerpt = value.slice(excerptStart, excerptEnd);
    const numbered = excerpt.split('\n').map((line, index) => `${firstLine + index}: ${line}`).join('\n');
    const above = firstLine > 1 ? `[KAI omitted lines 1-${firstLine - 1}]\n\n` : '';
    const below = lastLine < countLines(value) ? `\n\n[KAI omitted lines ${lastLine + 1}-${countLines(value)}]` : '';
    rendered = `${above}${numbered}${below}`;
    if (rendered.length <= MAX_LEARNING_CODE) return rendered;
    rawBudget -= rendered.length - MAX_LEARNING_CODE + 64;
    if (rawBudget <= 0) break;
  }

  // A pathological all-selected-range case can still have oversized metadata. Return a valid bounded
  // response rather than sending a request that fails schema validation.
  return rendered.slice(0, MAX_LEARNING_CODE);
}

function excerptRange(
  value: string,
  startOffset: number,
  endOffset: number,
  selectionLength: number,
  rawBudget: number,
): { excerptStart: number; excerptEnd: number } {
  let excerptStart: number;
  let excerptEnd: number;
  if (selectionLength >= rawBudget) {
    excerptStart = startOffset + Math.floor((selectionLength - rawBudget) / 2);
    excerptEnd = Math.min(endOffset, excerptStart + rawBudget);
  } else {
    const remaining = rawBudget - selectionLength;
    const beforeBudget = Math.floor(remaining * 0.68);
    const afterBudget = remaining - beforeBudget;
    excerptStart = Math.max(0, startOffset - beforeBudget);
    excerptEnd = Math.min(value.length, endOffset + afterBudget);
    const lineStart = value.lastIndexOf('\n', Math.max(0, excerptStart - 1)) + 1;
    if (excerptStart - lineStart <= 200) excerptStart = lineStart;
    const lineEnd = value.indexOf('\n', excerptEnd);
    if (lineEnd >= 0 && lineEnd - excerptEnd <= 200) excerptEnd = lineEnd;
  }
  return { excerptStart, excerptEnd };
}

function offsetForLine(value: string, line: number): number {
  let offset = 0;
  for (let current = 1; current < line; current += 1) {
    const next = value.indexOf('\n', offset);
    if (next < 0) return value.length;
    offset = next + 1;
  }
  return offset;
}

function lineAtOffset(value: string, offset: number): number {
  let line = 1;
  let cursor = 0;
  while (cursor < offset) {
    const next = value.indexOf('\n', cursor);
    if (next < 0 || next >= offset) break;
    line += 1;
    cursor = next + 1;
  }
  return line;
}

function countLines(value: string): number {
  let count = 1;
  for (let index = value.indexOf('\n'); index >= 0; index = value.indexOf('\n', index + 1)) count += 1;
  return count;
}

export function CodeView({
  activeProject,
  editorState,
  autoSave,
  autoSaveDelayMs,
  onOpenSettings,
}: {
  activeProject: ProjectRecord | null;
  editorState: EditorWindowSnapshot | null;
  autoSave: boolean;
  autoSaveDelayMs: number;
  onOpenSettings: () => void;
}): ReactNode {
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
  // Whether the tutor panel is open is remembered between visits.
  const [tutorOpen, setTutorOpenState] = useState(() => {
    try {
      return window.localStorage.getItem('kai.learningTutorOpen') !== 'false';
    } catch {
      return true;
    }
  });
  const [filePaneWidth, setFilePaneWidth] = useState(() => {
    try {
      return clampNumber(Number(window.localStorage.getItem('kai.codeFilePaneWidth')) || DEFAULT_FILE_PANE_WIDTH, 160, 420);
    } catch {
      return DEFAULT_FILE_PANE_WIDTH;
    }
  });
  const [learningPaneWidth, setLearningPaneWidth] = useState(() => {
    try {
      return clampNumber(Number(window.localStorage.getItem('kai.learningPaneWidth')) || DEFAULT_LEARNING_PANE_WIDTH, 280, MAX_LEARNING_PANE_WIDTH);
    } catch {
      return DEFAULT_LEARNING_PANE_WIDTH;
    }
  });
  const [codeResizing, setCodeResizing] = useState<'files' | 'learning' | null>(null);
  const setTutorOpen = (next: boolean | ((current: boolean) => boolean)): void => {
    setTutorOpenState((current) => {
      const value = typeof next === 'function' ? next(current) : next;
      try {
        window.localStorage.setItem('kai.learningTutorOpen', String(value));
      } catch {
        // A remembered panel state is a convenience only.
      }
      return value;
    });
  };
  // The mode the user just picked; it wins over a progress load that was already in flight.
  const chosenPreferences = useRef<LearningProgress['preferences'] | null>(null);
  const confirmedPreferences = useRef<LearningProgress['preferences'] | null>(null);
  const [optimisticPreferences, setOptimisticPreferences] = useState<LearningProgress['preferences'] | null>(null);
  const [progress, setProgress] = useState<LearningProgress | null>(null);
  const [readiness, setReadiness] = useState<LearningReadiness | null>(null);
  const [learningResult, setLearningResult] = useState<LearningEvaluationResult | null>(null);
  const [learningBusy, setLearningBusy] = useState<LearningAction | 'record' | null>(null);
  const [learningError, setLearningError] = useState<string | null>(null);
  const [learningSelection, setLearningSelection] = useState<LearningSelectionPreview | null>(null);
  const [question, setQuestion] = useState('');
  const [gitInfo, setGitInfo] = useState<GitFileInfo | null>(null);
  const [formatting, setFormatting] = useState(false);
  const [teachingLibrary, setTeachingLibrary] = useState<TeachingLibrary | null>(null);
  const [teachingBusy, setTeachingBusy] = useState<string | null>(null);
  const assistance = optimisticPreferences?.assistance ?? progress?.preferences.assistance ?? 'guided';
  const inlineSuggestions = optimisticPreferences?.inlineSuggestions ?? progress?.preferences.inlineSuggestions ?? false;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const documents = useRef(new Map<string, OpenDocument>());
  const activeRef = useRef<string | null>(null);
  const openPathsRef = useRef<string[]>([]);
  const lastLearningRequest = useRef<LearningTutorRequest | null>(null);
  const learningActionRef = useRef<(action: LearningAction) => Promise<LearningEvaluationResult | null>>(async () => null);
  const projectIdRef = useRef<string | null>(projectId);
  const initializedProjectId = useRef<string | null>(null);
  const restoredEditorProject = useRef<string | null>(null);
  const preferenceRevision = useRef(0);
  const learningBusyRef = useRef(false);
  const activeLearningRequestId = useRef<string | null>(null);
  const codeResizeOrigin = useRef<{ kind: 'files' | 'learning'; x: number; width: number } | null>(null);
  const autoSaveTimers = useRef(new Map<string, number>());
  const autoSaveInFlight = useRef(new Set<string>());
  const autoSaveConfigRef = useRef({ enabled: autoSave, delayMs: autoSaveDelayMs });
  const diskChangedRef = useRef<string | null>(diskChanged);
  const learningStateRef = useRef({ projectId, filePath: activePath, assistance, inlineSuggestions, progress });
  activeRef.current = activePath;
  openPathsRef.current = openPaths;
  projectIdRef.current = projectId;
  autoSaveConfigRef.current = { enabled: autoSave, delayMs: autoSaveDelayMs };
  diskChangedRef.current = diskChanged;
  learningStateRef.current = { projectId, filePath: activePath, assistance, inlineSuggestions, progress };

  function clearAutoSaveTimer(path?: string): void {
    if (path) {
      const timer = autoSaveTimers.current.get(path);
      if (timer) window.clearTimeout(timer);
      autoSaveTimers.current.delete(path);
      return;
    }
    for (const timer of autoSaveTimers.current.values()) window.clearTimeout(timer);
    autoSaveTimers.current.clear();
  }

  function scheduleAutoSave(path: string): void {
    clearAutoSaveTimer(path);
    const config = autoSaveConfigRef.current;
    if (!config.enabled || diskChangedRef.current === path) return;
    const timer = window.setTimeout(() => {
      autoSaveTimers.current.delete(path);
      const document = documents.current.get(path);
      if (!document || normalise(document.model.getValue()) === document.savedValue) return;
      if (autoSaveInFlight.current.has(path)) {
        scheduleAutoSave(path);
        return;
      }
      void saveDocument(path, 'auto');
    }, config.delayMs);
    autoSaveTimers.current.set(path, timer);
  }

  const syncLearningSelection = useCallback((): void => {
    const path = activeRef.current;
    const document = path ? documents.current.get(path) : undefined;
    const editor = editorRef.current;
    if (!path || !document || !editor || editor.getModel() !== document.model) {
      setLearningSelection((current) => current === null ? current : null);
      return;
    }
    const selection = editor.getSelection();
    const cursor = editor.getPosition();
    const next: LearningSelectionPreview = {
      filePath: path,
      startLine: selection?.startLineNumber ?? cursor?.lineNumber ?? 1,
      startColumn: selection?.startColumn ?? cursor?.column ?? 1,
      endLine: selection?.endLineNumber ?? cursor?.lineNumber ?? 1,
      endColumn: selection?.endColumn ?? cursor?.column ?? 1,
      text: selection && !selection.isEmpty() ? document.model.getValueInRange(selection).slice(0, 4_000) : '',
    };
    setLearningSelection((current) => sameLearningSelection(current, next) ? current : next);
  }, []);

  function beginCodeResize(kind: 'files' | 'learning', event: ReactPointerEvent<HTMLDivElement>): void {
    codeResizeOrigin.current = { kind, x: event.clientX, width: kind === 'files' ? filePaneWidth : learningPaneWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    setCodeResizing(kind);
  }

  function continueCodeResize(event: ReactPointerEvent<HTMLDivElement>): void {
    const origin = codeResizeOrigin.current;
    if (!origin) return;
    const delta = event.clientX - origin.x;
    if (origin.kind === 'files') setFilePaneWidth(clampNumber(origin.width + delta, 160, 420));
    else setLearningPaneWidth(clampNumber(origin.width - delta, 280, MAX_LEARNING_PANE_WIDTH));
  }

  function endCodeResize(event: ReactPointerEvent<HTMLDivElement>): void {
    codeResizeOrigin.current = null;
    setCodeResizing(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function resizeCodePaneWithKeyboard(kind: 'files' | 'learning', event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 32 : 12;
    const current = kind === 'files' ? filePaneWidth : learningPaneWidth;
    let next = current;
    if (event.key === 'Home') next = kind === 'files' ? 160 : 280;
    else if (event.key === 'End') next = kind === 'files' ? 420 : MAX_LEARNING_PANE_WIDTH;
    else if (kind === 'files') next += event.key === 'ArrowRight' ? step : -step;
    else next += event.key === 'ArrowLeft' ? step : -step;
    next = clampNumber(next, kind === 'files' ? 160 : 280, kind === 'files' ? 420 : MAX_LEARNING_PANE_WIDTH);
    if (kind === 'files') setFilePaneWidth(next);
    else setLearningPaneWidth(next);
  }

  useEffect(() => {
    syncLearningSelection();
  }, [activePath, editorReady, syncLearningSelection]);

  const reportDocument = useCallback((documentProjectId: string, path: string, document: OpenDocument): void => {
    void window.kaiDesktop.updateEditorDocument({
      projectId: documentProjectId,
      path,
      content: document.model.getValue(),
      savedContent: document.savedValue,
      expectedHash: document.opened.hash,
      eol: document.opened.eol,
      bom: document.opened.bom,
      dirty: normalise(document.model.getValue()) !== document.savedValue,
    }).catch(() => undefined);
  }, []);

  const reportWindow = useCallback((documentProjectId: string, nextOpenPaths: string[], nextActivePath: string | null): void => {
    void window.kaiDesktop.updateEditorWindow({
      projectId: documentProjectId,
      documents: [],
      openPaths: nextOpenPaths,
      activePath: nextActivePath,
    }).catch(() => undefined);
  }, []);

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

  useEffect(() => {
    try {
      window.localStorage.setItem('kai.codeFilePaneWidth', String(filePaneWidth));
      window.localStorage.setItem('kai.learningPaneWidth', String(learningPaneWidth));
    } catch {
      // Remembering pane widths is a convenience only.
    }
  }, [filePaneWidth, learningPaneWidth]);

  useEffect(() => {
    if (!autoSave) {
      clearAutoSaveTimer();
      return;
    }
    if (!editorReady || !projectId) return;
    for (const path of openPathsRef.current) {
      if (documents.current.get(path)) scheduleAutoSave(path);
    }
    // The autosave configuration is intentionally applied to every open dirty document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSave, autoSaveDelayMs, editorReady, projectId]);

  // The main process owns snapshots, so changing projects replaces the local session cleanly.
  useEffect(() => {
    if (initializedProjectId.current === projectId) return;
    initializedProjectId.current = projectId;
    restoredEditorProject.current = null;
    for (const document of documents.current.values()) document.model.dispose();
    documents.current.clear();
    setOpenPaths([]);
    setActivePath(null);
    setDirty({});
    setDiskChanged(null);
    setNotice(null);
    setFiles([]);
    setProgress(null);
    chosenPreferences.current = null;
    confirmedPreferences.current = null;
    preferenceRevision.current = 0;
    setOptimisticPreferences(null);
    setLearningResult(null);
    setLearningError(null);
    setQuestion('');
    setGitInfo(null);
    activeLearningRequestId.current = null;
    learningBusyRef.current = false;
    clearAutoSaveTimer();
    autoSaveInFlight.current.clear();
    void loadTree();
    void window.kaiDesktop.learningReadiness().then(unwrap).then(setReadiness).catch((caught) => {
      setReadiness(null);
      setLearningError(caught instanceof Error ? caught.message : 'Learning Mode readiness could not be loaded.');
    });
    if (projectId) {
      const revisionAtLoad = preferenceRevision.current;
      void window.kaiDesktop.learningProgress(projectId).then(unwrap).then((loaded) => {
        if (preferenceRevision.current === revisionAtLoad) confirmedPreferences.current = loaded.preferences;
        setProgress(chosenPreferences.current ? { ...loaded, preferences: chosenPreferences.current } : loaded);
      }).catch((caught) => {
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
      disposables.push(editor.onDidChangeCursorSelection(syncLearningSelection));
      disposables.push(editor.onDidChangeModel(syncLearningSelection));

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
          const explicit = context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Explicit;
          let state = learningStateRef.current;
          if (!state.projectId || !state.filePath || state.assistance !== 'copilot' || !state.inlineSuggestions) return { items: [] };
          if (!explicit) {
            const idle = await new Promise<boolean>((resolve) => {
              let cancellation: Monaco.IDisposable | null = null;
              const timer = window.setTimeout(() => {
                cancellation?.dispose();
                resolve(true);
              }, 450);
              cancellation = token.onCancellationRequested(() => {
                window.clearTimeout(timer);
                resolve(false);
              });
            });
            if (!idle || token.isCancellationRequested) return { items: [] };
            state = learningStateRef.current;
            if (!state.projectId || !state.filePath || state.assistance !== 'copilot' || !state.inlineSuggestions) return { items: [] };
          }
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
      clearAutoSaveTimer();
      autoSaveInFlight.current.clear();
      for (const document of documents.current.values()) document.model.dispose();
      documents.current.clear();
    };
    // The first editor is intentionally created once for the lifetime of the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!editorReady || !projectId || !monacoRef.current || !editorRef.current) return;
    if (restoredEditorProject.current === projectId) return;
    restoredEditorProject.current = projectId;
    const snapshot = editorState?.projectId === projectId ? editorState : null;
    if (!snapshot) return;
    const monaco = monacoRef.current;
    for (const state of snapshot.documents) {
      if (documents.current.has(state.path)) continue;
      const language = languageForPath(state.path);
      const model = monaco.editor.createModel(state.content, language, monaco.Uri.file(`/${state.path}`));
      model.setEOL(state.eol === 'crlf' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
      const document: OpenDocument = {
        opened: {
          path: state.path,
          content: state.content,
          eol: state.eol,
          bom: state.bom,
          hash: state.expectedHash,
          mtimeMs: 0,
          size: state.content.length,
        },
        model,
        savedValue: normalise(state.savedContent),
        language,
        version: 1,
      };
      documents.current.set(state.path, document);
      model.onDidChangeContent(() => {
        if (projectIdRef.current !== state.projectId) return;
        document.version += 1;
        const nextDirty = normalise(model.getValue()) !== document.savedValue;
        setDirty((current) => current[state.path] === nextDirty ? current : { ...current, [state.path]: nextDirty });
        reportDocument(state.projectId, state.path, document);
        scheduleAutoSave(state.path);
      });
    }
    const openPaths = snapshot.openPaths.filter((path) => documents.current.has(path));
    const activePath = snapshot.activePath && documents.current.has(snapshot.activePath)
      ? snapshot.activePath
      : openPaths.at(-1) ?? null;
    setOpenPaths(openPaths);
    setDirty((current) => ({
      ...current,
      ...Object.fromEntries([...documents.current.entries()]
        .filter(([path]) => openPaths.includes(path))
        .map(([path, document]) => [path, normalise(document.model.getValue()) !== document.savedValue])),
    }));
    setActivePath(activePath);
    editorRef.current.setModel(activePath ? documents.current.get(activePath)?.model ?? null : null);
  }, [editorReady, editorState, projectId, reportDocument]);

  useEffect(() => window.kaiDesktop.onEditorDocumentsSaved((savedDocuments) => {
    for (const saved of savedDocuments) {
      if (projectIdRef.current !== saved.projectId) continue;
      const document = documents.current.get(saved.path);
      if (!document) continue;
      document.opened = {
        ...document.opened,
        hash: saved.hash,
        mtimeMs: saved.mtimeMs,
        size: saved.size,
      };
      document.savedValue = normalise(saved.savedContent);
      clearAutoSaveTimer(saved.path);
      const nextDirty = normalise(document.model.getValue()) !== document.savedValue;
      setDirty((current) => current[saved.path] === nextDirty ? current : { ...current, [saved.path]: nextDirty });
      reportDocument(saved.projectId, saved.path, document);
    }
  }), [reportDocument]);

  // Warn when the open file changes on disk, for example because an agent edited it.
  useEffect(() => {
    if (!projectId) return;
    const timer = window.setInterval(() => {
      const path = activeRef.current;
      const document = path ? documents.current.get(path) : undefined;
      if (!path || !document) return;
      void window.kaiDesktop.projectFileChanged(projectId, path, document.opened.hash).then((response) => {
        if (response.ok && response.data && activeRef.current === path) {
          clearAutoSaveTimer(path);
          setDiskChanged(path);
        }
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
    const currentProjectId = projectIdRef.current;
    if (!currentProjectId || !monacoRef.current || !editorRef.current) return;
    setDiskChanged(null);
    let document = documents.current.get(path);
    if (!document) {
      try {
        const opened = unwrap(await window.kaiDesktop.readProjectFile(currentProjectId, path));
        if (projectIdRef.current !== currentProjectId) return;
        const monaco = monacoRef.current;
        const language = languageForPath(path);
        const model = monaco.editor.createModel(opened.content, language, monaco.Uri.file(`/${path}`));
        model.setEOL(opened.eol === 'crlf' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
        document = { opened, model, savedValue: normalise(opened.content), language, version: 1 };
        documents.current.set(path, document);
        const created = document;
        model.onDidChangeContent(() => {
          if (projectIdRef.current !== currentProjectId) return;
          created.version += 1;
          const nextDirty = normalise(model.getValue()) !== created.savedValue;
          setDirty((current) => current[path] === nextDirty ? current : { ...current, [path]: nextDirty });
          reportDocument(currentProjectId, path, created);
          scheduleAutoSave(path);
        });
        reportDocument(currentProjectId, path, created);
        setNotice(null);
      } catch (caught) {
        if (projectIdRef.current !== currentProjectId) return;
        setNotice(caught instanceof Error ? caught.message : 'That file could not be opened.');
        return;
      }
    }
    editorRef.current.setModel(document.model);
    const nextOpenPaths = openPathsRef.current.includes(path) ? openPathsRef.current : [...openPathsRef.current, path];
    openPathsRef.current = nextOpenPaths;
    setOpenPaths(nextOpenPaths);
    reportWindow(currentProjectId, nextOpenPaths, path);
    setActivePath(path);
    setLearningResult(null);
    setLearningError(null);
  }

  async function saveDocument(path: string, mode: 'manual' | 'auto'): Promise<void> {
    const document = path ? documents.current.get(path) : undefined;
    const currentProjectId = projectIdRef.current;
    if (!currentProjectId || !document) return;
    clearAutoSaveTimer(path);
    if (mode === 'auto') autoSaveInFlight.current.add(path);
    const content = document.model.getValue();
    let saveConflict = false;
    try {
      const response = await window.kaiDesktop.writeProjectFile({
        projectId: currentProjectId,
        path,
        content,
        expectedHash: document.opened.hash,
        eol: document.opened.eol,
        bom: document.opened.bom,
      });
      if (!response.ok) {
        if (response.error.code === 'CONFLICT') {
          saveConflict = true;
          setDiskChanged(path);
        }
        setNotice(response.error.message);
        return;
      }
      if (projectIdRef.current !== currentProjectId || documents.current.get(path) !== document) return;
      document.opened = { ...document.opened, hash: response.data.hash, mtimeMs: response.data.mtimeMs, size: response.data.size };
      document.savedValue = normalise(content);
      const stillLatest = document.model.getValue() === content;
      setDirty((current) => ({ ...current, [path]: !stillLatest }));
      reportDocument(currentProjectId, path, document);
      setNotice(`${mode === 'auto' ? 'Autosaved' : 'Saved'} ${path}`);
      if (stillLatest) setDiskChanged(null);
    } finally {
      if (mode === 'auto') {
        autoSaveInFlight.current.delete(path);
        const currentDocument = documents.current.get(path);
        if (projectIdRef.current === currentProjectId
          && currentDocument
          && normalise(currentDocument.model.getValue()) !== currentDocument.savedValue
          && !saveConflict
          && diskChangedRef.current !== path) {
          scheduleAutoSave(path);
        }
      }
    }
  }

  async function saveActive(): Promise<void> {
    const path = activeRef.current;
    if (path) await saveDocument(path, 'manual');
  }

  /** Re-read the file from disk. With keepEdits, only the stored hash moves, so the next save knowingly overwrites. */
  async function refreshFromDisk(keepEdits: boolean): Promise<void> {
    const path = activeRef.current;
    const document = path ? documents.current.get(path) : undefined;
    if (!projectId || !path || !document) return;
    try {
      const fresh = unwrap(await window.kaiDesktop.readProjectFile(projectId, path));
      if (projectIdRef.current !== projectId || documents.current.get(path) !== document) return;
      document.opened = fresh;
      if (!keepEdits) {
        document.model.setValue(fresh.content);
        document.savedValue = normalise(fresh.content);
        setDirty((current) => ({ ...current, [path]: false }));
      }
      reportDocument(projectId, path, document);
      setDiskChanged(null);
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : 'The file could not be reloaded.');
    }
  }

  async function closeFile(path: string): Promise<void> {
    if (dirty[path] && !(await confirmDialog({
      title: 'Discard unsaved changes?',
      detail: `${path} has unsaved changes.`,
      confirmLabel: 'Discard',
      destructive: true,
    }))) return;
    const currentProjectId = projectIdRef.current;
    if (currentProjectId) {
      await window.kaiDesktop.removeEditorDocument({ projectId: currentProjectId, path }).catch(() => undefined);
    }
    clearAutoSaveTimer(path);
    documents.current.get(path)?.model.dispose();
    documents.current.delete(path);
    const remaining = openPathsRef.current.filter((item) => item !== path);
    openPathsRef.current = remaining;
    setOpenPaths(remaining);
    if (currentProjectId) reportWindow(currentProjectId, remaining, activePath === path ? remaining.at(-1) ?? null : activePath);
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
    const path = (await promptDialog({
      title: 'Create a file',
      label: 'Project-relative file path',
      placeholder: 'src/util.ts',
      confirmLabel: 'Create file',
      validate: (value) => value.startsWith('/') || /^[A-Za-z]:/.test(value) ? 'Use a project-relative path.' : null,
    }))?.trim();
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
    if (learningBusyRef.current) return null;
    const path = activeRef.current;
    const document = path ? documents.current.get(path) : undefined;
    const editor = editorRef.current;
    if (!projectId || !path || !document || !editor) {
      setLearningError('Open a file before using Learning Mode.');
      return null;
    }
    setTutorOpen(true);
    if (action === 'explain-selection' && editor.getSelection()?.isEmpty()) {
      setLearningError('Select some code before asking for a selection explanation.');
      return null;
    }
    let errorText: string | undefined;
    if (action === 'explain-error') {
      errorText = (await promptDialog({
        title: 'Explain an error',
        label: 'Exact error message',
        placeholder: 'Paste the full stack trace or compiler message',
        confirmLabel: 'Explain error',
        multiline: true,
      }))?.trim() || undefined;
      if (!errorText) return null;
    }
    const selection = editor.getSelection();
    const selectedText = selection && !selection.isEmpty() ? document.model.getValueInRange(selection).slice(0, 50_000) : undefined;
    const requestId = `learning_${crypto.randomUUID()}`;
    const documentVersion = document.version;
    const request: LearningTutorRequest = {
      requestId,
      projectId,
      filePath: path,
      documentVersion,
      ...(selection ? {
        selection: {
          startLine: selection.startLineNumber,
          startColumn: selection.startColumn,
          endLine: selection.endLineNumber,
          endColumn: selection.endColumn,
        },
      } : {}),
      language: document.language,
      action,
      assistance,
      code: boundedCode(document.model.getValue(), selection?.startLineNumber ?? 1, selection?.endLineNumber ?? selection?.startLineNumber ?? 1),
      ...(selectedText ? { selectedText } : {}),
      cursorLine: editor.getPosition()?.lineNumber ?? 1,
      ...(errorText ? { errorText } : {}),
      ...(question.trim() ? { question: question.trim().slice(0, 4_000) } : {}),
    };
    activeLearningRequestId.current = requestId;
    learningBusyRef.current = true;
    setLearningBusy(action);
    setLearningError(null);
    try {
      const result = unwrap(await window.kaiDesktop.evaluateLearning(request));
      if (activeLearningRequestId.current !== requestId || !learningRequestStillCurrent(request, projectIdRef.current, activeRef.current, learningStateRef.current.assistance, editor, documents.current)) return null;
      lastLearningRequest.current = request;
      setLearningResult(result);
      setProgress(result.progress);
      return result;
    } catch (caught) {
      if (activeLearningRequestId.current === requestId) {
        setLearningError(caught instanceof Error ? caught.message : 'The tutor request failed.');
      }
      return null;
    } finally {
      if (activeLearningRequestId.current === requestId) {
        learningBusyRef.current = false;
        setLearningBusy(null);
      }
    }
  }
  learningActionRef.current = runLearningAction;

  async function updatePreferences(nextAssistance: LearningAssistance, nextInline: boolean): Promise<void> {
    if (!projectId) return;
    const chosen = { assistance: nextAssistance, inlineSuggestions: nextInline };
    const revision = preferenceRevision.current + 1;
    preferenceRevision.current = revision;
    chosenPreferences.current = chosen;
    setOptimisticPreferences(chosen);
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
      if (preferenceRevision.current !== revision) return;
      confirmedPreferences.current = updated.preferences;
      setProgress(updated);
      setOptimisticPreferences(updated.preferences);
    } catch (caught) {
      if (preferenceRevision.current !== revision) return;
      chosenPreferences.current = null;
      setOptimisticPreferences(null);
      const fallback = confirmedPreferences.current ?? { assistance: 'guided', inlineSuggestions: false };
      setProgress((current) => current ? { ...current, preferences: fallback } : current);
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
    const request = lastLearningRequest.current;
    if (!request || !learningRequestStillCurrent(request, projectIdRef.current, activeRef.current, learningStateRef.current.assistance, editor, documents.current)) {
      setNotice('The tutor suggestion was ignored because the file or selection changed.');
      return;
    }
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

  const paneStyle = {
    '--code-file-pane-width': `${filePaneWidth}px`,
    '--code-learning-pane-width': `${learningPaneWidth}px`,
  } as CSSProperties;
  return (
    <div className={`code-view ${tutorOpen ? 'learning-open' : ''} ${codeResizing ? 'is-resizing' : ''}`} style={paneStyle}>
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
      <div
        className="resize-handle code-pane-resize files"
        role="separator"
        aria-label="Resize project files pane"
        aria-orientation="vertical"
        aria-valuemin={160}
        aria-valuemax={420}
        aria-valuenow={Math.round(filePaneWidth)}
        tabIndex={0}
        onPointerDown={(event) => beginCodeResize('files', event)}
        onPointerMove={continueCodeResize}
        onPointerUp={endCodeResize}
        onPointerCancel={endCodeResize}
        onDoubleClick={() => setFilePaneWidth(DEFAULT_FILE_PANE_WIDTH)}
        onKeyDown={(event) => resizeCodePaneWithKeyboard('files', event)}
      />
      <section className="code-main">
        <div className="code-tabs" role="tablist" aria-label="Open files">
          {openPaths.map((path) => (
            <div key={path} className={`code-tab ${activePath === path ? 'active' : ''}`} role="tab" aria-selected={activePath === path}>
              <button type="button" className="code-tab-name" onClick={() => void openFile(path)}><span className="truncate">{path.split('/').at(-1)}</span>{dirty[path] && <span className="code-dirty">●</span>}</button>
              <button type="button" className="icon-button compact" aria-label={`Close ${path}`} onClick={() => void closeFile(path)}><X size={11} /></button>
            </div>
          ))}
          <span className="code-tabs-spacer" />
          {autoSave && activePath && dirty[activePath] && <span className="code-autosave-status" role="status">Autosave on</span>}
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
        <>
          <div
            className="resize-handle code-pane-resize learning"
            role="separator"
            aria-label="Resize learning tutor pane"
            aria-orientation="vertical"
            aria-valuemin={280}
            aria-valuemax={MAX_LEARNING_PANE_WIDTH}
            aria-valuenow={Math.round(learningPaneWidth)}
            tabIndex={0}
            onPointerDown={(event) => beginCodeResize('learning', event)}
            onPointerMove={continueCodeResize}
            onPointerUp={endCodeResize}
            onPointerCancel={endCodeResize}
            onDoubleClick={() => setLearningPaneWidth(DEFAULT_LEARNING_PANE_WIDTH)}
            onKeyDown={(event) => resizeCodePaneWithKeyboard('learning', event)}
          />
          <LearningPanel
            progress={progress}
            readiness={readiness}
            result={learningResult}
            selection={learningSelection}
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
            onOpenSettings={onOpenSettings}
            onClose={() => setTutorOpen(false)}
          />
        </>
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

function learningRequestStillCurrent(
  request: LearningTutorRequest,
  projectId: string | null,
  activePath: string | null,
  assistance: LearningAssistance,
  editor: Monaco.editor.IStandaloneCodeEditor,
  documents: ReadonlyMap<string, OpenDocument>,
): boolean {
  if (projectId !== request.projectId) return false;
  if (activePath !== request.filePath || assistance !== request.assistance) return false;
  const document = documents.get(request.filePath);
  if (!document || document.version !== request.documentVersion) return false;
  if (!request.selection) return true;
  const selection = editor.getSelection();
  if (!selection) return false;
  if (
    selection.startLineNumber === request.selection.startLine
    && selection.startColumn === request.selection.startColumn
    && selection.endLineNumber === request.selection.endLine
    && selection.endColumn === request.selection.endColumn
  ) return true;
  return Boolean(request.selectedText && document.model.getValueInRange(selection) === request.selectedText);
}

function progressRef(progress: LearningProgress | null): LearningProgress['concepts'] {
  return progress?.concepts ?? [];
}

function clampNumber(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
