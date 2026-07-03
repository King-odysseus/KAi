import { spawn } from 'child_process';

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
  run(command: string, args: string[], cwd?: string, signal?: AbortSignal): AsyncIterable<ProcessChunk | ProcessResult>;
}

export class NodeProcessRunner implements ProcessRunner {
  async commandInfo(command: string): Promise<CommandInfo> {
    return new Promise((resolve) => {
      const child = spawn(command, ['--version'], { shell: process.platform === 'win32', windowsHide: true });
      let output = '';
      let error = '';
      child.stdout?.on('data', (chunk) => { output += chunk.toString(); });
      child.stderr?.on('data', (chunk) => { error += chunk.toString(); });
      child.on('error', (err) => resolve({ available: false, detail: err.message }));
      child.on('close', (code) => {
        if (code === 0) {
          resolve({ available: true, version: output.trim() || undefined });
        } else {
          resolve({ available: false, detail: (error || output || `Exited with ${code}`).trim() });
        }
      });
    });
  }

  async *run(command: string, args: string[], cwd?: string, signal?: AbortSignal): AsyncIterable<ProcessChunk | ProcessResult> {
    const child = spawn(command, args, {
      cwd,
      shell: process.platform === 'win32',
      windowsHide: true,
      env: process.env
    });

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
