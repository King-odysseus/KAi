import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { Eraser, Play, RotateCcw, Square, X } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import type { ProjectRecord, TerminalSession, TerminalShell } from '@kai/contracts';
import { unwrap } from '../types';

import { Select } from './ui/Select';
/** A real interactive PTY backed by xterm.js. The session survives page and panel navigation. */
export function TerminalView({ activeProject, open, height, onClose, onResizeStart, commandRequest }: {
  activeProject: ProjectRecord | null;
  open: boolean;
  height: number;
  onClose: () => void;
  onResizeStart: (event: PointerEvent<HTMLDivElement>) => void;
  /** A command is only injected after the user chose an action such as GitHub sign-in. */
  commandRequest?: { command: string; nonce: number } | null;
}): ReactNode {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<TerminalSession | null>(null);
  const earlyOutputRef = useRef(new Map<string, string[]>());
  const [shell, setShell] = useState<TerminalShell>('default');
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [status, setStatus] = useState<'idle' | 'starting' | 'running' | 'exited'>('idle');
  const [error, setError] = useState<string | null>(null);

  function writeOutput(id: string, data: string): void {
    if (sessionRef.current?.id === id) {
      terminalRef.current?.write(data);
      return;
    }
    const queued = earlyOutputRef.current.get(id) ?? [];
    queued.push(data);
    earlyOutputRef.current.set(id, queued);
  }

  useEffect(() => window.kaiDesktop.onTerminalEvent((event) => {
    if (event.kind === 'output') {
      writeOutput(event.id, event.data);
      return;
    }
    if (sessionRef.current?.id !== event.id) return;
    setStatus('exited');
    terminalRef.current?.write(`\r\n[process exited${event.code === null ? '' : ` with code ${event.code}`}]\r\n`);
  }), []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || terminalRef.current) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: false,
      scrollback: 8_000,
      fontFamily: 'Consolas, "Cascadia Mono", monospace',
      fontSize: 13,
      theme: {
        background: '#07101d',
        foreground: '#d8e2f0',
        cursor: '#7dd3fc',
        selectionBackground: '#27506f',
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;
    fitRef.current = fit;
    const dataSubscription = terminal.onData((data) => {
      const id = sessionRef.current?.id;
      if (id) void window.kaiDesktop.writeTerminal(id, data);
    });
    const resizeSubscription = terminal.onResize(({ cols, rows }) => {
      const id = sessionRef.current?.id;
      if (id) void window.kaiDesktop.resizeTerminal(id, cols, rows);
    });
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // The dock can be hidden while the browser reports a zero-sized host.
      }
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
      dataSubscription.dispose();
      resizeSubscription.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (open) {
      window.setTimeout(() => {
        try {
          fitRef.current?.fit();
        } catch {
          // A hidden or zero-sized host will be fitted on the next resize.
        }
        terminalRef.current?.focus();
      }, 0);
    }
  }, [open]);

  useEffect(() => {
    const previous = sessionRef.current;
    if (previous) {
      void window.kaiDesktop.stopTerminalCommand(previous.id).catch(() => undefined);
    }
    sessionRef.current = null;
    setSession(null);
    setStatus('idle');
    terminalRef.current?.reset();
    if (activeProject) void startSession(shell);
    return () => {
      const current = sessionRef.current;
      sessionRef.current = null;
      if (current) void window.kaiDesktop.stopTerminalCommand(current.id).catch(() => undefined);
    };
    // The shell is intentionally applied only when starting/restarting, not by killing a live session on select.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.id]);

  async function startSession(nextShell: TerminalShell): Promise<void> {
    if (!activeProject) return;
    setError(null);
    setStatus('starting');
    try {
      const terminal = terminalRef.current;
      const started = unwrap(await window.kaiDesktop.startTerminal(
        activeProject.id,
        nextShell,
        terminal?.cols || 120,
        terminal?.rows || 30,
      ));
      sessionRef.current = started;
      setSession(started);
      setStatus('running');
      for (const chunk of earlyOutputRef.current.get(started.id) ?? []) terminal?.write(chunk);
      earlyOutputRef.current.delete(started.id);
      window.setTimeout(() => {
        try {
          fitRef.current?.fit();
        } catch {
          // The host may still be hidden.
        }
        terminalRef.current?.focus();
      }, 0);
    } catch (caught) {
      setStatus('exited');
      setError(caught instanceof Error ? caught.message : 'The terminal could not be started.');
    }
  }

  useEffect(() => {
    const request = commandRequest;
    const id = sessionRef.current?.id;
    if (!request || !id || status !== 'running') return;
    void window.kaiDesktop.writeTerminal(id, `${request.command}\r`);
  }, [commandRequest?.nonce, status]);

  async function restart(): Promise<void> {
    const current = sessionRef.current;
    if (current) await window.kaiDesktop.stopTerminalCommand(current.id).catch(() => undefined);
    sessionRef.current = null;
    setSession(null);
    terminalRef.current?.reset();
    await startSession(shell);
  }

  async function stop(): Promise<void> {
    const current = sessionRef.current;
    if (!current) return;
    await window.kaiDesktop.stopTerminalCommand(current.id).catch(() => undefined);
    setStatus('exited');
  }

  return (
    <section className="terminal-dock" style={{ height }} hidden={!open} aria-label="Terminal">
      <div className="terminal-resize" role="separator" aria-orientation="horizontal" aria-label="Resize terminal" onPointerDown={onResizeStart} />
      <header className="terminal-head">
        <div>
          <strong>Terminal</strong>
          <span>{activeProject ? ` · ${activeProject.name}` : ' · open a project to start a shell'} · interactive {session?.shell ?? shell} · {status}</span>
        </div>
        <div className="terminal-head-actions">
          {session && status === 'running' && <button type="button" className="secondary-button" onClick={() => void stop()}><Square size={12} /><span>Stop</span></button>}
          <button type="button" className="secondary-button" disabled={!activeProject || status === 'starting'} onClick={() => void restart()}><RotateCcw size={13} /><span>Restart</span></button>
          <button type="button" className="secondary-button" onClick={() => terminalRef.current?.clear()}><Eraser size={13} /><span>Clear</span></button>
          <button type="button" className="icon-button compact" aria-label="Close terminal" title="Close (Ctrl+`)" onClick={onClose}><X size={14} /></button>
        </div>
      </header>
      {error && <div className="workbench-error" role="alert">{error}</div>}
      <div className="terminal-xterm" ref={hostRef} />
      <div className="terminal-input terminal-launch-row">
        {typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows') && (
          <Select aria-label="Shell" value={shell} onChange={(event) => setShell(event.target.value as TerminalShell)}>
            <option value="default">Command Prompt</option>
            <option value="powershell">PowerShell</option>
            <option value="gitbash">Git Bash</option>
          </Select>
        )}
        <span>{activeProject ? 'Type directly in the terminal. Prompts, interactive tools, and full-screen programs are supported.' : 'Open a project to start a shell.'}</span>
        <button type="button" className="primary-button" disabled={!activeProject || status === 'starting' || status === 'running'} onClick={() => void startSession(shell)}><Play size={14} /><span>Start</span></button>
      </div>
    </section>
  );
}
