import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  isVerificationCommand,
  parseTestCounts,
  verificationRunSchema,
  verificationStatuses,
  type VerificationOverview,
  type VerificationRun,
} from '@kai/contracts';
import { git, isGitRepo } from './checkpoints';

const MAX_HASHED_BYTES = 2_000_000;
const MAX_HISTORY = 50;
const OUTPUT_TAIL = 4_000;
const RUN_TIMEOUT_MS = 10 * 60_000;

export async function currentFileHashes(projectPath: string): Promise<Array<{ path: string; hash: string }> | null> {
  if (!(await isGitRepo(projectPath))) return null;
  let output: string;
  try {
    output = await git(projectPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  } catch {
    return null;
  }
  const paths = new Set<string>();
  const entries = output.split('\0').filter(Boolean);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const status = entry.slice(0, 2);
    paths.add(entry.slice(3));
    // A rename lists the old path as the next entry; it no longer exists on disk.
    if (status.includes('R') || status.includes('C')) index += 1;
  }
  const hashes: Array<{ path: string; hash: string }> = [];
  for (const relative of [...paths].sort()) {
    try {
      const target = path.join(projectPath, relative);
      const stats = await fs.stat(target);
      if (!stats.isFile() || stats.size > MAX_HASHED_BYTES) continue;
      hashes.push({ path: relative, hash: createHash('sha256').update(await fs.readFile(target)).digest('hex') });
    } catch {
      // Deleted files have nothing to hash and are simply not part of the verified set.
    }
  }
  return hashes;
}

async function headCommit(projectPath: string): Promise<string | null> {
  try {
    return (await git(projectPath, ['rev-parse', 'HEAD'])).trim() || null;
  } catch {
    return null;
  }
}

/** Suggest the project's test command from its manifest files. */
export async function suggestTestCommand(projectPath: string): Promise<string | null> {
  const has = async (name: string): Promise<boolean> => fs.access(path.join(projectPath, name)).then(() => true, () => false);
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(projectPath, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    if (manifest.scripts?.test) return 'npm test';
    if (manifest.scripts?.typecheck) return 'npm run typecheck';
    if (manifest.scripts?.lint) return 'npm run lint';
  } catch {
    // No usable package.json; try other ecosystems.
  }
  if (await has('Cargo.toml')) return 'cargo test';
  if (await has('go.mod')) return 'go test ./...';
  if (await has('pytest.ini') || await has('pyproject.toml') || await has('requirements.txt')) return 'python -m pytest';
  return null;
}

export class VerificationStore {
  constructor(private readonly directory: string) {}

  private fileFor(projectId: string): string {
    if (!/^[\w.-]+$/.test(projectId)) throw new Error('Invalid project id.');
    return path.join(this.directory, `${projectId}.json`);
  }

  async list(projectId: string): Promise<VerificationRun[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.fileFor(projectId), 'utf8')) as unknown[];
      return parsed.flatMap((item) => {
        const run = verificationRunSchema.safeParse(item);
        return run.success ? [run.data] : [];
      });
    } catch {
      return [];
    }
  }

  async add(run: VerificationRun): Promise<void> {
    const history = [run, ...(await this.list(run.projectId))].slice(0, MAX_HISTORY);
    await fs.mkdir(this.directory, { recursive: true });
    const target = this.fileFor(run.projectId);
    await fs.writeFile(`${target}.tmp`, JSON.stringify(history), 'utf8');
    await fs.rename(`${target}.tmp`, target);
  }
}

export async function verificationOverview(store: VerificationStore, projectId: string, projectPath: string): Promise<VerificationOverview> {
  const [history, hashes, suggestedCommand] = await Promise.all([
    store.list(projectId),
    currentFileHashes(projectPath),
    suggestTestCommand(projectPath),
  ]);
  const latest = history[0] ?? null;
  return {
    suggestedCommand,
    gitAvailable: hashes !== null,
    latest,
    files: verificationStatuses(latest, hashes ?? []),
    history,
  };
}

export interface RecordedCheck {
  command: string;
  source: 'user' | 'agent';
  exitCode: number | null;
  startedAt: Date;
  durationMs: number;
  output: string;
}

/** Store a finished check against the content of every currently changed file. */
export async function recordVerification(store: VerificationStore, projectId: string, projectPath: string, check: RecordedCheck): Promise<VerificationRun> {
  const counts = parseTestCounts(check.output);
  const run: VerificationRun = {
    id: randomUUID(),
    projectId,
    command: check.command.slice(0, 2_000),
    source: check.source,
    exitCode: check.exitCode,
    passed: check.exitCode === 0,
    startedAt: check.startedAt.toISOString(),
    durationMs: Math.round(check.durationMs),
    head: await headCommit(projectPath),
    files: (await currentFileHashes(projectPath)) ?? [],
    testsPassed: counts.passed,
    testsFailed: counts.failed,
    outputTail: check.output.slice(-OUTPUT_TAIL),
  };
  await store.add(run);
  return run;
}

/** Run a check command in the project. The caller must have the user's confirmation. */
export function runCheckCommand(projectPath: string, command: string, signal?: AbortSignal): Promise<RecordedCheck> {
  return new Promise((resolve) => {
    const startedAt = new Date();
    let output = '';
    const child = spawn(command, { cwd: projectPath, shell: true, windowsHide: true, signal, timeout: RUN_TIMEOUT_MS });
    const append = (chunk: Buffer): void => {
      output = (output + chunk.toString('utf8')).slice(-20_000);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const finish = (exitCode: number | null): void =>
      resolve({ command, source: 'user', exitCode, startedAt, durationMs: Date.now() - startedAt.getTime(), output });
    child.once('error', (error) => {
      output += `\n${error.message}`;
      finish(null);
    });
    child.once('close', (code) => finish(code));
  });
}

/** Checks an agent ran during a turn, found in its tool events, so they can be recorded too. */
export function agentChecksFromEvents(events: ReadonlyArray<{ type: string } & Record<string, unknown>>): RecordedCheck[] {
  const checks: RecordedCheck[] = [];
  for (const event of events) {
    // A failing check ends as a 'failed' tool call, and is exactly the result worth recording.
    if (event.type !== 'tool.call' || (event.status !== 'completed' && event.status !== 'failed')) continue;
    const input = event.input && typeof event.input === 'object' ? (event.input as Record<string, unknown>) : {};
    const command = typeof input.command === 'string' ? input.command : typeof input.cmd === 'string' ? input.cmd : '';
    if (!command || !isVerificationCommand(command)) continue;
    const output = event.output && typeof event.output === 'object' ? (event.output as Record<string, unknown>) : {};
    const exitCode = typeof output.exitCode === 'number' ? output.exitCode : typeof output.exit_code === 'number' ? output.exit_code : null;
    if (exitCode === null) continue;
    const text = [output.stdout, output.stderr, output.output].filter((part): part is string => typeof part === 'string').join('\n');
    checks.push({ command, source: 'agent', exitCode, startedAt: new Date(String(event.timestamp ?? Date.now())), durationMs: 0, output: text });
  }
  return checks;
}
