import { Play, Square, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { ProjectRecord, TerminalShell } from '@kai/contracts';
import { unwrap } from '../types';

interface Run {
  id: string;
  command: string;
  project: string;
  output: string;
  status: 'running' | 'exited';
  code: number | null;
}

const MAX_OUTPUT = 200_000;
const SUGGESTIONS = ['git status', 'git log --oneline -10', 'npm test', 'npm run build'];

/** A command console: run a command in the project, watch its output, stop it. Not an interactive shell. */
export function TerminalView({ activeProject, open, height, onClose, onResizeStart }: {
  activeProject: ProjectRecord | null;
  open: boolean;
  height: number;
  onClose: () => void;
  onResizeStart: (event: PointerEvent<HTMLDivElement>) => void;
}): ReactNode {
  const [runs, setRuns] = useState<Run[]>([]);
  const [command, setCommand] = useState('');
  const [shell, setShell] = useState<TerminalShell>('default');
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const historyIndex = useRef(-1);
  const endRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Output can arrive before the run is added to state, so events are applied to a ref-backed map first.
  const pending = useRef(new Map<string, { output: string; exit: { code: number | null } | null }>());

  useEffect(() => window.kaiDesktop.onTerminalEvent((event) => {
    setRuns((current) => {
      const index = current.findIndex((run) => run.id === event.id);
      if (index < 0) {
        const early = pending.current.get(event.id) ?? { output: '', exit: null };
        if (event.kind === 'output') early.output += event.text;
        else early.exit = { code: event.code };
        pending.current.set(event.id, early);
        return current;
      }
      const next = [...current];
      const run = next[index]!;
      next[index] = event.kind === 'output'
        ? { ...run, output: (run.output + event.text).slice(-MAX_OUTPUT) }
        : { ...run, status: 'exited', code: event.code };
      return next;
    });
  }), []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [runs]);

  // Focus the command line whenever the panel is opened.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  async function run(text: string): Promise<void> {
    if (!activeProject || !text.trim()) return;
    setError(null);
    try {
      const { id } = unwrap(await window.kaiDesktop.runTerminalCommand(activeProject.id, text.trim(), shell));
      const early = pending.current.get(id) ?? { output: '', exit: null };
      pending.current.delete(id);
      // A very fast command can finish before the run is registered here, so its early output and exit are applied now.
      setRuns((current) => [...current, {
        id,
        command: text.trim(),
        project: activeProject.name,
        output: early.output,
        status: early.exit ? 'exited' : 'running',
        code: early.exit?.code ?? null,
      }]);
      setHistory((current) => [text.trim(), ...current.filter((item) => item !== text.trim())].slice(0, 50));
      historyIndex.current = -1;
      setCommand('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The command could not be started.');
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      void run(command);
    } else if (event.key === 'ArrowUp' && history.length > 0) {
      event.preventDefault();
      historyIndex.current = Math.min(historyIndex.current + 1, history.length - 1);
      setCommand(history[historyIndex.current] ?? '');
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      historyIndex.current = Math.max(historyIndex.current - 1, -1);
      setCommand(historyIndex.current < 0 ? '' : history[historyIndex.current] ?? '');
    }
  }

  return (
    <section className="terminal-dock" style={{ height }} hidden={!open} aria-label="Terminal">
      <div className="terminal-resize" role="separator" aria-orientation="horizontal" aria-label="Resize terminal" onPointerDown={onResizeStart} />
      <header className="terminal-head">
        <div>
          <strong>Terminal</strong>
          <span>{activeProject ? ` · ${activeProject.name}` : ' · open a project to run commands'} · runs with your permissions; programs that wait for typed input end at once</span>
        </div>
        <div className="terminal-head-actions">
          <button type="button" className="secondary-button" disabled={runs.length === 0} onClick={() => setRuns((current) => current.filter((item) => item.status === 'running'))}><Trash2 size={13} /><span>Clear</span></button>
          <button type="button" className="icon-button compact" aria-label="Close terminal" title="Close (Ctrl+`)" onClick={onClose}><X size={14} /></button>
        </div>
      </header>

      <div className="terminal-log" role="log" aria-label="Command output" aria-live="polite">
        {runs.length === 0 && <div className="empty-list">Nothing has run yet. Try {SUGGESTIONS.map((item) => <button key={item} type="button" className="terminal-suggestion" onClick={() => setCommand(item)}>{item}</button>)}</div>}
        {runs.map((item) => (
          <section key={item.id} className={`terminal-run ${item.status}`}>
            <div className="terminal-run-head">
              <code>$ {item.command}</code>
              {item.status === 'running'
                ? <button type="button" className="secondary-button" onClick={() => void window.kaiDesktop.stopTerminalCommand(item.id)}><Square size={12} /><span>Stop</span></button>
                : <span className={`terminal-exit ${item.code === 0 ? 'ok' : 'bad'}`}>{item.code === 0 ? 'exit 0' : item.code === null ? 'stopped' : `exit ${item.code}`}</span>}
            </div>
            <pre>{item.output || (item.status === 'running' ? '…' : '(no output)')}</pre>
          </section>
        ))}
        <div ref={endRef} />
      </div>

      {error && <div className="workbench-error" role="alert">{error}</div>}
      <div className="terminal-input">
        {typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows') && (
          <select aria-label="Shell" value={shell} onChange={(event) => setShell(event.target.value as TerminalShell)}>
            <option value="default">Command Prompt</option>
            <option value="powershell">PowerShell</option>
            <option value="gitbash">Git Bash</option>
          </select>
        )}
        <input ref={inputRef} aria-label="Command" value={command} disabled={!activeProject} placeholder="Type a command and press Enter" onChange={(event) => setCommand(event.target.value)} onKeyDown={onKeyDown} />
        <button type="button" className="primary-button" disabled={!activeProject || !command.trim()} onClick={() => void run(command)}><Play size={14} /><span>Run</span></button>
      </div>
    </section>
  );
}
