import { execFile, spawn } from 'node:child_process';
import * as net from 'node:net';

/**
 * One Playwright browser for every agent.
 *
 * Each agent CLI used to start its own Playwright server, and KAI's own checks started one more, so several agents at
 * once meant several servers and several browser windows. This starts a single server, visible, that all of them are
 * pointed at: one window, with a tab for each agent, so the work can still be watched and nothing multiplies.
 *
 * The server is the same `@playwright/mcp` the agents used on their own, run in its HTTP mode with a browser context
 * that every client shares. It is a child of KAI, so quitting KAI ends it with the rest of the process tree.
 */

/** Pinned, so every agent talks to the version this was tested with and not whatever was published last. */
export const PLAYWRIGHT_MCP_VERSION = '0.0.83';
export const PLAYWRIGHT_HOST_PORT = 8931;
/** A first start downloads the package, which can take a while on a slow connection. */
const START_TIMEOUT_MS = 90_000;
const POLL_MS = 500;

export interface PlaywrightHost {
  /** The URL every agent connects to. */
  endpoint: string;
  port: number;
  /** True when a server was already answering there and KAI is sharing it rather than starting its own. */
  adopted: boolean;
  /** Ends the server KAI started. Does nothing to one it adopted. */
  close(): Promise<void>;
}

/** The part of a child process the host needs, so tests can stand in for one. */
export interface PlaywrightChild {
  pid: number | undefined;
  onExit(listener: (code: number | null) => void): void;
  onOutput(listener: (text: string) => void): void;
}

export interface PlaywrightHostPorts {
  launch(port: number, extraArgs: readonly string[], environment?: Readonly<Record<string, string>>): PlaywrightChild;
  killTree(child: PlaywrightChild): Promise<void>;
  portIsFree(port: number): Promise<boolean>;
  anyFreePort(): Promise<number>;
  /** Whether a Playwright MCP server answers at the endpoint. */
  answers(endpoint: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface PlaywrightHostOptions {
  preferredPort?: number;
  timeoutMs?: number;
  /** Extra server flags, for a test that should not open a window. */
  extraArgs?: readonly string[];
  /** Per-server environment, used for a local MCP config without putting paths into a shell command. */
  environment?: Readonly<Record<string, string>>;
  /** Told when a server KAI started stops after it was ready, so the loss is logged rather than silent. */
  onStopped?: (code: number | null) => void;
}

export function playwrightEndpoint(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

/**
 * The server's arguments. It is bound to the IPv4 loopback explicitly: its default of `localhost` resolves to IPv6
 * only on some machines, which a client that tries 127.0.0.1 cannot reach. The allowed hosts name both spellings,
 * since the server refuses a request whose Host header is not on the list.
 */
export function playwrightServerArgs(port: number, extraArgs: readonly string[] = []): string[] {
  return [
    '-y',
    `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`,
    '--host', '127.0.0.1',
    '--allowed-hosts', `127.0.0.1:${port},localhost:${port}`,
    '--port', String(port),
    '--shared-browser-context',
    ...extraArgs,
  ];
}

/** The command that starts the server. On Windows `npx` is a script, so it goes through the command interpreter. */
export function playwrightLaunchCommand(port: number, platform: NodeJS.Platform, extraArgs: readonly string[] = []): { command: string; args: string[] } {
  const args = playwrightServerArgs(port, extraArgs);
  return platform === 'win32'
    ? { command: 'cmd.exe', args: ['/d', '/s', '/c', ['npx', ...args].join(' ')] }
    : { command: 'npx', args };
}

export async function startPlaywrightHost(ports: PlaywrightHostPorts, options: PlaywrightHostOptions = {}): Promise<PlaywrightHost> {
  const preferred = options.preferredPort ?? PLAYWRIGHT_HOST_PORT;

  // A server already answering is the shared browser, left by an earlier launch. Using it is the point.
  if (await ports.answers(playwrightEndpoint(preferred))) {
    return { endpoint: playwrightEndpoint(preferred), port: preferred, adopted: true, close: async () => undefined };
  }

  const port = (await ports.portIsFree(preferred)) ? preferred : await ports.anyFreePort();
  const endpoint = playwrightEndpoint(port);
  const child = ports.launch(port, options.extraArgs ?? [], options.environment);

  let output = '';
  let exited: number | null | undefined;
  let ready = false;
  child.onOutput((text) => { output = `${output}${text}`.slice(-2_000); });
  child.onExit((code) => {
    exited = code;
    if (ready) options.onStopped?.(code);
  });

  const deadline = ports.now() + (options.timeoutMs ?? START_TIMEOUT_MS);
  for (;;) {
    if (exited !== undefined) {
      throw new Error(`The shared browser server stopped (exit ${exited ?? 'unknown'}) before it was ready.${tail(output)}`);
    }
    if (await ports.answers(endpoint)) break;
    if (ports.now() >= deadline) {
      await ports.killTree(child);
      throw new Error(`The shared browser server did not answer within ${Math.round((options.timeoutMs ?? START_TIMEOUT_MS) / 1000)} seconds.${tail(output)}`);
    }
    await ports.sleep(POLL_MS);
  }
  ready = true;
  return { endpoint, port, adopted: false, close: () => ports.killTree(child) };
}

function tail(output: string): string {
  const text = output.trim();
  return text ? ` Its last output: ${text.slice(-400)}` : '';
}

// --- The real ports --------------------------------------------------------------------------------------------

export function realPlaywrightHostPorts(platform: NodeJS.Platform = process.platform): PlaywrightHostPorts {
  return {
    launch(port, extraArgs, environment) {
      const { command, args } = playwrightLaunchCommand(port, platform, extraArgs);
      // `windowsHide` hides the console of the launcher, not the browser the server opens: that window is the point.
      const child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: platform !== 'win32',
        ...(environment ? { env: { ...process.env, ...environment } } : {}),
      });
      return {
        pid: child.pid,
        onExit: (listener) => { child.once('exit', listener); },
        onOutput: (listener) => {
          child.stdout?.on('data', (chunk: Buffer) => listener(chunk.toString('utf8')));
          child.stderr?.on('data', (chunk: Buffer) => listener(chunk.toString('utf8')));
        },
      };
    },

    killTree(child) {
      const pid = child.pid;
      if (!pid) return Promise.resolve();
      if (platform === 'win32') {
        // Ends the launcher, the server and the browser it opened. Failing because it is already gone is fine.
        return new Promise((resolve) => { execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve()); });
      }
      try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
      return Promise.resolve();
    },

    portIsFree: (port) => new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    }),

    anyFreePort: () => new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        server.close(() => (address && typeof address === 'object' ? resolve(address.port) : reject(new Error('No free port.'))));
      });
    }),

    async answers(endpoint) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'kai-probe', version: '1' } },
          }),
          signal: AbortSignal.timeout(2_500),
        });
        const text = await response.text();
        // Asking opened a session. End it, so a probe made every half second does not leave a pile of them behind.
        const session = response.headers.get('mcp-session-id');
        if (session) void fetch(endpoint, { method: 'DELETE', headers: { 'mcp-session-id': session }, signal: AbortSignal.timeout(2_000) }).catch(() => undefined);
        return response.ok && /playwright/i.test(text);
      } catch {
        return false;
      }
    },

    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}
