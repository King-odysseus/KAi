import {
  AlertTriangle,
  AppWindow,
  CheckCircle2,
  ExternalLink,
  Globe2,
  LoaderCircle,
  MousePointerClick,
  Play,
  RefreshCw,
  Send,
  Square,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { PreviewInfo, PreviewState, ProjectRecord } from '@kai/contracts';
import { relativeTime, unwrap } from '../types';

interface PreviewElementSelection {
  selector: string;
  tagName: string;
  text: string;
  html: string;
  url: string;
}

interface BrowserIssue {
  id: string;
  level: 'warning' | 'error';
  message: string;
  source: string;
  line: number;
  timestamp: string;
}

interface WebviewElement extends HTMLElement {
  src: string;
  reload(): void;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

type PreviewInspectorTab = 'selection' | 'issues' | 'logs';

export function PreviewView({ activeProject, onRequestChange, onClose }: {
  activeProject: ProjectRecord | null;
  onRequestChange: (prompt: string) => void;
  onClose: () => void;
}): ReactNode {
  const [info, setInfo] = useState<PreviewInfo | null>(null);
  const [state, setState] = useState<PreviewState | null>(null);
  const [command, setCommand] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [inspect, setInspect] = useState(false);
  const [selection, setSelection] = useState<PreviewElementSelection | null>(null);
  const [request, setRequest] = useState('');
  const [issues, setIssues] = useState<BrowserIssue[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [guestReady, setGuestReady] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<PreviewInspectorTab>('selection');
  const webviewRef = useRef<WebviewElement | null>(null);
  const projectId = activeProject?.id ?? null;

  const refresh = useCallback(async (): Promise<void> => {
    if (!projectId) return;
    try {
      const next = unwrap(await window.kaiDesktop.previewStatus(projectId));
      setState(next);
      if (next.url) setUrl((current) => current || next.url!);
    } catch (caught) {
      setNotice(messageOf(caught));
    }
  }, [projectId]);

  useEffect(() => {
    setInfo(null);
    setState(null);
    setCommand('');
    setUrl('');
    setIssues([]);
    setSelection(null);
    setInspect(false);
    setGuestReady(false);
    setInspectorTab('selection');
    if (!projectId) return;
    let cancelled = false;
    void Promise.all([
      window.kaiDesktop.previewInfo(projectId).then(unwrap),
      window.kaiDesktop.previewStatus(projectId).then(unwrap),
    ]).then(([nextInfo, nextState]) => {
      if (cancelled) return;
      setInfo(nextInfo);
      setCommand(nextInfo.command);
      setState(nextState);
      if (nextState.url) setUrl(nextState.url);
    }).catch((caught) => {
      if (!cancelled) setNotice(messageOf(caught));
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (state?.status !== 'starting' && state?.status !== 'running') return;
    const timer = window.setInterval(() => void refresh(), 1_000);
    return () => window.clearInterval(timer);
  }, [refresh, state?.status]);

  useEffect(() => {
    const guest = webviewRef.current;
    if (!guest) return;
    setGuestReady(false);
    const clean = url.trim();
    if (clean && guest.src !== clean) guest.src = clean;
  }, [info?.preloadPath, url]);

  useEffect(() => {
    const guest = webviewRef.current;
    if (!guest) return;
    let issueSequence = 0;
    const addIssue = (level: BrowserIssue['level'], message: string, source = '', line = 0): void => {
      const trimmed = message.trim();
      if (!trimmed) return;
      issueSequence += 1;
      setIssues((current) => [{
        id: `${Date.now()}-${issueSequence}`,
        level,
        message: trimmed.slice(0, 2_000),
        source: source.slice(0, 500),
        line,
        timestamp: new Date().toISOString(),
      }, ...current].slice(0, 80));
    };
    const consoleMessage = (event: Event): void => {
      const detail = event as Event & { level?: number; message?: string; sourceId?: string; line?: number };
      if (detail.level === 2) addIssue('warning', detail.message ?? '', detail.sourceId, detail.line);
      if (detail.level === 3) addIssue('error', detail.message ?? '', detail.sourceId, detail.line);
    };
    const failedLoad = (event: Event): void => {
      const detail = event as Event & { errorCode?: number; errorDescription?: string; validatedURL?: string };
      if (detail.errorCode === -3) return;
      addIssue('error', detail.errorDescription ?? 'The preview page failed to load.', detail.validatedURL, 0);
    };
    const processGone = (event: Event): void => {
      const detail = event as Event & { reason?: string };
      addIssue('error', `Preview renderer exited: ${detail.reason ?? 'unknown reason'}.`);
    };
    const domReady = (): void => setGuestReady(true);
    const selected = (event: Event): void => {
      const detail = event as Event & { channel?: string; args?: unknown[] };
      if (detail.channel !== 'preview:element-selected') return;
      const value = detail.args?.[0] as Partial<PreviewElementSelection> | undefined;
      if (!value || typeof value.selector !== 'string') return;
      setSelection({
        selector: value.selector,
        tagName: typeof value.tagName === 'string' ? value.tagName : '',
        text: typeof value.text === 'string' ? value.text.slice(0, 4_000) : '',
        html: typeof value.html === 'string' ? value.html.slice(0, 8_000) : '',
        url: typeof value.url === 'string' ? value.url : url,
      });
      setInspect(false);
      setInspectorTab('selection');
      setNotice('Element captured. Describe the change, then send it to the active agent.');
    };
    guest.addEventListener('console-message', consoleMessage);
    guest.addEventListener('did-fail-load', failedLoad);
    guest.addEventListener('render-process-gone', processGone);
    guest.addEventListener('ipc-message', selected);
    guest.addEventListener('dom-ready', domReady);
    return () => {
      guest.removeEventListener('console-message', consoleMessage);
      guest.removeEventListener('did-fail-load', failedLoad);
      guest.removeEventListener('render-process-gone', processGone);
      guest.removeEventListener('ipc-message', selected);
      guest.removeEventListener('dom-ready', domReady);
    };
  }, [url]);

  useEffect(() => {
    const guest = webviewRef.current;
    if (!guest || !info || !guestReady) return;
    void (async () => {
      try {
        await guest.executeJavaScript(elementInspectorScript(inspect));
      } catch {
        // The webview can be recreated or navigate while inspection is being applied.
      }
    })();
  }, [guestReady, inspect, info]);

  async function start(): Promise<void> {
    if (!projectId) return;
    setBusy('start');
    setNotice(null);
    try {
      const next = unwrap(await window.kaiDesktop.startPreview({
        projectId,
        ...(command.trim() ? { command: command.trim() } : {}),
      }));
      setState(next);
      if (next.url) setUrl(next.url);
      setNotice('Starting the project. KAI will load the first local URL it reports.');
    } catch (caught) {
      setNotice(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  async function stop(): Promise<void> {
    if (!projectId) return;
    setBusy('stop');
    try {
      setState(unwrap(await window.kaiDesktop.stopPreview(projectId)));
      setNotice('Preview server stopped.');
    } catch (caught) {
      setNotice(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  function openUrl(): void {
    if (!url.trim() || !webviewRef.current) return;
    webviewRef.current.src = url.trim();
    setNotice('Preview URL loaded.');
  }

  function submitRequest(): void {
    if (!selection || !request.trim()) return;
    onRequestChange(previewChangePrompt(selection, request.trim(), issues.slice(0, 8)));
    setNotice('Change request sent to the workspace composer.');
  }

  if (!activeProject) {
    return (
      <div className="preview-pane">
        <PreviewPaneHeader projectName="No project open" status="stopped" onClose={onClose} />
        <div className="preview-empty-state">
          <AppWindow size={30} />
          <strong>Open a project</strong>
          <span>Choose a project to run and inspect it inside KAI.</span>
        </div>
      </div>
    );
  }

  const running = state?.status === 'running';
  const starting = state?.status === 'starting';
  return (
    <div className="preview-pane" aria-label="Live preview pane">
      <PreviewPaneHeader
        projectName={activeProject.name}
        status={state?.status ?? 'stopped'}
        startedAt={state?.startedAt ?? undefined}
        onClose={onClose}
      />

      <div className="preview-toolbar">
        <label className="input-with-icon preview-command">
          <Terminal size={13} />
          <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="The command that starts this project" aria-label="Preview command" />
        </label>
        <button type="button" className="primary-button preview-run-button" aria-label={running || starting ? 'Restart project' : 'Start project'} disabled={!command.trim() || Boolean(busy)} onClick={() => void start()}>
          {starting ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}
          <span>{running || starting ? 'Restart' : 'Run'}</span>
        </button>
        <button type="button" className="secondary-button preview-stop-button" disabled={!running && !starting || Boolean(busy)} onClick={() => void stop()}>
          <Square size={12} />
          <span>Stop</span>
        </button>
        <label className="input-with-icon preview-url">
          <Globe2 size={13} />
          <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="http://localhost:5173" aria-label="Preview URL" onKeyDown={(event) => { if (event.key === 'Enter') openUrl(); }} />
        </label>
        <div className="preview-url-actions">
          <button type="button" className="icon-button compact" title="Open URL in the preview" aria-label="Open URL in the preview" disabled={!url.trim()} onClick={openUrl}><ExternalLink size={14} /></button>
          <button type="button" className="icon-button compact" title="Reload preview" aria-label="Reload preview" disabled={!url.trim()} onClick={() => webviewRef.current?.reload()}><RefreshCw size={14} /></button>
          <button type="button" className={`secondary-button preview-inspect-button ${inspect ? 'active' : ''}`} aria-pressed={inspect} disabled={!url.trim()} onClick={() => setInspect((current) => !current)}>
            <MousePointerClick size={13} />
            <span>{inspect ? 'Selecting...' : 'Select element'}</span>
          </button>
        </div>
      </div>

      {info && info.candidates.length > 1 && (
        <div className="preview-starts" role="group" aria-label="Ways to start this project">
          <span className="preview-starts-label">Start with</span>
          {info.candidates.map((candidate) => (
            <button
              key={candidate.command}
              type="button"
              className="chip-button"
              title={candidate.command}
              aria-pressed={candidate.command === command.trim()}
              onClick={() => setCommand(candidate.command)}
            >
              {candidate.label}
            </button>
          ))}
        </div>
      )}

      {notice && <div className="preview-notice" role="status"><span>{notice}</span><button type="button" className="icon-button compact" aria-label="Dismiss preview notice" onClick={() => setNotice(null)}><X size={13} /></button></div>}
      {state?.message && <div className={`preview-notice ${state.status === 'failed' ? 'preview-error' : ''}`} role={state.status === 'failed' ? 'alert' : 'status'}><span>{state.message}</span></div>}

      <section className="preview-stage" aria-label="Application preview">
        <div className="preview-stage-bar">
          <span className={`preview-live-dot ${running ? 'running' : ''}`} />
          <span className="truncate">{url.trim() || 'Waiting for a local URL'}</span>
          <small>{guestReady ? 'Connected' : running || starting ? 'Connecting' : 'Idle'}</small>
        </div>
        <div className="preview-canvas">
          {info && (
            <webview
              ref={webviewRef}
              className="preview-webview"
              src={url.trim() || 'about:blank'}
              preload={info.preloadPath}
              partition="persist:kai-live-preview"
              allowpopups={false}
            />
          )}
          {!url.trim() && (
            <div className="preview-placeholder">
              <AppWindow size={32} />
              <strong>{info?.available ? 'Run the project to load its preview' : 'Enter a preview command or URL'}</strong>
              <span>{info?.available ? `Detected: ${info.command}` : 'No start command was found for this project. Type the one that starts it.'}</span>
            </div>
          )}
        </div>
      </section>

      <aside className="preview-inspector" aria-label="Preview inspector">
        <div className="preview-inspector-tabs" role="tablist" aria-label="Preview inspector views">
          <button type="button" role="tab" aria-selected={inspectorTab === 'selection'} className={inspectorTab === 'selection' ? 'active' : ''} onClick={() => setInspectorTab('selection')}>
            <MousePointerClick size={13} />Selection
          </button>
          <button type="button" role="tab" aria-selected={inspectorTab === 'issues'} className={inspectorTab === 'issues' ? 'active' : ''} onClick={() => setInspectorTab('issues')}>
            <AlertTriangle size={13} />Issues{issues.length > 0 ? <span>{issues.length}</span> : null}
          </button>
          <button type="button" role="tab" aria-selected={inspectorTab === 'logs'} className={inspectorTab === 'logs' ? 'active' : ''} onClick={() => setInspectorTab('logs')}>
            <Terminal size={13} />Server log
          </button>
        </div>

        <div className="preview-inspector-panel" role="tabpanel">
          {inspectorTab === 'selection' && (
            <section className="preview-selection-panel">
            <div className="preview-panel-heading"><div><span className="eyebrow">Selection</span><h2>Request a change</h2></div><MousePointerClick size={16} /></div>
            {selection ? (
              <>
                <div className="preview-selection-card">
                  <strong>{selection.selector || selection.tagName}</strong>
                  {selection.text && <p>{selection.text}</p>}
                  <small>{selection.tagName}{selection.url ? ` · ${selection.url}` : ''}</small>
                </div>
                <textarea className="preview-request-input" rows={5} value={request} onChange={(event) => setRequest(event.target.value)} placeholder="Describe what should change..." />
                <div className="preview-inspector-actions">
                  <button type="button" className="primary-button" disabled={!request.trim()} onClick={submitRequest}><Send size={13} /><span>Send to workspace</span></button>
                  <button type="button" className="secondary-button" onClick={() => { setSelection(null); setRequest(''); }}>Clear</button>
                </div>
              </>
            ) : (
              <div className="preview-empty-selection">
                <MousePointerClick size={24} />
                <strong>Choose an element in the preview</strong>
                <span>Turn a rendered component into a precise change request for the active agent.</span>
                <button type="button" className="secondary-button" disabled={!url.trim() || inspect} onClick={() => setInspect(true)}>
                  <MousePointerClick size={13} />Select element
                </button>
              </div>
            )}
            </section>
          )}

          {inspectorTab === 'issues' && (
            <section className="preview-issues">
            <div className="preview-panel-heading">
              <div><span className="eyebrow">Browser errors</span><h2>{issues.length} issue{issues.length === 1 ? '' : 's'}</h2></div>
              {issues.length > 0 && <button type="button" className="secondary-button preview-clear-issues" onClick={() => setIssues([])}><Trash2 size={13} /><span>Clear</span></button>}
            </div>
            <div className="preview-issue-list">
              {issues.map((issue) => (
                <article key={issue.id} className={`preview-issue ${issue.level}`}>
                  <div><strong>{issue.level === 'error' ? 'Error' : 'Warning'}</strong><small>{relativeTime(issue.timestamp)}</small></div>
                  <p>{issue.message}</p>
                  {(issue.source || issue.line) && <code>{issue.source}{issue.line ? `:${issue.line}` : ''}</code>}
                </article>
              ))}
              {issues.length === 0 && <div className="preview-clean"><CheckCircle2 size={18} /><span>No browser errors captured</span></div>}
            </div>
            </section>
          )}

          {inspectorTab === 'logs' && (
            <section className="preview-log-panel">
              <div className="preview-panel-heading"><div><span className="eyebrow">Server output</span><h2>Recent log</h2></div><Terminal size={16} /></div>
              {state?.outputTail ? <pre className="preview-output">{state.outputTail}</pre> : <p className="preview-empty-copy">Server output will appear here after the project starts.</p>}
            </section>
          )}
        </div>
      </aside>
    </div>
  );
}

function PreviewPaneHeader({ projectName, status, startedAt, onClose }: {
  projectName: string;
  status: string;
  startedAt?: string;
  onClose: () => void;
}): ReactNode {
  return (
    <header className="preview-pane-header">
      <div className="preview-pane-title">
        <span className="preview-pane-mark"><AppWindow size={15} /></span>
        <div>
          <span className="eyebrow">Live application</span>
          <strong title={projectName}>{projectName}</strong>
        </div>
      </div>
      <div className="preview-pane-actions">
        <span className={`preview-status ${status}`}><Globe2 size={12} />{status}</span>
        {startedAt && <small>{relativeTime(startedAt)}</small>}
        <button type="button" className="icon-button compact" title="Close live preview pane" aria-label="Close live preview pane" onClick={onClose}><X size={14} /></button>
      </div>
    </header>
  );
}

function elementInspectorScript(enabled: boolean): string {
  return `(() => {
    const KEY = '__kaiPreviewInspector';
    const existing = window[KEY];
    if (!existing) {
      const state = { enabled: false, active: null };
      const selectorFor = (element) => {
        if (!element || element.nodeType !== 1) return '';
        if (element.id) return '#' + CSS.escape(element.id);
        const parts = [];
        let current = element;
        while (current && current.nodeType === 1 && parts.length < 5) {
          let part = current.tagName.toLowerCase();
          const stableClass = [...current.classList].find((name) => /^[a-z][a-z0-9_-]{1,40}$/i.test(name));
          if (stableClass) part += '.' + CSS.escape(stableClass);
          const parent = current.parentElement;
          if (parent) {
            const siblings = [...parent.children].filter((item) => item.tagName === current.tagName);
            if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
          }
          parts.unshift(part);
          if (current.id) break;
          current = parent;
        }
        return parts.join(' > ');
      };
      const setOutline = (element, value) => {
        if (!element || !element.style) return;
        if (value) {
          element.dataset.kaiOutline = element.style.outline || '';
          element.style.outline = '2px solid #66e3bd';
          element.style.outlineOffset = '2px';
        } else {
          element.style.outline = element.dataset.kaiOutline || '';
          delete element.dataset.kaiOutline;
        }
      };
      window[KEY] = state;
      document.addEventListener('mouseover', (event) => {
        if (!state.enabled) return;
        if (state.active) setOutline(state.active, false);
        state.active = event.target;
        setOutline(state.active, true);
      }, true);
      document.addEventListener('mouseout', (event) => {
        if (!state.enabled || event.target !== state.active) return;
        setOutline(state.active, false);
        state.active = null;
      }, true);
      document.addEventListener('click', (event) => {
        if (!state.enabled) return;
        event.preventDefault();
        event.stopPropagation();
        const element = event.target;
        window.kaiPreview?.select({
          selector: selectorFor(element),
          tagName: element?.tagName?.toLowerCase() || '',
          text: (element?.innerText || '').trim().slice(0, 4000),
          html: (element?.outerHTML || '').slice(0, 8000),
          url: location.href,
        });
        if (state.active) setOutline(state.active, false);
        state.active = null;
        state.enabled = false;
      }, true);
    }
    window[KEY].enabled = ${enabled ? 'true' : 'false'};
    if (!window[KEY].enabled && window[KEY].active) {
      window[KEY].active.style.outline = window[KEY].active.dataset.kaiOutline || '';
      window[KEY].active = null;
    }
    return window[KEY].enabled;
  })()`;
}

function previewChangePrompt(selection: PreviewElementSelection, request: string, issues: BrowserIssue[]): string {
  return [
    'Change the selected element in the live application preview.',
    `Element: ${selection.tagName || 'unknown'}${selection.selector ? ` (${selection.selector})` : ''}`,
    selection.text ? `Visible text: ${selection.text}` : '',
    selection.url ? `Page: ${selection.url}` : '',
    selection.html ? `Element HTML:\n${selection.html}` : '',
    issues.length ? `Recent browser errors:\n${issues.map((issue) => `- ${issue.level}: ${issue.message}${issue.source ? ` (${issue.source}${issue.line ? `:${issue.line}` : ''})` : ''}`).join('\n')}` : '',
    `Requested change: ${request}`,
  ].filter(Boolean).join('\n\n');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
