import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PreviewInfo, PreviewState, PreviewStatus } from '@kai/contracts';

const MAX_OUTPUT = 20_000;
const URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^\s]*)?/i;

interface PreviewSession {
  projectId: string;
  cwd: string;
  command: string;
  child: ChildProcess;
  status: PreviewStatus;
  url: string | null;
  outputTail: string;
  startedAt: string | null;
  exitCode: number | null;
  message: string | null;
}

export function previewCommandFromPackage(manifest: string): string | null {
  let parsed: { scripts?: Record<string, unknown> };
  try {
    parsed = JSON.parse(manifest) as { scripts?: Record<string, unknown> };
  } catch {
    return null;
  }
  const scripts = parsed.scripts ?? {};
  const script = ['dev', 'start', 'serve', 'preview'].find((name) => typeof scripts[name] === 'string' && scripts[name]!.trim());
  return script ? `npm run ${script}` : null;
}

export function previewUrlFromOutput(output: string): string | null {
  const clean = output.replace(/\u001b\[[0-9;]*m/g, '');
  const match = URL_PATTERN.exec(clean);
  if (!match) return null;
  return match[0].replace(/[),.;]+$/, '');
}

export class PreviewRuntime {
  private readonly sessions = new Map<string, PreviewSession>();

  constructor(private readonly preloadPath: string) {}

  async info(projectPath: string): Promise<PreviewInfo> {
    const command = await detectPreviewCommand(projectPath);
    return {
      available: Boolean(command),
      command: command ?? '',
      preloadPath: this.preloadPath,
      suggestedUrl: null,
    };
  }

  async status(projectId: string, projectPath: string): Promise<PreviewState> {
    const session = this.sessions.get(projectId);
    if (!session) return stoppedState(projectId, await detectPreviewCommand(projectPath));
    return publicState(session);
  }

  async start(projectId: string, projectPath: string, requestedCommand?: string): Promise<PreviewState> {
    await this.stop(projectId, projectPath);
    const command = requestedCommand?.trim() || await detectPreviewCommand(projectPath);
    if (!command) throw new Error('No dev script was found. Enter the command that starts this project.');

    const child = spawn(command, {
      cwd: projectPath,
      shell: true,
      windowsHide: true,
      env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const session: PreviewSession = {
      projectId,
      cwd: projectPath,
      command,
      child,
      status: 'starting',
      url: null,
      outputTail: '',
      startedAt: new Date().toISOString(),
      exitCode: null,
      message: 'Starting the project and waiting for a local URL.',
    };
    this.sessions.set(projectId, session);
    const append = (chunk: Buffer): void => {
      session.outputTail = (session.outputTail + chunk.toString('utf8')).slice(-MAX_OUTPUT);
      const discovered = previewUrlFromOutput(session.outputTail);
      if (discovered && discovered !== session.url) {
        session.url = discovered;
        session.status = 'running';
        session.message = null;
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.once('error', (error) => {
      session.status = 'failed';
      session.message = error.message;
      session.exitCode = null;
    });
    child.once('close', (code) => {
      if (this.sessions.get(projectId) !== session) return;
      session.exitCode = code;
      session.status = code === 0 ? 'stopped' : 'failed';
      session.message = code === 0 ? 'The dev server stopped.' : `The dev server exited with code ${code ?? 'unknown'}.`;
    });
    return publicState(session);
  }

  async stop(projectId: string, projectPath: string): Promise<PreviewState> {
    const session = this.sessions.get(projectId);
    if (!session) return stoppedState(projectId, await detectPreviewCommand(projectPath));
    this.sessions.delete(projectId);
    await terminateProcess(session.child);
    return {
      ...publicState(session),
      status: 'stopped',
      message: 'Preview stopped.',
    };
  }

  async stopAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((session) => terminateProcess(session.child)));
  }
}

async function detectPreviewCommand(projectPath: string): Promise<string | null> {
  try {
    return previewCommandFromPackage(await fs.readFile(path.join(projectPath, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

function stoppedState(projectId: string, command: string | null): PreviewState {
  return {
    projectId,
    status: 'stopped',
    command: command ?? '',
    url: null,
    outputTail: '',
    startedAt: null,
    exitCode: null,
    message: command ? null : 'No package dev script was detected. Enter a command to start the project.',
  };
}

function publicState(session: PreviewSession): PreviewState {
  return {
    projectId: session.projectId,
    status: session.status,
    command: session.command,
    url: session.url,
    outputTail: session.outputTail,
    startedAt: session.startedAt,
    exitCode: session.exitCode,
    message: session.message,
  };
}

async function terminateProcess(child: ChildProcess): Promise<void> {
  if (!child.pid || child.killed || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('close', () => resolve());
      killer.once('error', () => resolve());
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}
