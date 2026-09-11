import { spawn } from 'child_process';

/**
 * Quote an argument for cmd.exe. When spawning with `shell: true` on Windows,
 * Node joins args with spaces WITHOUT quoting, so any arg containing spaces or
 * shell metacharacters (e.g. a multi-word prompt) would be split into separate
 * tokens. Wrapping such args in double quotes keeps them as a single argument.
 */
export function quoteWinArg(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

export interface CommandInfo {
  available: boolean;
  version?: string;
  detail?: string;
}

export interface ProcessChunk {
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ProcessRunner {
  commandInfo(command: string): Promise<CommandInfo>;
  run(
    command: string,
    args: string[],
    cwd?: string,
    signal?: AbortSignal,
    stdin?: string,
  ): AsyncIterable<ProcessChunk | ProcessResult>;
}

export class NodeProcessRunner implements ProcessRunner {
  /** Max time to wait for `<command> --version`. A CLI that hangs (e.g. drops
   * into an interactive prompt or waits on stdin) must never block the panel. */
  private static readonly VERSION_TIMEOUT_MS = 5000;

  async commandInfo(command: string): Promise<CommandInfo> {
    return new Promise((resolve) => {
      const child = spawn(command, ['--version'], { shell: process.platform === 'win32', windowsHide: true });
      let output = '';
      let error = '';
      let settled = false;
      const finish = (info: CommandInfo) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(info);
      };
      // Guarantee the promise always resolves so getCapabilities() can't hang.
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        finish({ available: false, detail: `${command} --version timed out` });
      }, NodeProcessRunner.VERSION_TIMEOUT_MS);
      // Don't let a spawned probe keep the event loop / host alive.
      timer.unref?.();

      child.stdout?.on('data', (chunk) => { output += chunk.toString(); });
      child.stderr?.on('data', (chunk) => { error += chunk.toString(); });
      child.on('error', (err) => finish({ available: false, detail: err.message }));
      child.on('close', (code) => {
        if (code === 0) {
          finish({ available: true, version: output.trim() || undefined });
        } else {
          finish({ available: false, detail: (error || output || `Exited with ${code}`).trim() });
        }
      });
    });
  }

  async *run(
    command: string,
    args: string[],
    cwd?: string,
    signal?: AbortSignal,
    stdin?: string,
  ): AsyncIterable<ProcessChunk | ProcessResult> {
    const useShell = process.platform === 'win32';
    // Under shell mode Node does not quote args, so quote them ourselves to keep
    // multi-word arguments (e.g. the prompt) intact.
    const spawnCommand = useShell ? quoteWinArg(command) : command;
    const spawnArgs = useShell ? args.map(quoteWinArg) : args;
    const child = spawn(spawnCommand, spawnArgs, {
      cwd,
      shell: useShell,
      windowsHide: true,
      env: process.env,
    });

    if (stdin !== undefined) {
      child.stdin?.write(stdin);
      child.stdin?.end();
    }

    const queue: Array<ProcessChunk | ProcessResult> = [];
    let done = false;
    let notify: (() => void) | undefined;

    const push = (item: ProcessChunk | ProcessResult) => {
      queue.push(item);
      notify?.();
      notify = undefined;
    };
    const abort = () => {
      if (!child.killed) {
        child.kill();
      }
    };

    signal?.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', (chunk) => push({ stream: 'stdout', text: chunk.toString() }));
    child.stderr?.on('data', (chunk) => push({ stream: 'stderr', text: chunk.toString() }));
    child.on('error', (error) => {
      push({ stream: 'stderr', text: error.message });
      done = true;
      push({ code: 1, signal: null });
    });
    child.on('close', (code, closeSignal) => {
      signal?.removeEventListener('abort', abort);
      done = true;
      push({ code, signal: closeSignal });
    });

    while (!done || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => { notify = resolve; });
        continue;
      }
      yield queue.shift()!;
    }
  }
}

export function isProcessResult(value: ProcessChunk | ProcessResult): value is ProcessResult {
  return 'code' in value;
}
