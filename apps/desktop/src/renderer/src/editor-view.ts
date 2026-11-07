// What the code editor looks like and the VS Code-style helpers on top of it: bracket colours, guides, sticky scroll,
// Error Lens, Todo highlighting and inline Git blame. The options are a pure function of the saved settings, so the
// Settings page and the editor cannot disagree about what a switch means.
import type * as Monaco from 'monaco-editor';
import type { AppSettings } from '@kai/contracts';

export type EditorView = AppSettings['editor'];

/** The font stack. Cascadia Code ships with Windows 11 and has the ligatures; the rest are common developer fonts. */
const CODE_FONTS = "'Cascadia Code', 'Cascadia Mono', 'Fira Code', 'JetBrains Mono', Consolas, 'Courier New', monospace";

export function editorViewOptions(view: EditorView): Monaco.editor.IEditorOptions {
  const guides = view.guides;
  return {
    fontFamily: CODE_FONTS,
    fontLigatures: view.ligatures,
    minimap: { enabled: view.minimap },
    wordWrap: view.wordWrap ? 'on' : 'off',
    smoothScrolling: view.smoothScrolling,
    cursorSmoothCaretAnimation: view.smoothScrolling ? 'on' : 'off',
    cursorBlinking: view.smoothScrolling ? 'smooth' : 'blink',
    bracketPairColorization: { enabled: view.bracketColors, independentColorPoolPerBracketType: true },
    matchBrackets: 'always',
    guides: {
      indentation: guides,
      highlightActiveIndentation: guides,
      bracketPairs: guides ? 'active' : false,
      bracketPairsHorizontal: guides ? 'active' : false,
      highlightActiveBracketPair: guides,
    },
    stickyScroll: { enabled: view.stickyScroll },
    colorDecorators: view.colorSwatches,
    linkedEditing: view.linkedTagEditing,
    inlayHints: { enabled: view.inlayHints ? 'on' : 'off' },
  };
}

// ---------------------------------------------------------------------------------------------------------------

/** Words an editor treats as a to-do marker when they follow a comment opener. */
const TODO_PATTERN = '(?://|#|/\*|\*|<!--|--|;)\s*(TODO|FIXME|HACK|XXX|BUG|NOTE)\b[^\n]*';

export interface ChangeHunk { start: number; count: number; kind: 'added' | 'modified' | 'deleted' }

export interface BlameLine { commit?: string; author: string; time: number; summary: string }

/** "3 days ago" style age, from seconds since the epoch. */
export function relativeAge(epochSeconds: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round(now / 1000 - epochSeconds));
  const units: Array<[string, number]> = [['year', 31_536_000], ['month', 2_592_000], ['day', 86_400], ['hour', 3_600], ['minute', 60]];
  for (const [name, size] of units) {
    if (seconds >= size) {
      const count = Math.floor(seconds / size);
      return `${count} ${name}${count === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

/** The faint text GitLens-style blame shows at the end of the current line. */
export function blameLabel(line: BlameLine | undefined, now = Date.now()): string | null {
  if (!line) return null;
  if (!line.commit) return 'Not committed yet';
  return `${line.author}, ${relativeAge(line.time, now)} • ${line.summary}`;
}

const cap = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export interface EditorExtras {
  /** Turn each helper on or off to match the settings. */
  setView(view: EditorView): void;
  /** Lines that differ from the last commit, for the change bars; null clears them. */
  setChanges(hunks: readonly ChangeHunk[] | null): void;
  /** The blame for the file now in the editor, or null when there is none (an untracked file, no repository). */
  setBlame(lines: readonly BlameLine[] | null): void;
  dispose(): void;
}

/** Wires the helpers that Monaco does not ship, as decorations. Nothing here edits the document. */
export function createEditorExtras(monaco: typeof Monaco, editor: Monaco.editor.IStandaloneCodeEditor, initial: EditorView): EditorExtras {
  let view = initial;
  let blame: readonly BlameLine[] | null = null;
  let blameVersion = -1;
  const lens = editor.createDecorationsCollection();
  const todos = editor.createDecorationsCollection();
  const blameMark = editor.createDecorationsCollection();
  const bars = editor.createDecorationsCollection();
  let hunks: readonly ChangeHunk[] | null = null;
  let todoTimer: ReturnType<typeof setTimeout> | undefined;

  function paintLens(): void {
    const model = editor.getModel();
    if (!model || !view.errorLens) return void lens.clear();
    const worst = new Map<number, Monaco.editor.IMarker>();
    for (const marker of monaco.editor.getModelMarkers({ resource: model.uri })) {
      if (marker.severity < monaco.MarkerSeverity.Warning) continue;
      const known = worst.get(marker.startLineNumber);
      if (!known || marker.severity > known.severity) worst.set(marker.startLineNumber, marker);
    }
    lens.set([...worst.entries()].map(([line, marker]) => {
      const kind = marker.severity >= monaco.MarkerSeverity.Error ? 'error' : 'warning';
      return {
        range: new monaco.Range(line, 1, line, model.getLineMaxColumn(line)),
        options: {
          isWholeLine: true,
          className: `kai-lens-line kai-lens-${kind}`,
          after: { content: `  ${cap(marker.message.replace(/\s+/g, ' '), 160)}`, inlineClassName: `kai-lens-text kai-lens-text-${kind}` },
        },
      };
    }));
  }

  function paintTodos(): void {
    const model = editor.getModel();
    if (!model || !view.todoHighlight) return void todos.clear();
    const found = model.findMatches(TODO_PATTERN, true, true, true, null, true, 500);
    todos.set(found.map((match) => ({
      range: match.range,
      options: { inlineClassName: `kai-todo kai-todo-${(match.matches?.[1] ?? 'TODO').toLowerCase()}` },
    })));
  }

  function paintBars(): void {
    const model = editor.getModel();
    if (!model || !view.changeBars || !hunks) return void bars.clear();
    const last = model.getLineCount();
    bars.set(hunks.map((hunk) => {
      const start = Math.min(Math.max(1, hunk.start), last);
      const end = hunk.kind === 'deleted' ? start : Math.min(last, start + Math.max(1, hunk.count) - 1);
      return { range: new monaco.Range(start, 1, end, 1), options: { isWholeLine: true, linesDecorationsClassName: `kai-bar kai-bar-${hunk.kind}` } };
    }));
  }

  function paintBlame(): void {
    const model = editor.getModel();
    const position = editor.getPosition();
    if (!model || !position || !view.gitBlame || !blame || model.getAlternativeVersionId() !== blameVersion) return void blameMark.clear();
    const label = blameLabel(blame[position.lineNumber - 1]);
    if (!label) return void blameMark.clear();
    blameMark.set([{
      range: new monaco.Range(position.lineNumber, model.getLineMaxColumn(position.lineNumber), position.lineNumber, model.getLineMaxColumn(position.lineNumber)),
      options: { after: { content: `    ${cap(label, 140)}`, inlineClassName: 'kai-blame' } },
    }]);
  }

  const disposables: Monaco.IDisposable[] = [
    monaco.editor.onDidChangeMarkers((uris) => {
      const model = editor.getModel();
      if (model && uris.some((uri) => uri.toString() === model.uri.toString())) paintLens();
    }),
    editor.onDidChangeModel(() => { blame = null; hunks = null; paintBars(); paintLens(); paintTodos(); paintBlame(); }),
    editor.onDidChangeModelContent(() => {
      clearTimeout(todoTimer);
      todoTimer = setTimeout(paintTodos, 250);
      paintBlame();
    }),
    editor.onDidChangeCursorPosition(paintBlame),
  ];

  return {
    setView(next) { view = next; paintBars(); paintLens(); paintTodos(); paintBlame(); },
    setChanges(next) { hunks = next; paintBars(); },
    setBlame(lines) {
      blame = lines;
      blameVersion = editor.getModel()?.getAlternativeVersionId() ?? -1;
      paintBlame();
    },
    dispose() {
      clearTimeout(todoTimer);
      for (const item of disposables) item.dispose();
      lens.clear(); todos.clear(); blameMark.clear(); bars.clear();
    },
  };
}
