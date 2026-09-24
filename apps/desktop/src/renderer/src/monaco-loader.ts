import type * as Monaco from 'monaco-editor';

let loading: Promise<typeof Monaco> | null = null;

/**
 * Loads Monaco and its workers the first time an editor is needed. Importing `editor.api` and an
 * explicit language/feature set avoids Monaco's editor.main entry point, which eagerly registers
 * every bundled language and makes the editor chunk several megabytes larger than KAI needs.
 */
export function loadMonaco(): Promise<typeof Monaco> {
  loading ??= (async () => {
    const [monaco, editorWorker, jsonWorker, cssWorker, htmlWorker, tsWorker] = await Promise.all([
      import('monaco-editor/editor/editor.api'),
      import('monaco-worker/editor/editor.worker.js?worker'),
      import('monaco-worker/language/json/json.worker.js?worker'),
      import('monaco-worker/language/css/css.worker.js?worker'),
      import('monaco-worker/language/html/html.worker.js?worker'),
      import('monaco-worker/language/typescript/ts.worker.js?worker'),
      // Editor contributions used by the supported editing and navigation commands.
      import('monaco-editor/editor/contrib/anchorSelect/browser/anchorSelect'),
      import('monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching'),
      import('monaco-editor/editor/contrib/caretOperations/browser/transpose'),
      import('monaco-editor/editor/contrib/clipboard/browser/clipboard'),
      import('monaco-editor/editor/contrib/codeAction/browser/codeActionContributions'),
      import('monaco-editor/editor/browser/widget/codeEditor/codeEditorWidget'),
      import('monaco-editor/editor/contrib/codelens/browser/codelensController'),
      import('monaco-editor/editor/contrib/colorPicker/browser/colorPickerContribution'),
      import('monaco-editor/editor/contrib/comment/browser/comment'),
      import('monaco-editor/editor/contrib/contextmenu/browser/contextmenu'),
      import('monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo'),
      import('monaco-editor/editor/browser/widget/diffEditor/diffEditor.contribution'),
      import('monaco-editor/editor/contrib/dnd/browser/dnd'),
      import('monaco-editor/editor/contrib/documentSymbols/browser/documentSymbols'),
      import('monaco-editor/editor/contrib/dropOrPasteInto/browser/dropIntoEditorContribution'),
      import('monaco-editor/features/find/register'),
      import('monaco-editor/editor/contrib/floatingMenu/browser/floatingMenu.contribution'),
      import('monaco-editor/editor/contrib/folding/browser/folding'),
      import('monaco-editor/editor/contrib/fontZoom/browser/fontZoom'),
      import('monaco-editor/editor/contrib/format/browser/formatActions'),
      import('monaco-editor/editor/contrib/gotoError/browser/gotoError'),
      import('monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess'),
      import('monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition'),
      import('monaco-editor/editor/contrib/gpu/browser/gpuActions'),
      import('monaco-editor/editor/contrib/hover/browser/hoverContribution'),
      import('monaco-editor/editor/contrib/indentation/browser/indentation'),
      import('monaco-editor/editor/contrib/inlayHints/browser/inlayHintsContribution'),
      import('monaco-editor/editor/contrib/inlineCompletions/browser/inlineCompletions.contribution'),
      import('monaco-editor/editor/contrib/inlineProgress/browser/inlineProgress'),
      import('monaco-editor/editor/contrib/inPlaceReplace/browser/inPlaceReplace'),
      import('monaco-editor/editor/contrib/insertFinalNewLine/browser/insertFinalNewLine'),
      import('monaco-editor/editor/standalone/browser/inspectTokens/inspectTokens'),
      import('monaco-editor/editor/standalone/browser/iPadShowKeyboard/iPadShowKeyboard'),
      import('monaco-editor/editor/contrib/lineSelection/browser/lineSelection'),
      import('monaco-editor/editor/contrib/linesOperations/browser/linesOperations'),
      import('monaco-editor/editor/contrib/linkedEditing/browser/linkedEditing'),
      import('monaco-editor/editor/contrib/links/browser/links'),
      import('monaco-editor/editor/contrib/longLinesHelper/browser/longLinesHelper'),
      import('monaco-editor/editor/contrib/middleScroll/browser/middleScroll.contribution'),
      import('monaco-editor/editor/contrib/multicursor/browser/multicursor'),
      import('monaco-editor/editor/contrib/parameterHints/browser/parameterHints'),
      import('monaco-editor/editor/contrib/placeholderText/browser/placeholderText.contribution'),
      import('monaco-editor/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess'),
      import('monaco-editor/editor/standalone/browser/quickAccess/standaloneHelpQuickAccess'),
      import('monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoSymbolQuickAccess'),
      import('monaco-editor/editor/contrib/readOnlyMessage/browser/contribution'),
      import('monaco-editor/editor/standalone/browser/referenceSearch/standaloneReferenceSearch'),
      import('monaco-editor/editor/contrib/rename/browser/rename'),
      import('monaco-editor/editor/contrib/sectionHeaders/browser/sectionHeaders'),
      import('monaco-editor/editor/contrib/semanticTokens/browser/viewportSemanticTokens'),
      import('monaco-editor/editor/contrib/smartSelect/browser/smartSelect'),
      import('monaco-editor/editor/contrib/snippet/browser/snippetController2'),
      import('monaco-editor/editor/contrib/stickyScroll/browser/stickyScrollContribution'),
      import('monaco-editor/editor/contrib/suggest/browser/suggestInlineCompletions'),
      import('monaco-editor/editor/standalone/browser/toggleHighContrast/toggleHighContrast'),
      import('monaco-editor/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode'),
      import('monaco-editor/editor/contrib/tokenization/browser/tokenization'),
      import('monaco-editor/editor/contrib/unicodeHighlighter/browser/unicodeHighlighter'),
      import('monaco-editor/editor/contrib/unusualLineTerminators/browser/unusualLineTerminators'),
      import('monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter'),
      import('monaco-editor/editor/contrib/wordOperations/browser/wordOperations'),
      import('monaco-editor/editor/contrib/wordPartOperations/browser/wordPartOperations'),
      import('monaco-editor/editor/browser/coreCommands'),
      import('monaco-editor/editor/contrib/caretOperations/browser/caretOperations'),
      import('monaco-editor/editor/contrib/dropOrPasteInto/browser/copyPasteContribution'),
      import('monaco-editor/editor/contrib/find/browser/findController'),
      import('monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands'),
      import('monaco-editor/editor/contrib/gotoError/browser/markerSelectionStatus'),
      import('monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens'),
      import('monaco-editor/editor/contrib/suggest/browser/suggestController'),
      import('monaco-editor/editor/common/standaloneStrings'),
      // Language grammars and language services used by KAI's file-type map.
      import('monaco-editor/languages/definitions/cpp/register'),
      import('monaco-editor/languages/definitions/csharp/register'),
      import('monaco-editor/languages/definitions/css/register'),
      import('monaco-editor/languages/definitions/dockerfile/register'),
      import('monaco-editor/languages/definitions/go/register'),
      import('monaco-editor/languages/definitions/html/register'),
      import('monaco-editor/languages/definitions/ini/register'),
      import('monaco-editor/languages/definitions/java/register'),
      import('monaco-editor/languages/definitions/javascript/register'),
      import('monaco-editor/languages/definitions/kotlin/register'),
      import('monaco-editor/languages/definitions/less/register'),
      import('monaco-editor/languages/definitions/markdown/register'),
      import('monaco-editor/languages/definitions/php/register'),
      import('monaco-editor/languages/definitions/powershell/register'),
      import('monaco-editor/languages/definitions/python/register'),
      import('monaco-editor/languages/definitions/ruby/register'),
      import('monaco-editor/languages/definitions/rust/register'),
      import('monaco-editor/languages/definitions/scss/register'),
      import('monaco-editor/languages/definitions/shell/register'),
      import('monaco-editor/languages/definitions/sql/register'),
      import('monaco-editor/languages/definitions/swift/register'),
      import('monaco-editor/languages/definitions/typescript/register'),
      import('monaco-editor/languages/definitions/xml/register'),
      import('monaco-editor/languages/definitions/yaml/register'),
      import('monaco-editor/languages/features/css/register'),
      import('monaco-editor/languages/features/html/register'),
      import('monaco-editor/languages/features/json/register'),
      import('monaco-editor/languages/features/typescript/register'),
    ]);
    self.MonacoEnvironment = {
      getWorker(_workerId: string, label: string): Worker {
        if (label === 'json') return new jsonWorker.default();
        if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker.default();
        if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker.default();
        if (label === 'typescript' || label === 'javascript') return new tsWorker.default();
        return new editorWorker.default();
      },
    };
    monaco.editor.defineTheme('kai-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: { 'editor.background': '#091625', 'editorGutter.background': '#091625' },
    });
    monaco.editor.defineTheme('kai-navy', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: { 'editor.background': '#0c1738', 'editorGutter.background': '#0c1738', 'editor.lineHighlightBackground': '#15224b' },
    });
    // Colours follow the "Shades of Purple (Super Dark)" VS Code theme.
    monaco.editor.defineTheme('kai-purple', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: 'b362ff', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'ff9d00' },
        { token: 'string', foreground: 'a5ff90' },
        { token: 'number', foreground: 'ff628c' },
        { token: 'type', foreground: '80ffbb' },
        { token: 'identifier', foreground: 'ffffff' },
      ],
      colors: {
        'editor.background': '#191830',
        'editorGutter.background': '#191830',
        'editor.foreground': '#ffffff',
        'editor.lineHighlightBackground': '#1f1e3d',
        'editor.selectionBackground': '#5706a2aa',
        'editorLineNumber.foreground': '#a599e9',
        'editorCursor.foreground': '#fad000',
      },
    });
    monaco.editor.defineTheme('kai-light', {
      base: 'vs',
      inherit: true,
      rules: [],
      colors: { 'editor.background': '#ffffff' },
    });
    // The app has no project-wide TypeScript context, so semantic errors would only be noise.
    const { javascriptDefaults, typescriptDefaults } = await import('monaco-editor/languages/features/typescript/register');
    typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
    javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
    return monaco as unknown as typeof Monaco;
  })();
  return loading;
}

export function monacoThemeName(): 'kai-dark' | 'kai-navy' | 'kai-purple' | 'kai-light' {
  const theme = document.documentElement.dataset.theme;
  return theme === 'light' ? 'kai-light' : theme === 'navy' ? 'kai-navy' : theme === 'purple' ? 'kai-purple' : 'kai-dark';
}
