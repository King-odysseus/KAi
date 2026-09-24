import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as pty from 'node-pty';
import type { TerminalEvent, TerminalSession, TerminalShell } from '@kai/contracts';

const MAX_RUNNING = 8;

/** Path to Git for Windows' bash.exe, or null when it is not installed. `KAI_GIT_BASH` overrides the search. */
export function findGitBash(): string | null {
  if (process.platform !== 'win32') return null;
  const local = process.env.LOCALAPPDATA;
  return [
    process.env.KAI_GIT_BASH,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    local ? path.join(local, 'Programs', 'Git', 'bin', 'bash.exe') : undefined,
  ].find((candidate): candidate is string => Boolean(candidate) && existsSync(candidate!)) ?? null;
}

interface Session extends TerminalSession {
  child: pty.IPty;
  ownerWindowId: number | null;
}

/** Owns interactive PTY sessions. Programs can prompt, draw full-screen UI, and receive control keys. */
export class TerminalManager {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly emit: (event: TerminalEvent, ownerWindowId: number | null) => void) {}

  runningCount(): number {
    return this.sessions.size;
  }

  start(
    projectId: string,
    cwd: string,
    shell: TerminalShell,
    cols = 120,
    rows = 30,
    ownerWindowId: number | null = null,
  ): TerminalSession {
    if (this.sessions.size >= MAX_RUNNING) throw new Error(`Only ${MAX_RUNNING} terminal sessions can run at once. Close one first.`);
    const id = `term_${randomUUID()}`;
    const executable = shellExecutable(shell);
    const child = pty.spawn(executable.command, executable.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>,
      useConpty: process.platform === 'win32',
    });
    const session: Session = { id, projectId, shell, cwd, cols, rows, child, ownerWindowId };
    this.sessions.set(id, session);
    child.onData((data) => this.emit({ kind: 'output', id, data }, ownerWindowId));
    child.onExit(({ exitCode, signal }) => {
      this.sessions.delete(id);
      this.emit({ kind: 'exit', id, code: exitCode, signal: signal === undefined ? null : String(signal) }, ownerWindowId);
    });
    const { child: _child, ownerWindowId: _ownerWindowId, ...publicSession } = session;
    return publicSession;
  }

  write(id: string, data: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.child.write(data);
    return true;
  }

  resize(id: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.child.resize(cols, rows);
    session.cols = cols;
    session.rows = rows;
    return true;
  }

  stop(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.child.kill();
    return true;
  }

  async stopAll(): Promise<void> {
    for (const session of this.sessions.values()) {
      try {
        session.child.kill();
      } catch {
        // The PTY may already have exited between iteration and kill.
      }
    }
    this.sessions.clear();
  }
}

function shellExecutable(shell: TerminalShell): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    if (shell === 'gitbash') {
      const gitBash = findGitBash();
      if (!gitBash) throw new Error('Git Bash was not found. Install Git for Windows, or choose another shell.');
      return { command: gitBash, args: ['--login', '-i'] };
    }
    if (shell === 'powershell') return { command: 'powershell.exe', args: ['-NoLogo'] };
    return { command: process.env.ComSpec || 'cmd.exe', args: [] };
  }
  if (shell === 'powershell') return { command: 'pwsh', args: ['-NoLogo'] };
  if (shell === 'gitbash') {
    const gitBash = findGitBash();
    if (!gitBash) throw new Error('Git Bash was not found. Install Git for Windows, or choose another shell.');
    return { command: gitBash, args: ['--login', '-i'] };
  }
  return { command: process.env.SHELL || '/bin/bash', args: ['-l'] };
}
