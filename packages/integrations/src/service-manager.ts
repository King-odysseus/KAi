import { spawn, type ChildProcess } from 'node:child_process';
import type { ServiceKind, ServiceState, ServiceStatus } from '@kai/contracts';

export interface ServiceLaunchSpec {
  kind: ServiceKind;
  label: string;
  version: string;
  commit: string;
  endpoint: string;
  healthPath: string;
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
  onLog?: (stream: 'stdout' | 'stderr', line: string) => void;
}

interface ManagedProcess {
  spec: ServiceLaunchSpec;
  child: ChildProcess;
  exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stopping: boolean;
  exited: boolean;
  ready: boolean;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 8_000;

export class ServiceManager {
  private readonly processes = new Map<ServiceKind, ManagedProcess>();
  private readonly states = new Map<ServiceKind, ServiceState>();

  constructor(
    private readonly now: () => Date = () => new Date(),
    /** Called when a service that had become ready exits without being stopped. */
    private readonly onUnexpectedExit?: (kind: ServiceKind, detail: string) => void,
  ) {}

  getState(kind: ServiceKind): ServiceState {
    return (
      this.states.get(kind) ?? {
        kind,
        status: 'not_configured',
        detail: 'Not configured.',
        endpoint: null,
        version: null,
        updatedAt: this.now().toISOString(),
      }
    );
  }

  async start(spec: ServiceLaunchSpec): Promise<ServiceState> {
    const existing = this.processes.get(spec.kind);
    if (existing && !existing.exited) return this.getState(spec.kind);

    this.setState(spec.kind, 'starting', `Starting ${spec.label}.`, spec);
    const child = spawn(spec.executable, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      windowsHide: true,
      detached: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const record = createManagedProcess(spec, child);
    this.processes.set(spec.kind, record);
    this.attachProcess(record);

    if (spec.stdin !== undefined && child.stdin) {
      child.stdin.end(spec.stdin);
    } else {
      child.stdin?.end();
    }

    try {
      await this.waitUntilReady(record);
      record.ready = true;
      this.setState(spec.kind, 'ready', `${spec.label} is ready.`, spec);
      return this.getState(spec.kind);
    } catch (error) {
      this.setState(spec.kind, 'failed', messageOf(error), spec);
      await this.stop(spec.kind).catch(() => undefined);
      this.setState(spec.kind, 'failed', messageOf(error), spec);
      throw error;
    }
  }

  async stop(kind: ServiceKind): Promise<ServiceState> {
    const record = this.processes.get(kind);
    if (!record || record.exited) {
      this.processes.delete(kind);
      this.setState(kind, 'stopped', 'Service is stopped.', record?.spec);
      return this.getState(kind);
    }

    record.stopping = true;
    this.setState(kind, 'stopping', `Stopping ${record.spec.label}.`, record.spec);
    record.child.kill('SIGTERM');
    const exit = await Promise.race([
      record.exitPromise,
      delay(record.spec.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS).then(() => null),
    ]);
    if (exit === null && !record.exited) {
      record.child.kill('SIGKILL');
      await Promise.race([record.exitPromise, delay(2_000)]);
    }

    this.processes.delete(kind);
    this.setState(kind, 'stopped', 'Service is stopped.', record.spec);
    return this.getState(kind);
  }

  async restart(spec: ServiceLaunchSpec): Promise<ServiceState> {
    if (this.processes.has(spec.kind)) await this.stop(spec.kind);
    return this.start(spec);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.processes.keys()].map((kind) => this.stop(kind)));
  }

  private attachProcess(record: ManagedProcess): void {
    record.child.once('exit', (code, signal) => {
      record.exited = true;
      if (record.stopping) return;
      const detail = `Process exited${code === null ? '' : ` with code ${code}`}${signal ? ` (${signal})` : ''}.`;
      this.setState(record.spec.kind, 'failed', detail, record.spec);
      if (record.ready) this.onUnexpectedExit?.(record.spec.kind, detail);
    });
    record.child.once('error', (error) => {
      record.exited = true;
      this.setState(record.spec.kind, 'failed', messageOf(error), record.spec);
    });
    pipeLines(record.child.stdout, (line) => record.spec.onLog?.('stdout', line));
    pipeLines(record.child.stderr, (line) => record.spec.onLog?.('stderr', line));
  }

  private async waitUntilReady(record: ManagedProcess): Promise<void> {
    const timeoutMs = record.spec.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const healthUrl = new URL(record.spec.healthPath, record.spec.endpoint).toString();

    while (Date.now() < deadline) {
      if (record.exited) {
        throw new Error(`${record.spec.label} exited before its health check passed.`);
      }
      if (await healthCheck(healthUrl)) return;
      await delay(250);
    }
    throw new Error(`${record.spec.label} did not become ready within ${timeoutMs}ms.`);
  }

  private setState(kind: ServiceKind, status: ServiceStatus, detail: string, spec?: ServiceLaunchSpec): void {
    const previous = this.states.get(kind);
    this.states.set(kind, {
      kind,
      status,
      detail,
      endpoint: spec?.endpoint ?? previous?.endpoint ?? null,
      version: spec?.version ?? previous?.version ?? null,
      updatedAt: this.now().toISOString(),
    });
  }
}

function createManagedProcess(spec: ServiceLaunchSpec, child: ChildProcess): ManagedProcess {
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    let settled = false;
    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      resolve({ code, signal });
    };
    child.once('exit', settle);
    child.once('error', () => settle(null, null));
  });
  return { spec, child, exitPromise, stopping: false, exited: false, ready: false };
}

function pipeLines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  if (!stream) return;
  let buffered = '';
  stream.on('data', (chunk: Buffer | string) => {
    buffered += chunk.toString();
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) onLine(line.trim());
    }
  });
  stream.on('end', () => {
    if (buffered.trim()) onLine(buffered.trim());
  });
}

async function healthCheck(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
