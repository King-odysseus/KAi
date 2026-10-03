import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PreviewCandidate, PreviewInfo, PreviewState, PreviewStatus } from '@kai/contracts';

const MAX_OUTPUT = 20_000;
/** Enough of a Python entry file to see the framework and the name it binds, without reading a whole module. */
const MODULE_HEAD = 4_000;
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
  return nodePreviewCandidates(manifest)[0]?.command ?? null;
}

/** A Node script that serves something, as opposed to a watcher or a build step. */
const SERVER_SCRIPT = /\b(vite|next|nuxt|astro|remix|parcel|webpack|react-scripts|svelte|angular|electron|node|nodemon|tsx|ts-node|serve|http-server|live-server|bun|deno|uvicorn|gunicorn|manage\.py)\b/i;
const NOT_A_SERVER = /^(build|test|lint|check|typecheck|format|analyze|size|prepare|postinstall|prebuild)/i;
const NODE_SCRIPTS = ['dev', 'start', 'serve', 'preview'];

/** A known dev server, ahead of a script that merely looks like one. */
const SERVER_RANK = 2;
const MAYBE_RANK = 1;

/** The candidates package.json offers, the ones that serve something first. */
export function nodePreviewCandidates(manifest: string): PreviewCandidate[] {
  return rankedNodeCandidates(manifest).map(({ command, label }) => ({ command, label }));
}

function rankedNodeCandidates(manifest: string): (PreviewCandidate & { rank: number })[] {
  let parsed: { scripts?: Record<string, unknown> };
  try {
    parsed = JSON.parse(manifest) as { scripts?: Record<string, unknown> };
  } catch {
    return [];
  }
  const scripts = parsed.scripts ?? {};
  const names = Object.keys(scripts).filter((name) => typeof scripts[name] === 'string' && (scripts[name] as string).trim());
  const serves = (name: string): boolean => SERVER_SCRIPT.test(scripts[name] as string);
  const named = NODE_SCRIPTS.filter((name) => names.includes(name));
  // A project can call its server anything, so a script the body gives away counts too, unless it reads like a build.
  const others = names.filter((name) => !named.includes(name) && serves(name) && !NOT_A_SERVER.test(name));
  // Anything that looks like a server comes before a script that is only called "dev": a project that runs a watcher
  // beside its real server should not be previewed as the watcher.
  const order = [...named.filter(serves), ...others, ...named.filter((name) => !serves(name))];
  return order.map((name) => ({ command: `npm run ${name}`, label: `npm run ${name}`, rank: serves(name) ? SERVER_RANK : MAYBE_RANK }));
}

export interface PythonHints {
  hasManagePy: boolean;
  /** requirements.txt, pyproject.toml and Pipfile, joined. */
  dependencies: string;
  /** The Python files at the project root, with the head of each. */
  modules: { name: string; source: string }[];
}

/**
 * The ways this project's own files say to start it. Django leaves manage.py behind; FastAPI and Flask name the
 * module and the variable to serve, so the command can be exact rather than a guess.
 */
export function pythonPreviewCandidates(hints: PythonHints): PreviewCandidate[] {
  const found: PreviewCandidate[] = [];
  if (hints.hasManagePy) found.push({ command: 'python manage.py runserver', label: 'Django' });
  const dependencies = hints.dependencies.toLowerCase();
  const asgi = hints.modules.find((module) => /=\s*FastAPI\s*\(/.test(module.source)) ?? (/\b(uvicorn|fastapi)\b/.test(dependencies) ? hints.modules.find((module) => /^(main|app|asgi)\.py$/.test(module.name)) : undefined);
  if (asgi) found.push({ command: `python -m uvicorn ${target(asgi, 'FastAPI')} --reload`, label: 'FastAPI' });
  const flask = hints.modules.find((module) => /=\s*Flask\s*\(/.test(module.source));
  if (flask) found.push({ command: `python -m flask --app ${target(flask, 'Flask')} run`, label: 'Flask' });
  return found;
}

/** `main:app` for a module that says `app = FastAPI(...)`, which is what uvicorn and the flask CLI both expect. */
function target(module: { name: string; source: string }, framework: string): string {
  const variable = new RegExp(`(\\w+)\\s*=\\s*${framework}\\s*\\(`).exec(module.source)?.[1] ?? 'app';
  return `${module.name.replace(/\.py$/, '')}:${variable}`;
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
    const candidates = await detectPreviewCandidates(projectPath);
    return {
      available: candidates.length > 0,
      command: candidates[0]?.command ?? '',
      candidates,
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
    if (!command) throw new Error('No start command was found. Enter the command that starts this project.');

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

/** Every way this project says to start it, best first. */
export async function detectPreviewCandidates(projectPath: string): Promise<PreviewCandidate[]> {
  const [manifest, managePy, dependencies, pythonFiles] = await Promise.all([
    readIfPresent(path.join(projectPath, 'package.json')),
    fs.access(path.join(projectPath, 'manage.py')).then(() => true, () => false),
    Promise.all(['requirements.txt', 'pyproject.toml', 'Pipfile'].map((name) => readIfPresent(path.join(projectPath, name)))),
    fs.readdir(projectPath).then((names) => names.filter((name) => name.endsWith('.py')), () => [] as string[]),
  ]);
  const modules = await Promise.all(pythonFiles.map(async (name) => ({ name, source: (await readIfPresent(path.join(projectPath, name)))?.slice(0, MODULE_HEAD) ?? '' })));
  const python = pythonPreviewCandidates({ hasManagePy: managePy, dependencies: dependencies.filter(Boolean).join('\n'), modules });
  return [...rankedNodeCandidates(manifest ?? ''), ...python.map((candidate) => ({ ...candidate, rank: SERVER_RANK }))]
    .sort((first, second) => second.rank - first.rank)
    .map(({ command, label }) => ({ command, label }));
}

async function detectPreviewCommand(projectPath: string): Promise<string | null> {
  return (await detectPreviewCandidates(projectPath))[0]?.command ?? null;
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
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
    message: command ? null : 'No start command was detected. Enter the command that starts this project.',
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
