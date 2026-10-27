import {
  Braces,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  File as FileIcon,
  FilePlus,
  Folder,
  FolderPlus,
  PanelRightOpen,
  Pencil,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type * as Monaco from 'monaco-editor';
import type {
  CodeFormatResult,
  CodeGuideAction,
  CodeGuideView,
  GitFileInfo,
  GitChange,
  EditorWindowSnapshot,
  LearningAction,
  LearningAssistance,
  LearningEvaluationResult,
  LearningExplainBackGrade,
  LearningExplainBackHelp,
  LearningExplainBackHelpKind,
  LearningProgress,
  LearningReadiness,
  LearningTutorScope,
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
import { placeSuggestion } from '../learning-placement';
import { GitBadge } from './GitBadge';
import { changeMap, type FileChange } from './project-files-tree';
import { loadMonaco, monacoThemeName } from '../monaco-loader';
import { unwrap } from '../types';
import { LearningPanel, type LearningSelectionPreview, type TutorConversationTurn } from './LearningPanel';
import { projectLessons } from './learning-path';
import { GuidedReviewPanel } from './GuidedReviewPanel';
import { CodeGuidePanel, CodeGuideStrip } from './CodeGuidePanel';
import { confirmDialog, promptDialog } from './AppDialog';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { UiButton } from './UiButton';
import { UiTextInput } from './UiTextInput';

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

interface SuggestionPreview {
  filePath: string;
  range: Monaco.IRange;
  before: string;
  after: string;
  expectedVersion: number;
  insertedLines?: { start: number; end: number };
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
  formatOnSave = true,
  onOpenSettings,
  onCreateReviewFollowup,
  openRequest = null,
  learnRequest = null,
}: {
  /** A file another part of the app wants shown; a new `nonce` asks again even for the same path. */
  openRequest?: { path: string; nonce: number } | null;
  /** A Studio card to learn from, with the project that owns it already open; a new `nonce` asks again for it. */
  learnRequest?: { cardId: string; title: string; stale: boolean; staleReason: string | null; nonce: number } | null;
  activeProject: ProjectRecord | null;
  editorState: EditorWindowSnapshot | null;
  autoSave: boolean;
  autoSaveDelayMs: number;
  formatOnSave?: boolean;
  onOpenSettings: () => void;
  onCreateReviewFollowup: (prompt: string) => void;
}): ReactNode {
  const projectId = activeProject?.id ?? null;
  const [files, setFiles] = useState<ProjectFileEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Where the right-click menu is, and what it was opened on.
  const [fileMenu, setFileMenu] = useState<{ x: number; y: number; kind: 'file' | 'folder' | 'root'; path: string } | null>(null);
  // The file or folder last clicked in the tree. Delete and F2 act on this, the way a desktop file list works.
  const [selectedTree, setSelectedTree] = useState<{ kind: 'file' | 'folder'; path: string } | null>(null);
  const [openPaths, setOpenPaths] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [diskChanged, setDiskChanged] = useState<string | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  /** The failure that stopped the editor starting, named so the panel can offer a retry instead of a stall. */
  const [editorError, setEditorError] = useState<string | null>(null);
  /** Bumped to create the editor again after a failure; Monaco remembers nothing about a failed load. */
  const [editorAttempt, setEditorAttempt] = useState(0);
  /**
   * A click that arrives while Monaco is still starting is held here and honoured the moment it is ready, rather than
   * answered with "try again in a moment" and dropped. Monaco is its own lazily loaded chunk, so a reference clicked
   * in the first seconds of a project opening used to open nothing at all, which reads as a dead button.
   */
  const pendingOpenRef = useRef<(() => Promise<unknown>) | null>(null);
  // Whether the tutor panel is open is remembered between visits.
  const [tutorOpen, setTutorOpenState] = useState(() => {
    try {
      return window.localStorage.getItem('kai.learningTutorOpen') !== 'false';
    } catch {
      return true;
    }
  });
  const [sidePanel, setSidePanel] = useState<'learn' | 'review' | 'guide'>(() => {
    const saved = window.localStorage.getItem('kai.codeSidePanel');
    return saved === 'review' || saved === 'guide' ? saved : 'learn';
  });
  const [learningScope, setLearningScope] = useState<LearningTutorScope>(() => {
    try {
      const saved = window.localStorage.getItem('kai.learningTutorScope');
      return saved === 'active-file' || saved === 'project' ? saved : 'auto';
    } catch {
      return 'auto';
    }
  });
  /**
   * The Studio card the learner chose to learn from. It travels with every tutor request as `studioCardId`, so the
   * tutor reads that card and its artifacts rather than guessing from the question alone — and it is shown above the
   * composer, because context the learner cannot see is context they cannot correct.
   */
  const [learningCard, setLearningCard] = useState<{ id: string; title: string; stale: boolean; staleReason: string | null } | null>(null);
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
  const [responseLessonId, setResponseLessonId] = useState<string | null>(null);
  const [learningResult, setLearningResult] = useState<LearningEvaluationResult | null>(null);
  const [learningBusy, setLearningBusy] = useState<LearningAction | 'record' | null>(null);
  const [learningError, setLearningError] = useState<string | null>(null);
  /** What the last source action did, shown in the tutor panel, which is where the click happened. */
  const [referenceNotice, setReferenceNotice] = useState<string | null>(null);
  const [learningSelection, setLearningSelection] = useState<LearningSelectionPreview | null>(null);
  const [question, setQuestion] = useState('');
  const [submittedQuestion, setSubmittedQuestion] = useState('');
  const [submittedSource, setSubmittedSource] = useState<'user' | 'action'>('user');
  const [pendingTutorQuestion, setPendingTutorQuestion] = useState<{ requestId: string; text: string; source: 'user' | 'action'; action: LearningAction; stuckHint?: 1 | 2 | 3; status: 'sending' | 'failed' | 'cancelled'; error?: string } | null>(null);
  const [suggestionPreview, setSuggestionPreview] = useState<SuggestionPreview | null>(null);
  const [lastAppliedSuggestion, setLastAppliedSuggestion] = useState<{ filePath: string; version: number } | null>(null);
  const [tutorConversation, setTutorConversation] = useState<TutorConversationTurn[]>([]);
  const [appliedSuggestionNeedsExplanation, setAppliedSuggestionNeedsExplanation] = useState(false);
  // How many "I'm stuck" hints the learner has taken on the current step (0-3); a new question resets it.
  const [hintLevel, setHintLevel] = useState(0);
  const [gitInfo, setGitInfo] = useState<GitFileInfo | null>(null);
  const [formatting, setFormatting] = useState(false);
  const [offerInstallRuff, setOfferInstallRuff] = useState(false);
  const [teachingLibrary, setTeachingLibrary] = useState<TeachingLibrary | null>(null);
  const [teachingBusy, setTeachingBusy] = useState<string | null>(null);
  const assistance = optimisticPreferences?.assistance ?? progress?.preferences.assistance ?? 'guided';
  const teachingModes = optimisticPreferences?.teachingModes ?? progress?.preferences.teachingModes ?? [assistance];
  const inlineSuggestions = optimisticPreferences?.inlineSuggestions ?? progress?.preferences.inlineSuggestions ?? false;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const documents = useRef(new Map<string, OpenDocument>());
  const activeRef = useRef<string | null>(null);
  const openPathsRef = useRef<string[]>([]);
  const lastLearningRequest = useRef<LearningTutorRequest | null>(null);
  const learningActionRef = useRef<(action: LearningAction, inline?: boolean) => Promise<LearningEvaluationResult | null>>(async () => null);
  const projectIdRef = useRef<string | null>(projectId);
  const initializedProjectId = useRef<string | null>(null);
  const restoredEditorProject = useRef<string | null>(null);
  const preferenceRevision = useRef(0);
  const inlineRequestRef = useRef<Promise<LearningEvaluationResult | null> | null>(null);
  const learningBusyRef = useRef(false);
  const activeLearningRequestId = useRef<string | null>(null);
  const codeResizeOrigin = useRef<{ kind: 'files' | 'learning'; x: number; width: number } | null>(null);
  const autoSaveTimers = useRef(new Map<string, number>());
  const autoSaveInFlight = useRef(new Set<string>());
  const autoSaveConfigRef = useRef({ enabled: autoSave, delayMs: autoSaveDelayMs });
  const diskChangedRef = useRef<string | null>(diskChanged);
  const learningStateRef = useRef({ projectId, filePath: activePath, assistance, scope: learningScope, inlineSuggestions, progress });
  activeRef.current = activePath;
  openPathsRef.current = openPaths;
  projectIdRef.current = projectId;
  autoSaveConfigRef.current = { enabled: autoSave, delayMs: autoSaveDelayMs };
  // Read through a ref: the Ctrl+S command is registered once, when the editor is created.
  const formatOnSaveRef = useRef(formatOnSave);
  formatOnSaveRef.current = formatOnSave;
  // Languages whose missing formatter was already mentioned, so each save does not repeat it.
  const missingFormatterNoted = useRef(new Set<string>());
  // Git state for the file tree: what changed since the last commit and whether it is staged.
  const [gitChanges, setGitChanges] = useState<ReadonlyMap<string, FileChange>>(new Map());
  const [reviewChanges, setReviewChanges] = useState<GitChange[]>([]);
  const refreshGitChanges = useCallback(async (): Promise<void> => {
    const id = projectIdRef.current;
    if (!id) {
      setGitChanges(new Map());
      setReviewChanges([]);
      return;
    }
    try {
      const overview = unwrap(await window.kaiDesktop.gitOverview(id));
      if (projectIdRef.current === id) {
        setGitChanges(overview.isRepository ? changeMap(overview.changes) : new Map());
        setReviewChanges(overview.isRepository ? overview.changes : []);
      }
    } catch {
      // The badges are a convenience; a failed status check leaves the last known state.
    }
  }, []);
  // Where the whole project is, from the rules — free to read, so it is refreshed whenever anything it reads moves.
  // The explanation inside it is the paid part, and arrives only when the Guide panel asks for it.
  const [codeGuide, setCodeGuide] = useState<CodeGuideView | null>(null);
  const [guideExplaining, setGuideExplaining] = useState(false);
  const [guideError, setGuideError] = useState<string | null>(null);
  const [guideBusy, setGuideBusy] = useState(false);
  const [guideStripHidden, setGuideStripHidden] = useState(() => {
    try { return window.localStorage.getItem('kai.codeGuideStripHidden') === 'true'; } catch { return false; }
  });

  function toggleGuideStrip(hidden: boolean): void {
    setGuideStripHidden(hidden);
    try { window.localStorage.setItem('kai.codeGuideStripHidden', String(hidden)); } catch { /* Session state still works. */ }
  }

  /** Opens one of the side panels, remembering the choice the way the tab buttons already do. */
  function openSidePanel(panel: 'learn' | 'review' | 'guide'): void {
    setSidePanel(panel);
    window.localStorage.setItem('kai.codeSidePanel', panel);
  }

  /**
   * Starts the editor again after it failed to come up. Without this the pane had no way forward: every file click
   * answered "try again in a moment" and nothing ever changed. Monaco is asked to load afresh, and because a failed
   * load is not remembered, this is a genuinely new attempt rather than the same rejection replayed.
   */
  function retryEditor(): void {
    pendingOpenRef.current = null;
    setEditorError(null);
    setNotice('Starting the code editor again…');
    setEditorAttempt((attempt) => attempt + 1);
  }

  /**
   * The rules reading the project: the repository, the files, what has been studied, the board. No provider is
   * called, so this is free to re-run — which is what keeps the strip above the editor live without a timer of its
   * own (the git poll that refreshes `reviewChanges` already drives it).
   *
   * A failure is said out loud rather than swallowed. The service behind this degrades every source to empty, so a
   * rejection here means the call itself is broken — and a broken call that leaves the panel on "Reading where this
   * project is…" forever reads as "still working", which hides the cause.
   */
  useEffect(() => {
    if (!projectId) { setCodeGuide(null); return undefined; }
    let cancelled = false;
    void window.kaiDesktop.readCodeGuide(projectId).then(unwrap)
      .then((next) => {
        if (cancelled) return;
        setCodeGuide(next);
        setGuideError(null);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setGuideError(caught instanceof Error ? caught.message : 'The guide could not read this project.');
      });
    return () => { cancelled = true; };
  }, [projectId, reviewChanges, progress, files]);

  /**
   * Writes the walkthrough, once per situation. The key is what stops a failed call from retrying forever: an
   * attempt is remembered per (project, step), so a provider that is down leaves the button in the reader's hands
   * rather than looping, and a project that moves on to another step is explained on its own.
   */
  const autoExplainedGuide = useRef<string | null>(null);
  useEffect(() => {
    if (sidePanel !== 'guide' || !projectId || !codeGuide || codeGuide.narrative || guideExplaining) return;
    const key = `${projectId}|${codeGuide.currentStepId}|${codeGuide.history.length}`;
    if (autoExplainedGuide.current === key) return;
    autoExplainedGuide.current = key;
    void explainCodeGuide();
  }, [sidePanel, projectId, codeGuide, guideExplaining]);

  /** The walkthrough. The service only passes the call on when the stored explanation no longer fits the project. */
  async function explainCodeGuide(): Promise<void> {
    if (!projectId) return;
    setGuideExplaining(true);
    setGuideError(null);
    try {
      setCodeGuide(unwrap(await window.kaiDesktop.explainCodeGuide(projectId)));
    } catch (caught) {
      setGuideError(caught instanceof Error ? caught.message : 'The guide could not write a walkthrough.');
    } finally {
      setGuideExplaining(false);
    }
  }

  /**
   * Presses the one button the guide offers.
   *
   * The guide coaches the parts a person has to do themselves — commit, study, write a test — so those steps name
   * where they happen rather than offering to do them. What is left is navigation, and starting version control on
   * a folder that has none, which is the one act with nowhere else to point at yet.
   */
  async function runCodeGuideAction(action: CodeGuideAction): Promise<void> {
    if (!projectId) return;
    if (action === 'open-learn') { setTutorOpen(true); openSidePanel('learn'); return; }
    if (action === 'open-review') { setTutorOpen(true); openSidePanel('review'); return; }
    if (action === 'init-git') {
      setGuideBusy(true);
      setGuideError(null);
      try {
        unwrap(await window.kaiDesktop.gitInit(projectId));
        // Re-read straight away so the strip moves on by itself rather than at the next poll.
        await refreshGitChanges();
      } catch (caught) {
        setGuideError(caught instanceof Error ? caught.message : 'Version control could not be started.');
      } finally {
        setGuideBusy(false);
      }
    }
  }
  // How many changed files each folder holds, so a collapsed folder still shows something changed inside it.
  const changedInFolder = useMemo(() => {
    const counts = new Map<string, number>();
    for (const path of gitChanges.keys()) {
      const parts = path.split('/');
      for (let index = 1; index < parts.length; index += 1) {
        const folder = parts.slice(0, index).join('/');
        counts.set(folder, (counts.get(folder) ?? 0) + 1);
      }
    }
    return counts;
  }, [gitChanges]);
  diskChangedRef.current = diskChanged;
  learningStateRef.current = { projectId, filePath: activePath, assistance, scope: learningScope, inlineSuggestions, progress };

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

  // Keyed on the conversation only: a project switch restores that project's session first, and only then is it saved.
  useEffect(() => {
    const id = projectIdRef.current;
    if (!id || initializedProjectId.current !== id) return;
    writeTutorSession(id, {
      turns: tutorConversation,
      submittedQuestion,
      submittedSource,
      ...(learningResult ? { current: learningResult.response, progress: learningResult.progress } : {}),
    });
  }, [tutorConversation, submittedQuestion, submittedSource, learningResult]);

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
    setResponseLessonId(null);
    setLearningError(null);
    setQuestion('');
    setLearningCard(null);
    setPendingTutorQuestion(null);
    setSuggestionPreview(null);
    setLastAppliedSuggestion(null);
    const saved = projectId ? readTutorSession(projectId) : null;
    setSubmittedQuestion(saved?.submittedQuestion ?? '');
    setSubmittedSource(saved?.submittedSource ?? 'user');
    setTutorConversation(saved?.turns ?? []);
    if (saved?.current && saved.progress) setLearningResult({ response: saved.current, progress: saved.progress });
    setAppliedSuggestionNeedsExplanation(false);
    setHintLevel(0);
    setGitInfo(null);
    // The guide is about one project: a newly opened one starts from nothing rather than from the last one's answer,
    // and the remember-once guard is cleared with it so the new project gets its own walkthrough.
    setCodeGuide(null);
    setGuideError(null);
    autoExplainedGuide.current = null;
    if (activeLearningRequestId.current) void window.kaiDesktop.cancelLearning(activeLearningRequestId.current).catch(() => undefined);
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
        if (projectIdRef.current !== projectId) return;
        if (preferenceRevision.current === revisionAtLoad) confirmedPreferences.current = loaded.preferences;
        setProgress(chosenPreferences.current ? { ...loaded, preferences: chosenPreferences.current } : loaded);
      }).catch((caught) => {
        setLearningError(caught instanceof Error ? caught.message : 'Learning progress could not be loaded.');
      });
    }
  }, [loadTree, projectId]);

  // Git state changes from outside the editor too (agents, the terminal, the Git page), so it is checked on a
  // slow timer and whenever the window comes back into focus.
  useEffect(() => {
    setGitChanges(new Map());
    void refreshGitChanges();
    const timer = window.setInterval(() => void refreshGitChanges(), 10_000);
    const onFocus = (): void => { void refreshGitChanges(); };
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [projectId, refreshGitChanges]);

  // Create the editor on first use, and again when the learner asks for a retry after a failed start.
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
        inlineSuggest: { enabled: true, showToolbar: 'always' },
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
        // Code-action commands are looked up globally, but addAction registers under an editor-prefixed id,
        // so the lightbulb entries need their own global command to resolve to.
        disposables.push(monaco.editor.registerCommand(`kai.learning.${action}`, () => void learningActionRef.current(action)));
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
          // Coalesce typing while a provider request is in flight; the newest live
          // Monaco request gets its own cursor snapshot once the previous one finishes.
          while (inlineRequestRef.current) {
            await inlineRequestRef.current;
            if (token.isCancellationRequested) return { items: [] };
          }
          state = learningStateRef.current;
          if (!state.inlineSuggestions || state.assistance !== 'copilot' || token.isCancellationRequested || editor.getModel() !== model || !editor.getSelection()?.isEmpty()) return { items: [] };
          const pending = learningActionRef.current('complete', true);
          inlineRequestRef.current = pending;
          let result: LearningEvaluationResult | null;
          try { result = await pending; }
          finally { if (inlineRequestRef.current === pending) inlineRequestRef.current = null; }
          if (token.isCancellationRequested || !learningStateRef.current.inlineSuggestions || learningStateRef.current.assistance !== 'copilot' || !result?.response.suggestion) return { items: [] };
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
      setEditorError(null);
      setEditorReady(true);
    }).catch((caught) => {
      const message = caught instanceof Error ? caught.message : 'The editor could not be loaded.';
      setEditorError(message);
      setNotice(message);
    });
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
    // The editor is created once per attempt and lives for the lifetime of the view; `editorAttempt` is the learner
    // asking for another go after a failure, which is also what runs the dispose path above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorAttempt]);

  // Whatever was clicked while the editor was starting is opened as soon as it is ready, so the click is kept.
  useEffect(() => {
    if (!editorReady) return;
    const pending = pendingOpenRef.current;
    if (!pending) return;
    pendingOpenRef.current = null;
    void pending();
  }, [editorReady]);

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

  const handledOpenRequest = useRef(0);
  useEffect(() => {
    // The editor may still be starting, so the request waits until it is ready and is then handled once.
    if (!openRequest || !editorReady || !projectId || openRequest.nonce === handledOpenRequest.current) return;
    handledOpenRequest.current = openRequest.nonce;
    void openFile(openRequest.path);
    // openFile reads the current editor through refs, so it does not need to be a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest, editorReady, projectId]);

  const handledLearnRequest = useRef(0);
  useEffect(() => {
    if (!learnRequest || learnRequest.nonce === handledLearnRequest.current) return;
    handledLearnRequest.current = learnRequest.nonce;
    // The card arrives whole from the Studio, which is the view that holds the board, and the project that owns it has
    // been opened by the time this runs — so the title and staleness shown are the ones the learner just clicked.
    setLearningCard({ id: learnRequest.cardId, title: learnRequest.title, stale: learnRequest.stale, staleReason: learnRequest.staleReason });
    openSidePanel('learn');
    setTutorOpen(true);
    // The question is written, not sent: starting a model turn is the learner's call.
    setQuestion(`What should I do for the Studio card "${learnRequest.title}", and which files should I change?`);
    // openSidePanel and setTutorOpen only touch state, so the request is the whole dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [learnRequest]);

  /** Monaco arrives in its own chunk, so a click on a source button can land before the editor exists. */
  function waitForEditor(timeoutMs = 5_000): Promise<Monaco.editor.IStandaloneCodeEditor | null> {
    if (editorRef.current) return Promise.resolve(editorRef.current);
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const poll = (): void => {
        if (editorRef.current) resolve(editorRef.current);
        else if (Date.now() >= deadline) resolve(null);
        else window.setTimeout(poll, 100);
      };
      poll();
    });
  }

  /**
   * Holds a click until the editor is up, and says so. Monaco arrives in its own chunk, so the first seconds of a
   * project opening are exactly when a reference gets clicked; dropping that click is what made those buttons look
   * dead. A load that has actually failed is not worth waiting for, so that case is reported instead.
   */
  function holdUntilEditorReady(path: string): false {
    pendingOpenRef.current = () => openFile(path);
    setNotice(`Opening ${path} as soon as the editor finishes starting…`);
    return false;
  }

  /** Whether the file is on screen now. `false` means it was deferred or refused, and a notice says which. */
  async function openFile(path: string): Promise<boolean> {
    const currentProjectId = projectIdRef.current;
    if (!currentProjectId) {
      setNotice('Open a project before opening a file.');
      return false;
    }
    if (!(await waitForEditor(editorError ? 0 : 15_000))) {
      if (editorError) {
        setNotice(`The code editor could not start: ${editorError}`);
        return false;
      }
      return holdUntilEditorReady(path);
    }
    setDiskChanged(null);
    let document = documents.current.get(path);
    if (!document) {
      try {
        const opened = unwrap(await window.kaiDesktop.readProjectFile(currentProjectId, path));
        if (projectIdRef.current !== currentProjectId) return false;
        const monaco = monacoRef.current;
        if (!monaco) return holdUntilEditorReady(path);
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
        if (projectIdRef.current !== currentProjectId) return false;
        setNotice(caught instanceof Error ? caught.message : 'That file could not be opened.');
        return false;
      }
    }
    const target = editorRef.current;
    if (!target) return holdUntilEditorReady(path);
    target.setModel(document.model);
    const nextOpenPaths = openPathsRef.current.includes(path) ? openPathsRef.current : [...openPathsRef.current, path];
    openPathsRef.current = nextOpenPaths;
    setOpenPaths(nextOpenPaths);
    reportWindow(currentProjectId, nextOpenPaths, path);
    activeRef.current = path;
    setActivePath(path);
    setLearningError(null);
    setReferenceNotice(null);
    return true;
  }

  async function saveDocument(path: string, mode: 'manual' | 'auto'): Promise<void> {
    const document = path ? documents.current.get(path) : undefined;
    const currentProjectId = projectIdRef.current;
    if (!currentProjectId || !document) return;
    clearAutoSaveTimer(path);
    if (mode === 'auto') autoSaveInFlight.current.add(path);
    // Only a save the learner asked for formats; autosave would reshuffle the file while they type.
    const formatNote = mode === 'manual' && formatOnSaveRef.current ? await formatDocument(currentProjectId, path, document, 'save') : '';
    if (projectIdRef.current !== currentProjectId || documents.current.get(path) !== document) return;
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
      setNotice(`${mode === 'auto' ? 'Autosaved' : 'Saved'} ${path}${formatNote}`);
      void refreshGitChanges();
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

  async function closeFile(path: string, force = false): Promise<void> {
    if (!force && dirty[path] && !(await confirmDialog({
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

  async function createFile(basePath = ''): Promise<void> {
    if (!projectId) return;
    const path = (await promptDialog({
      title: 'Create a file',
      label: 'Project-relative file path',
      initialValue: basePath ? `${basePath}/` : '',
      placeholder: 'src/util.ts',
      confirmLabel: 'Create file',
      validate: (value) => {
        if (!value.trim()) return 'A file path is required.';
        return value.startsWith('/') || /^[A-Za-z]:/.test(value) ? 'Use a project-relative path.' : null;
      },
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

  async function createFolder(basePath = ''): Promise<void> {
    if (!projectId) return;
    const path = (await promptDialog({
      title: 'Create a folder',
      label: 'Project-relative folder path',
      initialValue: basePath ? `${basePath}/` : '',
      placeholder: 'src/components',
      confirmLabel: 'Create folder',
      validate: (value) => {
        if (!value.trim()) return 'A folder path is required.';
        return value.startsWith('/') || /^[A-Za-z]:/.test(value) ? 'Use a project-relative path.' : null;
      },
    }))?.trim().replace(/\/+$/, '');
    if (!path) return;
    const response = await window.kaiDesktop.createProjectFolder({ projectId, path });
    if (!response.ok) {
      setNotice(response.error.message);
      return;
    }
    await loadTree();
    setExpanded((current) => {
      const next = new Set(current);
      next.add(path);
      const parts = path.split('/');
      for (let index = 1; index < parts.length; index += 1) next.add(parts.slice(0, index).join('/'));
      return next;
    });
  }

  async function renameTarget(target: { kind: 'file' | 'folder'; path: string }): Promise<void> {
    if (!projectId) return;
    if (target.kind === 'file' && dirty[target.path]) {
      setNotice('Save this file before renaming it.');
      return;
    }
    if (target.kind === 'folder' && openPaths.some((open) => (open === target.path || open.startsWith(`${target.path}/`)) && dirty[open])) {
      setNotice('Save the open files in this folder before renaming it.');
      return;
    }
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
      setNotice(response.error.message);
      return;
    }
    const affected = (candidate: string): boolean => candidate === target.path || candidate.startsWith(`${target.path}/`);
    const mapped = (candidate: string): string => `${to}${candidate.slice(target.path.length)}`;
    const reopened = activePath && affected(activePath) ? mapped(activePath) : null;
    for (const open of openPaths.filter(affected)) await closeFile(open, true);
    setOpenPaths((current) => current.map((open) => (affected(open) ? mapped(open) : open)));
    if (reopened) {
      setActivePath(reopened);
      await openFile(reopened);
    }
    await loadTree();
    void refreshGitChanges();
    setNotice(`Renamed ${target.path} to ${to}.`);
  }

  async function deleteTarget(target: { kind: 'file' | 'folder'; path: string }): Promise<void> {
    if (!projectId) return;
    const affected = (candidate: string): boolean => candidate === target.path || candidate.startsWith(`${target.path}/`);
    const affectedPaths = openPaths.filter(affected);
    const unsaved = affectedPaths.some((candidate) => dirty[candidate]);
    const planFolder = target.path === '.kai' || target.path.startsWith('.kai/');
    const confirmed = await confirmDialog({
      title: `Delete ${target.kind === 'folder' ? 'folder' : 'file'} "${target.path}"?`,
      detail: `${planFolder ? 'This is inside KAI’s plan folder. Deleting it removes plan records from this project. ' : ''}${target.kind === 'folder' ? 'Everything inside the folder is deleted. ' : ''}This cannot be undone from KAI.${unsaved ? ' Unsaved changes in the open files are lost.' : ''}`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!confirmed) return;
    const response = await window.kaiDesktop.deleteProjectPath({ projectId, path: target.path });
    if (!response.ok) {
      setNotice(response.error.message);
      return;
    }
    for (const open of affectedPaths) await closeFile(open, true);
    setNotice(`Deleted ${target.path}.`);
    await loadTree();
    void refreshGitChanges();
  }

  async function openLearningReference(filePath: string, startLine?: number, endLine?: number): Promise<void> {
    const originProject = projectIdRef.current;
    setReferenceNotice(null);
    const opened = await openFile(filePath);
    if (!opened) {
      // Deferred rather than failed: replay the whole click — file and line range together — once the editor is up.
      // `openFile` has already said what is happening, and a failed load has already named its own cause.
      if (!editorError) pendingOpenRef.current = () => openLearningReference(filePath, startLine, endLine);
      return;
    }
    const editor = editorRef.current;
    if (projectIdRef.current !== originProject) return;
    // A click that changes nothing is indistinguishable from a broken button, so say what happened.
    if (activeRef.current !== filePath || !editor) {
      setReferenceNotice(`Could not open ${filePath}. Open it from the project file list to check it.`);
      return;
    }
    if (startLine) {
      const model = editor.getModel();
      if (!model || startLine > model.getLineCount() || (endLine ?? startLine) > model.getLineCount()) {
        setLearningError('The cited lines no longer exist. The file may have changed since this lesson.');
        return;
      }
      const lastLine = Math.max(startLine, endLine ?? startLine);
      editor.setSelection({ startLineNumber: startLine, startColumn: 1, endLineNumber: lastLine, endColumn: model.getLineMaxColumn(lastLine) });
      editor.revealLineInCenter(startLine);
      setReferenceNotice(`Selected lines ${startLine}-${lastLine} of ${filePath}.`);
    } else {
      setReferenceNotice(`Opened ${filePath}.`);
    }
    editor.focus();
  }

  async function markUnderstood(lessonId: string): Promise<void> {
    const id = projectId;
    if (!id) return;
    try {
      const updated = unwrap(await window.kaiDesktop.markLearningUnderstood(id, lessonId));
      if (projectIdRef.current === id) setProgress(updated);
    } catch (error) { if (projectIdRef.current === id) setLearningError(error instanceof Error ? error.message : 'Could not save understanding.'); }
  }

  async function explainBack(lessonId: string, lessonQuestion: string, answer: string): Promise<LearningExplainBackGrade | null> {
    const id = projectId;
    if (!id) return null;
    try {
      const result = unwrap(await window.kaiDesktop.explainLearningBack({ projectId: id, lessonId, question: lessonQuestion, answer }));
      if (projectIdRef.current !== id) return null;
      setProgress(result.progress);
      return result.grade;
    } catch (error) {
      if (projectIdRef.current === id) setLearningError(error instanceof Error ? error.message : 'Could not check your explanation.');
      return null;
    }
  }

  async function explainBackHelp(lessonId: string, lessonQuestion: string, kind: LearningExplainBackHelpKind): Promise<LearningExplainBackHelp | null> {
    const id = projectId;
    if (!id) return null;
    try {
      const help = unwrap(await window.kaiDesktop.explainLearningBackHelp({ projectId: id, lessonId, question: lessonQuestion, kind }));
      return projectIdRef.current === id ? help : null;
    } catch (error) {
      if (projectIdRef.current === id) setLearningError(error instanceof Error ? error.message : 'The tutor could not help with that question.');
      return null;
    }
  }

  async function runLearningCheck(): Promise<string> {
    if (!projectId) throw new Error('Open a project first.');
    const id = projectId;
    const overview = unwrap(await window.kaiDesktop.verificationOverview(id));
    const command = await promptDialog({ title: 'Run project check', label: 'Check command (runs saved files on disk)', initialValue: overview.suggestedCommand ?? '', confirmLabel: 'Run check' });
    if (!command?.trim()) return 'Check cancelled.';
    if (projectIdRef.current !== id) return 'Project changed; check cancelled.';
    const path = activeRef.current;
    const document = path ? documents.current.get(path) : undefined;
    if (path && document && normalise(document.model.getValue()) !== document.savedValue) {
      await saveDocument(path, 'manual');
      if (normalise(document.model.getValue()) !== document.savedValue) throw new Error(`Could not save ${path}. Resolve the save issue before running a check against the file on disk.`);
    }
    const run = unwrap(await window.kaiDesktop.runVerification(id, command));
    if (responseLessonId && projectIdRef.current === id) {
      const updated = unwrap(await window.kaiDesktop.recordLearningCheckEvidence({
        projectId: id,
        lessonId: responseLessonId,
        command: run.command,
        passed: run.passed,
        exitCode: run.exitCode,
        testsPassed: run.testsPassed,
        testsFailed: run.testsFailed,
      }));
      if (projectIdRef.current === id) {
        setProgress(updated);
        setLearningResult((current) => current ? { ...current, progress: updated } : current);
      }
    }
    return `${run.command}: ${run.passed ? 'Passed' : 'Failed'} (exit ${run.exitCode ?? 'unknown'})\n${run.outputTail}`;
  }

  async function runLearningAction(action: LearningAction, inline = false, stuckHint?: 1 | 2 | 3, questionOverride?: string, sourceOverride?: 'user' | 'action'): Promise<LearningEvaluationResult | null> {
    if (learningBusyRef.current) return null;
    const path = activeRef.current;
    const document = path ? documents.current.get(path) : undefined;
    const editor = editorRef.current;
    const projectOnlyRequest = learningScope !== 'active-file' && action === 'next-step';
    if (!projectId || (!projectOnlyRequest && (!path || !document || !editor))) {
      setLearningError(projectOnlyRequest ? 'Open a project before using Learning Mode.' : 'Open a file before using this Learning Mode action.');
      return null;
    }
    if (!inline) setTutorOpen(true);
    if (action === 'explain-selection' && (!editor || editor.getSelection()?.isEmpty())) {
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
    const selection = editor?.getSelection();
    const selectedText = document && selection && !selection.isEmpty() ? document.model.getValueInRange(selection).slice(0, 50_000) : undefined;
    const requestId = `learning_${crypto.randomUUID()}`;
    const requestAssistance = assistance;
    const requestQuestion = questionOverride?.trim() || question.trim() || (stuckHint ? `I'm stuck. Hint ${stuckHint} of 3, please.` : '');
    const requestSource = sourceOverride ?? (questionOverride || stuckHint || !question.trim() ? 'action' : 'user');
    const explainingAppliedSuggestion = appliedSuggestionNeedsExplanation && /^I applied the Tutor suggestion/i.test(question.trim());
    const priorTurns = learningResult?.response
      ? [...tutorConversation, { id: 'current', question: submittedQuestion.trim() || learningResult.response.title, source: submittedSource, response: learningResult.response }]
      : tutorConversation;
    const request: LearningTutorRequest = {
      requestId,
      projectId,
      ...(learningCard ? { studioCardId: learningCard.id } : {}),
      ...(path && document ? { filePath: path, documentVersion: document.version } : {}),
      ...(selection ? {
        selection: {
          startLine: selection.startLineNumber,
          startColumn: selection.startColumn,
          endLine: selection.endLineNumber,
          endColumn: selection.endColumn,
        },
      } : {}),
      ...(document ? { language: document.language } : {}),
      scope: learningScope,
      action,
      assistance: requestAssistance,
      teachingModes,
      code: !inline && document ? boundedCode(document.model.getValue(), selection?.startLineNumber ?? 1, selection?.endLineNumber ?? selection?.startLineNumber ?? 1) : '',
      ...(inline && document && editor?.getPosition() ? { completionContext: {
        prefix: document.model.getValue().slice(0, document.model.getOffsetAt(editor.getPosition()!)).slice(-6_000),
        suffix: document.model.getValue().slice(document.model.getOffsetAt(editor.getPosition()!), document.model.getOffsetAt(editor.getPosition()!) + 3_000),
      } } : {}),
      ...(selectedText ? { selectedText } : {}),
      ...(editor ? { cursorLine: editor.getPosition()?.lineNumber ?? 1 } : {}),
      ...(errorText ? { errorText } : {}),
      ...(requestQuestion ? { question: requestQuestion.slice(0, 4_000) } : {}),
      ...(!inline && priorTurns.length ? { conversationContext: tutorConversationContext(priorTurns) } : {}),
      ...(stuckHint ? { hintLevel: stuckHint } : {}),
    };
    activeLearningRequestId.current = requestId;
    learningBusyRef.current = true;
    setLearningBusy(action);
    if (!inline) {
      setPendingTutorQuestion({ requestId, text: requestQuestion || `Tutor action: ${action.replace(/-/g, ' ')}`, source: requestSource, action, ...(stuckHint ? { stuckHint } : {}), status: 'sending' });
      if (!questionOverride) setQuestion((current) => current.trim() === requestQuestion ? '' : current);
    }
    setLearningError(null);
    try {
      const result = unwrap(await window.kaiDesktop.evaluateLearning(request));
      if (activeLearningRequestId.current !== requestId || projectIdRef.current !== request.projectId) return null;
      if (action === 'complete' && !learningRequestStillCurrent(request, projectIdRef.current, activeRef.current, learningStateRef.current.assistance, learningStateRef.current.scope, editorRef.current, documents.current)) {
        setPendingTutorQuestion(null);
        return null;
      }
      if (inline) {
        if (!result.response.suggestion) setNotice('No inline suggestion for this cursor position.');
        return result;
      }
      lastLearningRequest.current = request;
      if (learningResult?.response) {
        setTutorConversation((current) => [...current, {
          id: `turn_${crypto.randomUUID()}`,
          question: submittedQuestion.trim() || learningResult.response.title,
          source: submittedSource,
          response: learningResult.response,
        }].slice(-30));
      }
      setSubmittedQuestion(request.question ?? `Tutor action: ${action.replace(/-/g, ' ')}`);
      setSubmittedSource(requestSource);
      setPendingTutorQuestion(null);
      setSuggestionPreview(null);
      setHintLevel(stuckHint ?? 0);
      setLearningResult(result);
      setResponseLessonId(result.progress.memory?.lessonId ?? null);
      setProgress(result.progress);
      void window.kaiDesktop.learningReadiness().then((state) => {
        if (state.ok && projectIdRef.current === request.projectId) setReadiness(state.data);
      }).catch(() => undefined);
      if (explainingAppliedSuggestion) setAppliedSuggestionNeedsExplanation(false);
      return result;
    } catch (caught) {
      if (activeLearningRequestId.current === requestId) {
        const message = caught instanceof Error ? caught.message : 'The tutor request failed.';
        setLearningError(message);
        if (!inline) setPendingTutorQuestion((current) => current?.status === 'sending' ? { ...current, status: 'failed', error: message } : current);
        if (inline) setNotice(`Inline suggestion: ${message}`);
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

  function cancelLearningQuestion(): void {
    const pending = pendingTutorQuestion;
    if (!pending || pending.status !== 'sending') return;
    activeLearningRequestId.current = null;
    learningBusyRef.current = false;
    setLearningBusy(null);
    setPendingTutorQuestion({ ...pending, status: 'cancelled' });
    void window.kaiDesktop.cancelLearning(pending.requestId).catch(() => undefined);
  }

  async function updatePreferences(nextAssistance: LearningAssistance, nextInline: boolean, modes: LearningAssistance[] = teachingModes): Promise<void> {
    if (!projectId) return;
    const chosen = { assistance: nextAssistance, inlineSuggestions: nextInline, teachingModes: modes };
    const revision = preferenceRevision.current + 1;
    preferenceRevision.current = revision;
    chosenPreferences.current = chosen;
    setOptimisticPreferences(chosen);
    setLearningError(null);
    setProgress((current) => current
      ? { ...current, preferences: chosen }
      : current);
    try {
      const updated = unwrap(await window.kaiDesktop.updateLearningPreferences({
        projectId,
        assistance: nextAssistance,
        inlineSuggestions: nextInline,
        teachingModes: modes,
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

  /**
   * Opens the file the tutor named and puts the code at its anchor. The anchor has to be found exactly once, which
   * is what makes this safe after the file changed; otherwise nothing is edited and the learner is told why.
   */
  async function placeSuggestionInFile(): Promise<void> {
    const suggestion = learningResult?.response.suggestion;
    const placement = suggestion?.placement;
    const originProject = projectIdRef.current;
    if (!suggestion || !placement || !originProject) return;
    if (activeRef.current !== placement.filePath) await openFile(placement.filePath);
    const editor = editorRef.current;
    const document = documents.current.get(placement.filePath);
    const monaco = monacoRef.current;
    if (projectIdRef.current !== originProject || activeRef.current !== placement.filePath || !editor || !document || !monaco) return;
    const placed = placeSuggestion(document.model.getLinesContent(), placement, suggestion.code);
    if (!placed.ok) {
      setNotice(`${placed.reason} Put your cursor where it goes and use Insert at cursor instead.`);
      return;
    }
    const { range, text, insertedLines } = placed.edit;
    const editRange = new monaco.Range(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn);
    setSuggestionPreview({ filePath: placement.filePath, range: editRange, before: document.model.getValueInRange(editRange), after: text, expectedVersion: document.model.getVersionId(), insertedLines });
  }

  function insertSuggestion(): void {
    const suggestion = learningResult?.response.suggestion;
    const editor = editorRef.current;
    const path = activeRef.current;
    const document = path ? documents.current.get(path) : undefined;
    const monaco = monacoRef.current;
    if (!suggestion || !editor || !document || !monaco) return;
    const request = lastLearningRequest.current;
    if (!request || !learningRequestStillCurrent(request, projectIdRef.current, activeRef.current, learningStateRef.current.assistance, learningStateRef.current.scope, editor, documents.current)) {
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
    setSuggestionPreview({ filePath: path!, range, before: document.model.getValueInRange(range), after: suggestion.code, expectedVersion: document.model.getVersionId() });
  }

  function applySuggestionPreview(): void {
    const preview = suggestionPreview;
    const document = preview ? documents.current.get(preview.filePath) : undefined;
    const editor = editorRef.current;
    if (!preview || !document || !editor || activeRef.current !== preview.filePath || document.model.getVersionId() !== preview.expectedVersion || document.model.getValueInRange(preview.range) !== preview.before) {
      setSuggestionPreview(null);
      setNotice('The file changed while the code preview was open. Review the suggestion again.');
      return;
    }
    document.model.pushStackElement();
    document.model.pushEditOperations([], [{ range: preview.range, text: preview.after }], () => null);
    document.model.pushStackElement();
    setLastAppliedSuggestion({ filePath: preview.filePath, version: document.model.getVersionId() });
    setSuggestionPreview(null);
    if (preview.insertedLines) {
      editor.setSelection({ startLineNumber: preview.insertedLines.start, startColumn: 1, endLineNumber: preview.insertedLines.end, endColumn: document.model.getLineMaxColumn(preview.insertedLines.end) });
      editor.revealLinesInCenter(preview.insertedLines.start, preview.insertedLines.end);
    }
    editor.focus();
    setAppliedSuggestionNeedsExplanation(true);
    setNotice(`Applied tutor code in ${preview.filePath}. You can undo it from the tutor panel; Run check saves the current file before testing it.`);
  }

  function undoAppliedSuggestion(): void {
    const applied = lastAppliedSuggestion;
    const document = applied ? documents.current.get(applied.filePath) : undefined;
    if (!applied || !document || document.model.getVersionId() !== applied.version) {
      setLastAppliedSuggestion(null);
      setNotice('The file changed after the tutor edit. Use the editor Undo command to review its history.');
      return;
    }
    document.model.undo();
    setLastAppliedSuggestion(null);
    setAppliedSuggestionNeedsExplanation(false);
    setNotice(`Undid the tutor code in ${applied.filePath}.`);
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
        ...(request.filePath ? { filePath: request.filePath } : {}),
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

  /**
   * Formats one open file in place, as a single undoable edit that keeps the cursor and scroll position. Returns a
   * short note for the save message ('' when there is nothing to say). If the learner typed while the formatter
   * ran, the result is dropped rather than overwriting what they typed.
   */
  async function formatDocument(currentProjectId: string, path: string, document: OpenDocument, reason: 'save' | 'button'): Promise<string> {
    const version = document.model.getVersionId();
    let result: CodeFormatResult;
    try {
      result = unwrap(await window.kaiDesktop.formatCode({ projectId: currentProjectId, filePath: path, content: document.model.getValue() }));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'The file could not be formatted.';
      return reason === 'save' ? `, not formatted. ${message}` : message;
    }
    if (result.skipped) {
      if (reason === 'button') {
        if (result.skipped.missingTool && /\.pyi?$/.test(path)) setOfferInstallRuff(true);
        return result.skipped.reason;
      }
      // On save, only a missing tool is worth saying, and only once per file type.
      const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
      if (!result.skipped.missingTool || missingFormatterNoted.current.has(extension)) return '';
      missingFormatterNoted.current.add(extension);
      return `, not formatted. ${result.skipped.reason}`;
    }
    if (projectIdRef.current !== currentProjectId || documents.current.get(path) !== document || document.model.getVersionId() !== version) {
      return reason === 'save' ? ', not formatted because the file changed while formatting' : 'The file changed while formatting, so it was left as it is.';
    }
    const formatter = /^[a-z]/.test(result.parser) ? `Prettier (${result.parser})` : result.parser;
    if (!result.changed) return reason === 'save' ? '' : `${path} is already formatted.`;
    const editor = editorRef.current;
    const viewState = editor && editor.getModel() === document.model ? editor.saveViewState() : null;
    document.model.pushEditOperations([], [{ range: document.model.getFullModelRange(), text: result.formatted }], () => null);
    if (viewState && editor?.getModel() === document.model) editor.restoreViewState(viewState);
    return reason === 'save' ? `, formatted with ${formatter}` : `Formatted ${path} with ${formatter}.`;
  }

  async function formatActive(): Promise<void> {
    const path = activeRef.current;
    const document = path ? documents.current.get(path) : undefined;
    const currentProjectId = projectIdRef.current;
    if (!currentProjectId || !path || !document) return;
    setFormatting(true);
    setOfferInstallRuff(false);
    setNotice(null);
    try {
      setNotice(await formatDocument(currentProjectId, path, document, 'button'));
    } finally {
      setFormatting(false);
    }
  }

  async function installRuff(): Promise<void> {
    const id = projectIdRef.current;
    if (!id || formatting) return;
    setFormatting(true);
    setNotice('Installing Ruff in KAI…');
    try {
      const installed = unwrap(await window.kaiDesktop.installCodeFormatter({ projectId: id, formatter: 'ruff' }));
      setOfferInstallRuff(false);
      setNotice(installed.message);
      if (projectIdRef.current === id) await formatActive();
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : 'Ruff could not be installed.');
    } finally {
      setFormatting(false);
    }
  }

  const root = useMemo(() => buildTree(files), [files]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? files.filter((file) => file.path.toLowerCase().includes(needle)).slice(0, 200) : null;
  }, [files, query]);

  /** One file in the tree: coloured by its Git state, with the badge, and a dot while it has unsaved edits. */
  function renderFile(path: string, label: string, depth: number): ReactNode {
    const change = gitChanges.get(path);
    return (
      <UiButton
        key={path}
        type="button"
        className={`code-tree-item ${activePath === path ? 'active' : ''} ${selectedTree?.kind === 'file' && selectedTree.path === path ? 'selected' : ''} ${change ? `git-${change.kind}` : ''}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        aria-selected={selectedTree?.kind === 'file' && selectedTree.path === path}
        onClick={() => {
          setSelectedTree({ kind: 'file', path });
          void openFile(path);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setFileMenu({ x: event.clientX, y: event.clientY, kind: 'file', path });
        }}
        title={path}
      >
        <FileIcon size={12} /><span className="truncate">{label}</span>
        {dirty[path] && <span className="code-dirty" aria-label="Unsaved changes">●</span>}
        {change && <GitBadge change={change} />}
      </UiButton>
    );
  }

  function renderNode(node: TreeNode, depth: number): ReactNode {
    return sortedChildren(node).map((child) => {
      if (child.file) {
        return renderFile(child.path, child.name, depth);
      }
      const open = expanded.has(child.path);
      const changedInside = changedInFolder.get(child.path) ?? 0;
      return (
        <div key={child.path}>
          <UiButton
            type="button"
            className={`code-tree-item folder ${selectedTree?.kind === 'folder' && selectedTree.path === child.path ? 'selected' : ''} ${changedInside > 0 ? 'has-changes' : ''}`}
            style={{ paddingLeft: 8 + depth * 12 }}
            aria-expanded={open}
            aria-selected={selectedTree?.kind === 'folder' && selectedTree.path === child.path}
            onClick={() => {
              setSelectedTree({ kind: 'folder', path: child.path });
              setExpanded((current) => {
                const next = new Set(current);
                if (open) next.delete(child.path);
                else next.add(child.path);
                return next;
              });
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setFileMenu({ x: event.clientX, y: event.clientY, kind: 'folder', path: child.path });
            }}
          >
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}<Folder size={12} /><span className="truncate">{child.name}</span>
            {changedInside > 0 && <b className="files-folder-count" title={`${changedInside} changed file${changedInside === 1 ? '' : 's'} in this folder`}>{changedInside}</b>}
          </UiButton>
          {open && renderNode(child, depth + 1)}
        </div>
      );
    });
  }

  /** What a right-click on a file, folder or the tree background offers. */
  function fileMenuItems(): ContextMenuItem[] {
    if (!fileMenu || !projectId) return [];
    const target = fileMenu;
    const items: ContextMenuItem[] = [];
    const parent = target.kind === 'folder' ? target.path : target.path.split('/').slice(0, -1).join('/');
    if (target.kind === 'root') {
      items.push({ label: 'New file', icon: <FilePlus size={13} />, onSelect: () => void createFile('') });
      items.push({ label: 'New folder', icon: <FolderPlus size={13} />, onSelect: () => void createFolder('') });
      items.push({ label: '', separator: true, onSelect: () => undefined });
      items.push({ label: 'Refresh', icon: <RefreshCw size={13} />, onSelect: () => { void loadTree(); void refreshGitChanges(); } });
      return items;
    }
    if (target.kind === 'file') {
      items.push({ label: 'Open', icon: <FileIcon size={13} />, onSelect: () => void openFile(target.path) });
      if (openPaths.includes(target.path)) {
        items.push({ label: 'Close tab', icon: <X size={13} />, onSelect: () => void closeFile(target.path) });
        if (openPaths.length > 1) {
          items.push({
            label: 'Close other tabs',
            icon: <X size={13} />,
            onSelect: () => { for (const open of openPaths.filter((path) => path !== target.path)) void closeFile(open); },
          });
        }
      }
    }
    items.push({ label: 'New file', icon: <FilePlus size={13} />, onSelect: () => void createFile(parent) });
    items.push({ label: 'New folder', icon: <FolderPlus size={13} />, onSelect: () => void createFolder(parent) });
    items.push({ label: '', separator: true, onSelect: () => undefined });
    const kind: 'file' | 'folder' = target.kind === 'folder' ? 'folder' : 'file';
    items.push({ label: 'Rename', icon: <Pencil size={13} />, onSelect: () => void renameTarget({ kind, path: target.path }) });
    items.push({ label: 'Delete', icon: <Trash2 size={13} />, danger: true, onSelect: () => void deleteTarget({ kind, path: target.path }) });
    items.push({ label: '', separator: true, onSelect: () => undefined });
    items.push({ label: 'Copy relative path', icon: <Copy size={13} />, onSelect: () => void navigator.clipboard?.writeText(target.path) });
    const rootPath = activeProject?.path.replace(/[\\/]+$/, '') ?? '';
    items.push({ label: 'Copy absolute path', icon: <Copy size={13} />, onSelect: () => void navigator.clipboard?.writeText(rootPath ? `${rootPath}/${target.path}` : target.path) });
    items.push({ label: 'Reveal in Explorer', icon: <ExternalLink size={13} />, onSelect: () => void window.kaiDesktop.revealProjectPath({ projectId, path: target.path }) });
    return items;
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
          <label className="input-with-icon"><Search size={13} /><UiTextInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search files" aria-label="Search files" /></label>
          <UiButton type="button" className="icon-button compact" title="New file" aria-label="New file" onClick={() => void createFile()}><FilePlus size={14} /></UiButton>
          <UiButton type="button" className="icon-button compact" title="Refresh files" aria-label="Refresh files" onClick={() => { void loadTree(); void refreshGitChanges(); }}><RefreshCw size={14} /></UiButton>
        </div>
        <div
          className="code-tree"
          tabIndex={0}
          onKeyDown={(event) => {
            if (!selectedTree) return;
            if (event.key === 'Delete') {
              event.preventDefault();
              void deleteTarget(selectedTree);
            } else if (event.key === 'F2') {
              event.preventDefault();
              void renameTarget(selectedTree);
            }
          }}
          onContextMenu={(event) => {
            if ((event.target as HTMLElement).closest('.code-tree-item')) return;
            event.preventDefault();
            setFileMenu({ x: event.clientX, y: event.clientY, kind: 'root', path: '' });
          }}
        >
          {filtered
            ? filtered.map((file) => renderFile(file.path, file.path, 0))
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
            <div
              key={path}
              className={`code-tab ${activePath === path ? 'active' : ''}`}
              role="tab"
              aria-selected={activePath === path}
              onContextMenu={(event) => {
                event.preventDefault();
                setFileMenu({ x: event.clientX, y: event.clientY, kind: 'file', path });
              }}
            >
              <UiButton type="button" className="code-tab-name" onClick={() => void openFile(path)}><span className="truncate">{path.split('/').at(-1)}</span>{dirty[path] && <span className="code-dirty">●</span>}</UiButton>
              <UiButton type="button" className="icon-button compact" aria-label={`Close ${path}`} onClick={() => void closeFile(path)}><X size={11} /></UiButton>
            </div>
          ))}
          <span className="code-tabs-spacer" />
          {autoSave && activePath && dirty[activePath] && <span className="code-autosave-status" role="status">Autosave on</span>}
          <UiButton type="button" className={`icon-button compact ${tutorOpen ? 'active' : ''}`} title={tutorOpen ? 'Hide learning tutor' : 'Show learning tutor'} aria-label={tutorOpen ? 'Hide learning tutor' : 'Show learning tutor'} onClick={() => setTutorOpen((current) => !current)}><PanelRightOpen size={14} /></UiButton>
          <UiButton type="button" className="secondary-button" title={formatOnSave ? 'Format this file now (saving with Ctrl+S also formats it)' : 'Format this file now'} disabled={!activePath || formatting} onClick={() => void formatActive()}>
            {formatting ? <RefreshCw size={13} className="spin" /> : <Braces size={13} />}<span>Format</span>
          </UiButton>
          <UiButton type="button" className="secondary-button" disabled={!activePath || !dirty[activePath]} onClick={() => void saveActive()}><Save size={13} /><span>Save</span></UiButton>
        </div>
        {/* Above the editor rather than only behind a panel tab: what to do next is worth seeing while typing, and a
            guide you have to go and open is one you will not read. It is not tied to the tutor being open, for the
            same reason — the moment it is most useful is the moment the panel is closed. */}
        {!guideStripHidden && <CodeGuideStrip
          view={codeGuide}
          busy={guideBusy}
          onAction={(action) => void runCodeGuideAction(action)}
          onOpen={() => openSidePanel('guide')}
          onDismiss={() => toggleGuideStrip(true)}
        />}
        {diskChanged && (
          <div className="workbench-notice usage-banner warning" role="alert">
            <span>{diskChanged} changed on disk after you opened it{dirty[diskChanged] ? ' and you have unsaved edits' : ''}.</span>
            <span className="code-banner-actions">
              <UiButton type="button" className="secondary-button" onClick={() => void refreshFromDisk(false)}>Reload from disk</UiButton>
              {dirty[diskChanged] && <UiButton type="button" className="secondary-button" onClick={() => void refreshFromDisk(true)}>Keep my version</UiButton>}
            </span>
          </div>
        )}
        {notice && <div className="workbench-notice" role="status"><span>{notice}</span>{!editorReady && <UiButton type="button" className="secondary-button" onClick={retryEditor} title="Load the code editor again">{editorError ? 'Try again' : 'Start the editor again'}</UiButton>}{offerInstallRuff && <UiButton type="button" className="secondary-button" disabled={formatting} onClick={() => void installRuff()}>{formatting ? 'Installing…' : 'Install Ruff'}</UiButton>}<UiButton type="button" className="icon-button compact" aria-label="Dismiss" onClick={() => { setNotice(null); setOfferInstallRuff(false); }}><X size={12} /></UiButton></div>}
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
          {/* One grid cell holds the tabs and whichever panel is showing; separate children would each take a cell. */}
          <div className="code-side-panel">
          <div className="code-side-panel-tabs" role="tablist" aria-label="Code assistance">
            <UiButton type="button" role="tab" aria-selected={sidePanel === 'learn'} className={sidePanel === 'learn' ? 'active' : ''} onClick={() => openSidePanel('learn')}>Learn</UiButton>
            <UiButton type="button" role="tab" aria-selected={sidePanel === 'review'} className={sidePanel === 'review' ? 'active' : ''} onClick={() => openSidePanel('review')}>Review</UiButton>
            <UiButton type="button" role="tab" aria-selected={sidePanel === 'guide'} className={sidePanel === 'guide' ? 'active' : ''} onClick={() => openSidePanel('guide')}>Senior dev</UiButton>
          </div>
          {sidePanel === 'guide' ? <CodeGuidePanel
            view={codeGuide}
            explaining={guideExplaining}
            busy={guideBusy}
            error={guideError}
            onExplain={() => void explainCodeGuide()}
            onAction={(action) => void runCodeGuideAction(action)}
            stripHidden={guideStripHidden}
            onToggleStrip={() => toggleGuideStrip(!guideStripHidden)}
          /> : sidePanel === 'review' ? <GuidedReviewPanel
            projectId={activeProject.id}
            changes={reviewChanges}
            activePath={activePath}
            hasSelection={Boolean(learningSelection?.text.trim())}
            onOpenFile={async (path) => { await openFile(path); }}
            onExplainFile={async (path) => { await openFile(path); setSidePanel('learn'); setTutorOpen(true); await runLearningAction('explain-file'); }}
            onCreateFollowup={onCreateReviewFollowup}
            onOpenAt={(filePath, line) => void openLearningReference(filePath, line, line)}
            onOpenSettings={onOpenSettings}
          /> : <LearningPanel
            key={projectId}
            projectFiles={files.map((file) => file.path)}
            onReference={(filePath, startLine, endLine) => void openLearningReference(filePath, startLine, endLine)}
            referenceNotice={referenceNotice}
            responseLessonId={responseLessonId}
            onLessonSelect={(lesson) => {
              // The lesson already on screen is not reopened a second time.
              if (!progress || lesson.id === responseLessonId) return;
              lastLearningRequest.current = null;
              // The answer on screen joins the conversation above before the chosen lesson replaces it.
              if (learningResult?.response) {
                const shown = learningResult.response;
                setTutorConversation((current) => [...current, {
                  id: `turn_${crypto.randomUUID()}`,
                  question: submittedQuestion.trim() || shown.title,
                  source: submittedSource,
                  response: shown,
                }].slice(-30));
              }
              setSubmittedQuestion(`Reopened lesson: ${lesson.response.title}`);
              setSubmittedSource('action');
              setLearningResult({ response: lesson.response, progress });
              setResponseLessonId(lesson.id);
            }}
            onUnderstood={(lessonId) => void markUnderstood(lessonId)}
            onExplainBack={explainBack}
            onContinueLesson={(lessonQuestion) => void runLearningAction('next-step', false, undefined,
              `${projectLessons(files.map((file) => file.path), progress)[0]?.prompt ?? 'Find the next unfinished coding step in this project.'} I completed the lesson about "${lessonQuestion}". Do not repeat that lesson or question.`)}
            onStartLesson={(prompt) => void runLearningAction('next-step', false, undefined, prompt)}
            onExplainBackHelp={explainBackHelp}
            onRunCheck={runLearningCheck}
            projectName={activeProject?.name ?? null}
            progress={progress && optimisticPreferences ? { ...progress, preferences: optimisticPreferences } : progress}
            readiness={readiness}
            result={learningResult}
            scope={learningScope}
            card={learningCard}
            onClearCard={() => setLearningCard(null)}
            selection={learningSelection}
            gitInfo={gitInfo}
            busy={learningBusy}
            error={learningError}
            question={question}
            submittedQuestion={submittedQuestion}
            submittedSource={submittedSource}
            pendingQuestion={pendingTutorQuestion}
            onRetryQuestion={() => {
              if (pendingTutorQuestion) void runLearningAction(pendingTutorQuestion.action, false, pendingTutorQuestion.stuckHint, pendingTutorQuestion.text, pendingTutorQuestion.source);
            }}
            onCancelQuestion={cancelLearningQuestion}
            conversation={tutorConversation}
            onQuestionChange={setQuestion}
            onAction={(action) => void runLearningAction(action)}
            onScopeChange={(nextScope) => {
              setLearningScope(nextScope);
              try {
                window.localStorage.setItem('kai.learningTutorScope', nextScope);
              } catch {
                // A remembered tutor scope is a convenience only.
              }
            }}
            onPreferences={(nextAssistance, nextInline, modes) => void updatePreferences(nextAssistance, nextInline, modes)}
            onInsertSuggestion={insertSuggestion}
            onPlaceSuggestion={() => void placeSuggestionInFile()}
            suggestionPreview={suggestionPreview && { filePath: suggestionPreview.filePath, before: suggestionPreview.before, after: suggestionPreview.after }}
            onApplySuggestion={applySuggestionPreview}
            onCancelSuggestion={() => setSuggestionPreview(null)}
            canUndoSuggestion={Boolean(lastAppliedSuggestion)}
            onUndoSuggestion={undoAppliedSuggestion}
            appliedSuggestionNeedsExplanation={appliedSuggestionNeedsExplanation}
            onExplainAppliedSuggestion={() => {
              setQuestion('I applied the Tutor suggestion. I think it works because ');
              setTutorOpen(true);
            }}
            onStuck={() => void runLearningAction('next-step', false, Math.min(3, hintLevel + 1) as 1 | 2 | 3)}
            onShowCode={() => void runLearningAction('next-step', false, 3)}
            hintLevel={hintLevel}
            onRecordLesson={lastLearningRequest.current ? () => void recordLesson() : undefined}
            teachingLibrary={teachingLibrary}
            teachingBusy={teachingBusy}
            onSaveTeachingEntry={saveTeachingEntry}
            onDeleteTeachingEntry={deleteTeachingEntry}
            onResetTeachingEntry={resetTeachingEntry}
            onGenerateTeachingDraft={generateTeachingDraft}
            onOpenSettings={onOpenSettings}
            onClose={() => setTutorOpen(false)}
          />}
          </div>
        </>
      )}
      {fileMenu && <ContextMenu x={fileMenu.x} y={fileMenu.y} items={fileMenuItems()} onClose={() => setFileMenu(null)} />}
    </div>
  );
}

function learningState(
  projectId: string | null,
  filePath: string | null,
  assistance: LearningAssistance,
  scope: LearningTutorScope,
  inlineSuggestions: boolean,
): { projectId: string; filePath: string; assistance: LearningAssistance; scope: LearningTutorScope; inlineSuggestions: boolean } | null {
  return projectId && filePath ? { projectId, filePath, assistance, scope, inlineSuggestions } : null;
}

interface SavedTutorSession {
  turns: TutorConversationTurn[];
  submittedQuestion: string;
  submittedSource?: 'user' | 'action';
  current?: TutorConversationTurn['response'];
  progress?: LearningEvaluationResult['progress'];
}

const TUTOR_SESSION_TURNS = 12;
const tutorSessionKey = (projectId: string): string => `kai.tutorSession.${projectId}`;

/** The Tutor conversation survives a reload or a brief project refresh; losing it is only an inconvenience. */
function readTutorSession(projectId: string): SavedTutorSession | null {
  try {
    const raw = window.localStorage.getItem(tutorSessionKey(projectId));
    const parsed = raw ? JSON.parse(raw) as SavedTutorSession : null;
    return parsed && Array.isArray(parsed.turns) ? parsed : null;
  } catch {
    return null;
  }
}

function writeTutorSession(projectId: string, session: SavedTutorSession): void {
  try {
    const trimmed = { ...session, turns: session.turns.slice(-TUTOR_SESSION_TURNS) };
    if (!trimmed.turns.length && !trimmed.current) window.localStorage.removeItem(tutorSessionKey(projectId));
    else window.localStorage.setItem(tutorSessionKey(projectId), JSON.stringify(trimmed));
  } catch {
    // Storage full or blocked: the conversation still works for this session.
  }
}

function tutorConversationContext(turns: TutorConversationTurn[]): string {
  const context = turns.slice(-6).map((turn) => [
    `Learner: ${turn.question}`,
    `Tutor: ${[turn.response.recap, turn.response.purpose, turn.response.steps[0]?.explanation].filter(Boolean).join(' ')}`,
  ].join('\n')).join('\n\n');
  return context.slice(-16_000);
}

function learningRequestStillCurrent(
  request: LearningTutorRequest,
  projectId: string | null,
  activePath: string | null,
  assistance: LearningAssistance,
  scope: LearningTutorScope,
  editor: Monaco.editor.IStandaloneCodeEditor | null,
  documents: ReadonlyMap<string, OpenDocument>,
): boolean {
  if (projectId !== request.projectId) return false;
  if ((activePath ?? undefined) !== request.filePath || assistance !== request.assistance || scope !== (request.scope ?? 'project')) return false;
  if (!request.filePath) return true;
  const document = documents.get(request.filePath);
  if (!document || (request.documentVersion !== undefined && document.version !== request.documentVersion)) return false;
  if (!request.selection) return true;
  const selection = editor?.getSelection();
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
