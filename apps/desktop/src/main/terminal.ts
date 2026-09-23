import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { TerminalEvent, TerminalShell } from '@kai/contracts';
import { terminateProcessTree } from './project-tools';

const MAX_RUNNING = 8;

/** Path to Git for Windows' bash.exe, or null when it is not installed. `KAI_GIT_BASH` overrides the search. */
export function findGitBash(): string | null {
  if (process.platform !== 'win32') return null;
  const local = process.env.LOCALAPPDATA;
  const candidates = [
    process.env.KAI_GIT_BASH,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    local ? path.join(local, 'Programs', 'Git', 'bin', 'bash.exe') : undefined,
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate) && existsSync(candidate!)) ?? null;
}
const MAX_CHUNK = 16_000;

interface Session {
  child: ChildProcess;
  projectId: string;
}

/**
 * Runs commands the user types, in their project, and streams the output.
 *
 * This is a command runner, not a full terminal: stdin is closed, so a program that waits for
 * typed input ends instead of hanging, and full-screen programs (vim, top) are not supported.
 * Commands run with the user's own permissions, exactly as if typed in their shell.
 */
export class TerminalManager {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly emit: (event: TerminalEvent) => void) {}

  runningCount(): number {
    return this.sessions.size;
  }

  start(projectId: string, cwd: string, command: string, shell: TerminalShell): string {
    if (this.sessions.size >= MAX_RUNNING) throw new Error(`Only ${MAX_RUNNING} commands can run at once. Stop one first.`);
    const id = `term_${randomUUID()}`;
    if (shell === 'gitbash' && !findGitBash()) throw new Error('Git Bash was not found. Install Git for Windows, or choose another shell.');
    const child = shell === 'gitbash'
      ? spawn(findGitBash()!, ['-lc', command], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : shell === 'powershell' && process.platform === 'win32'
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      // Detached on POSIX so the whole process group can be stopped, not just the shell.
      : spawn(command, { cwd, shell: true, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    this.sessions.set(id, { child, projectId });

    const forward = (stream: 'stdout' | 'stderr') => (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      for (let offset = 0; offset < text.length; offset += MAX_CHUNK) {
        this.emit({ kind: 'output', id, stream, text: text.slice(offset, offset + MAX_CHUNK) });
      }
    };
    child.stdout?.on('data', forward('stdout'));
    child.stderr?.on('data', forward('stderr'));
    let finished = false;
    const finish = (code: number | null, signal: string | null): void => {
      if (finished) return;
      finished = true;
      this.sessions.delete(id);
      this.emit({ kind: 'exit', id, code, signal });
    };
    child.once('error', (error) => {
      this.emit({ kind: 'output', id, stream: 'stderr', text: `${error.message}\n` });
      finish(null, null);
    });
    child.once('close', (code, signal) => finish(code, signal));
    return id;
  }

  async stop(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    await terminateProcessTree(session.child);
    return true;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
  }
}
