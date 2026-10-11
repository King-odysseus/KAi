import { randomBytes } from 'node:crypto';
import type { TerminalSession, TerminalShell } from '@kai/contracts';
import { findGitBash } from './terminal';

/**
 * What an agent can do with KAI's own terminal. Sessions are the same kind the terminal dock shows, so a command an
 * agent runs is visible to the person, who can also type into it — and none of it opens a window of its own.
 *
 * The agent names a shell; KAI says which are installed. Git Bash is the default where it exists because that is what
 * the rest of KAI's shell tooling assumes, but PowerShell and cmd are one argument away.
 */

export type AgentShell = 'gitbash' | 'powershell' | 'cmd';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_CHARS = 30_000;

/** The slice of the terminal manager this needs, so the logic is testable without a real PTY. */
export interface AgentTerminalPort {
  start(projectId: string, cwd: string, shell: TerminalShell, cols: number, rows: number, ownerWindowId: number | null, options: { agent: boolean }): TerminalSession;
  write(id: string, data: string): boolean;
  stop(id: string): boolean;
  get(id: string): TerminalSession | null;
  list(): TerminalSession[];
  buffer(id: string): string | null;
  onOutput(listener: (id: string, data: string) => void): () => void;
  onExit(listener: (id: string) => void): () => void;
}

export interface AgentTerminalContext {
  /** The project a session belongs to and starts in when the agent names no folder. */
  activeProject(): Promise<{ id: string; path: string } | null>;
}

export interface RunResult {
  sessionId: string;
  shell: AgentShell;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

export function availableShells(platform: NodeJS.Platform = process.platform, gitBash: string | null = findGitBash()): AgentShell[] {
  if (platform === 'win32') return [...(gitBash ? ['gitbash' as const] : []), 'powershell', 'cmd'];
  // Elsewhere the one shell is the login shell, which the terminal manager calls `default` and this calls `cmd`.
  return ['cmd'];
}

/** The shell KAI picks for an agent that does not name one. */
export function defaultShell(available: readonly AgentShell[]): AgentShell {
  return available[0] ?? 'cmd';
}

/** `default` in the terminal manager is the platform shell, which is cmd on Windows and the login shell elsewhere. */
function managerShell(shell: AgentShell): TerminalShell {
  return shell === 'cmd' ? 'default' : shell;
}

/** Typed into a new agent session so its prompt is one short line.  */
export function promptSetup(shell: AgentShell): string | null {
  if (shell === 'gitbash') return "PS1='$ '";
  if (shell === 'powershell') return "function prompt { '> ' }";
  if (shell === 'cmd' && process.platform === 'win32') return 'prompt $G';
  return null;
}

/** The line that, typed after a command, prints a marker carrying that command's exit status. */
export function sentinelLine(shell: AgentShell, nonce: string, platform: NodeJS.Platform = process.platform): string {
  if (shell === 'powershell') return `Write-Host "__KAI_DONE_${nonce}_$(if ($?) {0} else {1})__"`;
  if (shell === 'cmd' && platform === 'win32') return `echo __KAI_DONE_${nonce}_%errorlevel%__`;
  return `printf '\\n__KAI_DONE_${nonce}_%s__\\n' "$?"`;
}

export function sentinelPattern(nonce: string): RegExp {
  return new RegExp(`__KAI_DONE_${nonce}_(\\d+)__`);
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()][A-Za-z0-9]|\u001b[=>]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '').replace(/\r(?!\n)/g, '\n').replace(/\r\n/g, '\n');
}

/**
 * What the command printed, without the shell's echo of what was typed. The marker line is typed along with the
 * command, so the shell echoes it (behind a prompt) before the real marker arrives; everything from that echo on goes,
 * and so does the echo of the command's own first line.
 */
export function cleanOutput(text: string, nonce: string, command: string): string {
  const marker = text.indexOf(`__KAI_DONE_${nonce}`);
  // What stands in front of the echoed marker is the prompt and the start of the typed marker line. Dropped by what
  // it says, not by where the line ends: cmd prints the next prompt on the same line as the command's last output.
  const kept = marker >= 0 ? text.slice(0, marker).replace(/(?:\$ |> ?)(?:printf '\\n|Write-Host "|echo )$/, '') : text;
  const lines = kept.split('\n');
  const first = command.split(/\r?\n/)[0]!.trim().slice(0, 30);
  // A fresh session prints a banner and prompt before the command is echoed; none of that is the command's output.
  const echoed = first ? lines.findIndex((line) => line.includes(first)) : -1;
  if (echoed >= 0) lines.splice(0, echoed + 1);
  return lines.join('\n').trim();
}

function tail(text: string, limit: number): string {
  return text.length > limit ? `[earlier output cut]\n${text.slice(-limit)}` : text;
}

export class AgentTerminal {
  /** One reusable session per shell and folder, so `cd` and environment carry from one command to the next. */
  private readonly reusable = new Map<string, string>();

  constructor(
    private readonly terminal: AgentTerminalPort,
    private readonly context: AgentTerminalContext,
    private readonly shells: () => AgentShell[] = () => availableShells(),
  ) {
    this.terminal.onExit((id) => {
      for (const [key, sessionId] of this.reusable) if (sessionId === id) this.reusable.delete(key);
    });
  }

  shellsAvailable(): AgentShell[] {
    return this.shells();
  }

  async start(input: { shell?: AgentShell; cwd?: string }): Promise<TerminalSession & { shell: TerminalShell }> {
    const shell = this.pickShell(input.shell);
    const project = await this.context.activeProject();
    const cwd = input.cwd?.trim() || project?.path;
    if (!cwd) throw new Error('No project is open, so there is no folder to start in. Pass `cwd`, or open a project in KAI.');
    const session = this.terminal.start(project?.id ?? 'agent', cwd, managerShell(shell), 120, 30, null, { agent: true });
    // A plain one-line prompt, so what comes back is the command's output and not the person's prompt theme.
    const setup = promptSetup(shell);
    if (setup) this.terminal.write(session.id, `${setup}\r`);
    return session;
  }

  async run(input: { command: string; shell?: AgentShell; cwd?: string; sessionId?: string; timeoutMs?: number }): Promise<RunResult> {
    const command = input.command.trim();
    if (!command) throw new Error('`command` is empty.');
    const timeoutMs = Math.min(Math.max(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS);
    const session = await this.sessionFor(input);
    const shell = this.shellOf(session);
    const nonce = randomBytes(3).toString('hex');
    const pattern = sentinelPattern(nonce);
    let seen = '';
    return new Promise<RunResult>((resolve) => {
      let finished = false;
      const finish = (exitCode: number | null, timedOut: boolean): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        stopOutput();
        stopExit();
        const text = cleanOutput(stripAnsi(seen), nonce, command);
        resolve({ sessionId: session.id, shell, exitCode, timedOut, output: tail(text, MAX_OUTPUT_CHARS) });
      };
      const stopOutput = this.terminal.onOutput((id, data) => {
        if (id !== session.id) return;
        seen += data;
        const match = pattern.exec(stripAnsi(seen));
        if (match) finish(Number(match[1]), false);
      });
      const stopExit = this.terminal.onExit((id) => { if (id === session.id) finish(null, false); });
      const timer = setTimeout(() => finish(null, true), timeoutMs);
      // One write, command first and the marker line after it, so the marker reports that command's status.
      this.terminal.write(session.id, `${command}\r${sentinelLine(shell, nonce)}\r`);
    });
  }

  read(sessionId: string, maxChars = 8_000): string {
    const buffer = this.terminal.buffer(sessionId);
    if (buffer === null) throw new Error(`There is no terminal session ${sessionId}. It may have exited; list the sessions or start a new one.`);
    return tail(stripAnsi(buffer), Math.min(Math.max(maxChars, 200), MAX_OUTPUT_CHARS));
  }

  /** Raw keystrokes, for a prompt a command stopped on. End a line with `\r` to press Enter. */
  write(sessionId: string, input: string): void {
    if (!this.terminal.write(sessionId, input)) throw new Error(`There is no terminal session ${sessionId}.`);
  }

  stop(sessionId: string): void {
    if (!this.terminal.stop(sessionId)) throw new Error(`There is no terminal session ${sessionId}.`);
  }

  list(): Array<TerminalSession & { byAgent: boolean }> {
    return this.terminal.list().map((session) => ({ ...session, byAgent: session.agent === true }));
  }

  private pickShell(requested: AgentShell | undefined): AgentShell {
    const available = this.shells();
    const shell = requested ?? defaultShell(available);
    if (!available.includes(shell)) {
      throw new Error(`${shell} is not available here. Installed shells: ${available.join(', ') || 'none'}.`);
    }
    return shell;
  }

  private shellOf(session: TerminalSession): AgentShell {
    return session.shell === 'default' ? 'cmd' : session.shell;
  }

  private async sessionFor(input: { shell?: AgentShell; cwd?: string; sessionId?: string }): Promise<TerminalSession> {
    if (input.sessionId) {
      const existing = this.terminal.get(input.sessionId);
      if (!existing) throw new Error(`There is no terminal session ${input.sessionId}. It may have exited; start a new one.`);
      return existing;
    }
    const shell = this.pickShell(input.shell);
    const project = await this.context.activeProject();
    const cwd = input.cwd?.trim() || project?.path || '';
    const key = `${shell}|${cwd}`;
    const kept = this.reusable.get(key);
    const live = kept ? this.terminal.get(kept) : null;
    if (live) return live;
    const started = await this.start({ shell, ...(cwd ? { cwd } : {}) });
    this.reusable.set(key, started.id);
    return started;
  }
}

/**
 * Tells an agent that KAI's own terminal is there and that the choice of shell is its own. Left unsaid, a CLI agent
 * falls back on whatever shell it ships with, or opens a window outside KAI that nobody can see or type into.
 */
export function terminalBriefing(executionMode: 'cli' | 'api', available: readonly AgentShell[]): string {
  const shells = available.join(', ');
  const toolNames = executionMode === 'cli'
    ? 'the `kai-terminal` MCP server (`terminal_run`, `terminal_start`, `terminal_read`, `terminal_write`, `terminal_list`, `terminal_stop`)'
    : 'the `kai-terminal` tools (`terminal_run`, `terminal_start`, `terminal_read`, `terminal_write`, `terminal_list`, `terminal_stop`)';
  return [
    '# KAI terminal',
    `KAI has its own terminal, offered through ${toolNames}. Commands run there happen in a session the person can watch in KAI's terminal dock and type into, and the session is reused so \`cd\` and exported variables carry over.`,
    `You may use it whenever it suits the work, and you may use any shell installed here (${shells}) — pick whichever fits the command rather than defaulting to one. Your own shell tool is fine too. Never open a separate terminal window, and never start a terminal application on the person's desktop.`,
    'A command that does not exit, such as a dev server, comes back with `timed_out: true` and keeps running; read it later with `terminal_read`, and stop it with `terminal_stop` when the work is done.',
  ].join('\n');
}
