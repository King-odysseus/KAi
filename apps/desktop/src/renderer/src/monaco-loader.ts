import type * as Monaco from 'monaco-editor';

let loading: Promise<typeof Monaco> | null = null;

/** Loads Monaco and its workers the first time an editor is needed, so startup stays fast. */
export function loadMonaco(): Promise<typeof Monaco> {
  loading ??= (async () => {
    const [monaco, editorWorker, jsonWorker, cssWorker, htmlWorker, tsWorker] = await Promise.all([
      import('monaco-editor'),
      import('monaco-worker/editor/editor.worker.js?worker'),
      import('monaco-worker/language/json/json.worker.js?worker'),
      import('monaco-worker/language/css/css.worker.js?worker'),
      import('monaco-worker/language/html/html.worker.js?worker'),
      import('monaco-worker/language/typescript/ts.worker.js?worker'),
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
    monaco.typescript.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
    monaco.typescript.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
    return monaco;
  })();
  return loading;
}

export function monacoThemeName(): 'kai-dark' | 'kai-navy' | 'kai-purple' | 'kai-light' {
  const theme = document.documentElement.dataset.theme;
  return theme === 'light' ? 'kai-light' : theme === 'navy' ? 'kai-navy' : theme === 'purple' ? 'kai-purple' : 'kai-dark';
}
