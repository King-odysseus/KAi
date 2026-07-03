import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

export interface ProxyStatus {
  running: boolean;
  port: number;
  pid?: number;
  uptimeMs?: number;
  error?: string;
}

export interface ProxyManagerEvents {
  status: [ProxyStatus];
}

export class ProxyManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private startTime: number = 0;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private port: number;
  private command: string;

  constructor(port: number, command = 'node') {
    super();
    this.port = port;
    this.command = command;
  }

  async start(proxyScriptPath: string): Promise<ProxyStatus> {
    if (this.process) {
      return this.getStatus();
    }

    return new Promise((resolve) => {
      this.process = spawn(this.command, [proxyScriptPath], {
        env: { ...process.env, PROXY_PORT: String(this.port) },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      this.startTime = Date.now();

      this.process.on('error', (err) => {
        const status: ProxyStatus = {
          running: false,
          port: this.port,
          error: `Proxy process failed: ${err.message}`,
        };
        this.process = null;
        this.emit('status', status);
        resolve(status);
      });

      this.process.on('exit', (code) => {
        const status: ProxyStatus = {
          running: false,
          port: this.port,
          error: code !== 0 ? `Proxy exited with code ${code}` : undefined,
        };
        this.process = null;
        this.stopHealthCheck();
        this.emit('status', status);
      });

      // Give the process a moment to start, then report
      setTimeout(() => {
        this.startHealthCheck();
        const status = this.getStatus();
        this.emit('status', status);
        resolve(status);
      }, 1500);
    });
  }

  async stop(): Promise<void> {
    this.stopHealthCheck();

    if (!this.process) {
      return;
    }

    return new Promise((resolve) => {
      const proc = this.process!;
      proc.on('exit', () => resolve());
      proc.kill('SIGTERM');

      // Force kill after 5s
      setTimeout(() => {
        if (this.process) {
          this.process.kill('SIGKILL');
          resolve();
        }
      }, 5000);
    });
  }

  getStatus(): ProxyStatus {
    if (!this.process) {
      return { running: false, port: this.port };
    }

    return {
      running: true,
      port: this.port,
      pid: this.process.pid,
      uptimeMs: Date.now() - this.startTime,
    };
  }

  async health(): Promise<{ available: boolean; detail: string }> {
    if (!this.process) {
      return { available: false, detail: 'Proxy not running.' };
    }

    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) {
        return { available: true, detail: `Proxy healthy on :${this.port}.` };
      }
      return { available: false, detail: `Proxy responded ${response.status}.` };
    } catch {
      return { available: false, detail: `Proxy unreachable on :${this.port}.` };
    }
  }

  private startHealthCheck(): void {
    this.stopHealthCheck();
    this.healthTimer = setInterval(() => {
      void this.health().then((result) => {
        if (!result.available && this.process) {
          this.emit('status', this.getStatus());
        }
      });
    }, 30000);
  }

  private stopHealthCheck(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  override on<E extends keyof ProxyManagerEvents>(event: E, listener: (...args: ProxyManagerEvents[E]) => void): this {
    return super.on(event, listener);
  }

  override emit<E extends keyof ProxyManagerEvents>(event: E, ...args: ProxyManagerEvents[E]): boolean {
    return super.emit(event, ...args);
  }
}
