import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ipcChannels, type RemoteAccessSettings } from '../packages/contracts/src';

/**
 * The gateway reaches handlers through `../ipc`, which imports electron at module load. Nothing here
 * touches an Electron API; the stub only has to exist so the import resolves.
 */
vi.mock('electron', () => ({
  ipcMain: { handle: () => undefined },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  shell: {},
}));

const { REMOTE_ALLOWLIST, remoteScopeFor } = await import('../apps/desktop/src/main/remote/allowlist');
const { bearerToken, RemoteTokenStore, summarise, tokensMatch } = await import('../apps/desktop/src/main/remote/auth');
const { RemoteChannelDenied, RemoteDispatcher, RemoteWindowUnavailable } = await import('../apps/desktop/src/main/remote/dispatch');
const { isDroppableFrame, REMOTE_PUSH_CHANNELS, RemoteEventStream } = await import('../apps/desktop/src/main/remote/events');
const { parseStreamPosition, RemoteGateway, resolveBindAddress } = await import('../apps/desktop/src/main/remote/server');
const { DesktopWindowRegistry } = await import('../apps/desktop/src/main/desktop-windows');
type IpcRegistry = import('../apps/desktop/src/main/ipc').IpcRegistry;
type CredentialVault = import('../apps/desktop/src/main/credential-vault').CredentialVault;

/** A vault with the same surface the gateway uses, backed by a plain map instead of the OS keychain. */
function fakeVault(): CredentialVault {
  const entries = new Map<string, string>();
  return {
    isAvailable: () => true,
    has: async (id: string) => entries.has(id),
    get: async (id: string) => entries.get(id),
    set: async (id: string, value: string) => void entries.set(id, value),
    delete: async (id: string) => void entries.delete(id),
  } as unknown as CredentialVault;
}

/** A live-looking window; the registry only reads `webContents.id` and the two predicates below. */
function fakeWindow(id: number, focused: boolean) {
  return {
    webContents: { id, send: () => undefined },
    isDestroyed: () => false,
    isFocused: () => focused,
  } as never;
}

interface Harness {
  gateway: InstanceType<typeof RemoteGateway>;
  base: string;
  token: string;
  calls: Array<{ channel: string; input: unknown; ownerWindowId: number }>;
  /** The real registry, wired to the gateway the way `index.ts` wires it, so pushes can be driven. */
  windows: InstanceType<typeof DesktopWindowRegistry>;
}

const running: Array<{ dispose: () => Promise<void> }> = [];
const directories: string[] = [];

async function startGateway(options: {
  allow?: string[];
  liveWindows?: Array<{ id: number; focused: boolean }>;
  settings?: Partial<RemoteAccessSettings>;
  /** Where the built phone UI lives. Left out, the gateway has no bundle to serve at all. */
  mobileRoot?: string;
} = {}): Promise<Harness> {
  const calls: Harness['calls'] = [];
  const registry = {
    channels: () => [...ipcChannels],
    dispatch: async (channel: string, input: unknown, request: { ownerWindowId: number }) => {
      calls.push({ channel, input, ownerWindowId: request.ownerWindowId });
      return { channel, input, ownerWindowId: request.ownerWindowId };
    },
  } as unknown as IpcRegistry;

  const windows = new DesktopWindowRegistry();
  const descriptors = options.liveWindows ?? [{ id: 7, focused: true }];
  for (const entry of descriptors) windows.register(fakeWindow(entry.id, entry.focused), 'project-1');

  const credentials = fakeVault();
  const gateway = new RemoteGateway({
    credentials,
    dispatcher: new RemoteDispatcher(registry, windows),
    describeWindows: async () => descriptors.map((entry) => ({
      id: entry.id,
      projectId: 'project-1',
      projectName: 'KAI',
      conversationId: null,
      view: 'workspace',
      focused: entry.focused,
    })),
    subscribeWindowEvents: (subscriber) => windows.subscribe(subscriber),
    ...(options.mobileRoot ? { mobileRoot: options.mobileRoot } : {}),
    appName: 'KAI',
    version: '0.0.0-test',
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    settings: async () => ({ enabled: true, lanEnabled: false, port: 0, ...options.settings }),
  });
  running.push(gateway);
  await gateway.apply({ enabled: true, lanEnabled: false, port: 0, ...options.settings });
  const port = (await gateway.status()).port;
  const [device] = await new RemoteTokenStore(credentials).ensure();
  const token = device!.token;
  const base = `http://127.0.0.1:${port}`;
  return { gateway, base, token, calls, windows };
}

/** A request written by hand, so the target arrives exactly as typed instead of as a parsed URL. */
function rawGet(port: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${target} HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\nconnection: close\r\n\r\n`);
    });
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => { data += chunk; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

function post(base: string, token: string | null, body: unknown): Promise<Response> {
  return fetch(`${base}/api/ipc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((gateway) => gateway.dispose()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('remote allowlist', () => {
  it('is default-deny: an unlisted channel resolves to nothing', () => {
    // A shell, a sign-in and a project switch are all reachable from the desktop and none of them from
    // a phone, however valid the token is.
    expect(remoteScopeFor('terminal:start')).toBeNull();
    expect(remoteScopeFor('agents:install')).toBeNull();
    expect(remoteScopeFor('agents:sign-in')).toBeNull();
    expect(remoteScopeFor('files:write')).toBeNull();
    expect(remoteScopeFor('projects:choose')).toBeNull();
    expect(remoteScopeFor('workflows:start')).toBeNull();
    // Ends every run on the machine and clears what dead ones left behind. Pinned by name because it is the most
    // powerful write there is, and a phone holding a token should not be able to reach it.
    expect(remoteScopeFor('runs:stop-all')).toBeNull();
  });

  it('lists only channels that exist, so a typo cannot silently deny a route', () => {
    for (const channel of Object.keys(REMOTE_ALLOWLIST)) {
      expect(ipcChannels).toContain(channel);
    }
  });

  it('has exactly the reviewed write surface, so a new one cannot arrive unnoticed', () => {
    const writes = Object.entries(REMOTE_ALLOWLIST)
      .filter(([, scope]) => scope === 'write')
      .map(([channel]) => channel);
    // Adding to this list is a security decision with a stated threat next to it in allowlist.ts.
    expect(writes.sort()).toEqual([
      'agents:approval-response',
      'agents:cancel',
      'agents:pause',
      'agents:resume',
      'agents:run',
      'studio:board-claim',
      'studio:board-move',
      'workflows:resume',
      'workflows:stop',
    ]);
  });

  it('keeps every read reachable without a window, so a status screen never needs one', () => {
    const reads = Object.entries(REMOTE_ALLOWLIST)
      .filter(([, scope]) => scope === 'read')
      .map(([channel]) => channel);
    expect(reads).toContain('app:get-bootstrap');
    expect(reads).toContain('workflows:list-runs');
    expect(reads.every((channel) => ipcChannels.includes(channel as never))).toBe(true);
  });
});

describe('remote devices', () => {
  it('mints one device on first use and returns the same one after', async () => {
    const store = new RemoteTokenStore(fakeVault());
    const first = await store.ensure();
    expect(first).toHaveLength(1);
    expect(first[0]!.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await store.ensure())[0]!.token).toBe(first[0]!.token);
  });

  it('pairs a new device alongside the first instead of replacing it', async () => {
    const store = new RemoteTokenStore(fakeVault());
    const [first] = await store.ensure();
    const second = await store.create('Living room');
    expect(second.label).toBe('Living room');
    expect(second.token).not.toBe(first!.token);
    // Both tokens still resolve, which is the whole point of pairing rather than rotating.
    expect((await store.verify(first!.token))?.id).toBe(first!.id);
    expect((await store.verify(second.token))?.id).toBe(second.id);
    expect(await store.list()).toHaveLength(2);
  });

  it('revoking one device leaves the other working', async () => {
    const store = new RemoteTokenStore(fakeVault());
    const [first] = await store.ensure();
    const second = await store.create('Balcony');
    const remaining = await store.revoke(first!.id);
    expect(remaining.map((device) => device.id)).toEqual([second.id]);
    expect(await store.verify(first!.token)).toBeNull();
    expect((await store.verify(second.token))?.id).toBe(second.id);
  });

  it('adopts a token minted before per-device pairing, so an unpaired phone keeps working', async () => {
    const vault = fakeVault();
    await vault.set('remote.gateway.token', 'legacy-token-value');
    const store = new RemoteTokenStore(vault);
    const devices = await store.list();
    expect(devices).toHaveLength(1);
    expect(devices[0]!.token).toBe('legacy-token-value');
    // Persisting drops the legacy key, so the adopted token lives on only as a device.
    await store.ensure();
    expect(await vault.get('remote.gateway.token')).toBeUndefined();
    expect((await store.verify('legacy-token-value'))?.id).toBe(devices[0]!.id);
  });

  it('drops corrupt stored entries rather than trusting them', async () => {
    const vault = fakeVault();
    await vault.set('remote.gateway.devices', JSON.stringify([{ id: 'x' }, { id: 'y', label: 'ok', token: 't', createdAt: 'now' }]));
    const devices = await new RemoteTokenStore(vault).list();
    expect(devices.map((device) => device.id)).toEqual(['y']);
  });

  it('never lists a token', async () => {
    const store = new RemoteTokenStore(fakeVault());
    await store.create('Phone');
    for (const device of await store.list()) {
      expect(Object.keys(summarise(device)).sort()).toEqual(['createdAt', 'id', 'label']);
    }
  });

  it('compares without leaking length', () => {
    expect(tokensMatch('abc', 'abc')).toBe(true);
    expect(tokensMatch('abc', 'abd')).toBe(false);
    expect(tokensMatch('abc', 'abcdefghij')).toBe(false);
    expect(tokensMatch('', 'abc')).toBe(false);
  });

  it('reads only a well-formed bearer header', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer abc')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});

describe('bind address', () => {
  it('is loopback unless LAN is asked for', () => {
    expect(resolveBindAddress(false)).toBe('127.0.0.1');
  });

  it('never offers 0.0.0.0, even with LAN on', () => {
    const address = resolveBindAddress(true);
    expect(['0.0.0.0', '::', '::0']).not.toContain(address);
    if (address !== null) expect(address).toMatch(/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/);
  });
});

describe('remote gateway', () => {
  it('refuses a request with no token', async () => {
    const { base } = await startGateway();
    const response = await post(base, null, { channel: 'services:status' });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
  });

  it('refuses a request with the wrong token', async () => {
    const { base } = await startGateway();
    const response = await post(base, 'not-the-token', { channel: 'services:status' });
    expect(response.status).toBe(401);
  });

  it('runs an allowlisted channel and returns its output', async () => {
    const { base, token } = await startGateway();
    const response = await post(base, token, { channel: 'services:status', input: {} });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, data: { channel: 'services:status' } });
  });

  it('refuses a channel that is not on the allowlist', async () => {
    const { base, token, calls } = await startGateway();
    // `agents:run` is deliberately reachable from the phone; a shell is not, and never becomes so.
    const response = await post(base, token, { channel: 'terminal:start', input: {} });
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('acts as the focused window when none is named', async () => {
    const { base, token, calls } = await startGateway({ liveWindows: [{ id: 1, focused: false }, { id: 2, focused: true }] });
    await post(base, token, { channel: 'services:status' });
    expect(calls[0]?.ownerWindowId).toBe(2);
  });

  it('acts as the named window, so approvals land in the right project', async () => {
    const { base, token, calls } = await startGateway({ liveWindows: [{ id: 1, focused: false }, { id: 2, focused: true }] });
    await post(base, token, { channel: 'services:status', windowId: 1 });
    expect(calls[0]?.ownerWindowId).toBe(1);
  });

  it('refuses a window that is not open', async () => {
    const { base, token } = await startGateway();
    const response = await post(base, token, { channel: 'services:status', windowId: 99 });
    expect(response.status).toBe(503);
  });

  it('refuses an unparseable body before reaching a handler', async () => {
    const { base, token, calls } = await startGateway();
    const response = await fetch(`${base}/api/ipc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: 'not json',
    });
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('refuses a request from another origin', async () => {
    const { base, token } = await startGateway();
    const response = await fetch(`${base}/api/ipc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        origin: 'https://evil.example',
      },
      body: JSON.stringify({ channel: 'services:status' }),
    });
    expect(response.status).toBe(403);
  });

  it('reports status without handing out the token', async () => {
    const { base, token } = await startGateway();
    const response = await fetch(`${base}/api/status`, { headers: { authorization: `Bearer ${token}` } });
    const body = await response.json() as { ok: true; data: Record<string, unknown> };
    expect(body.data).toMatchObject({ enabled: true, running: true, lanEnabled: false, tokenSet: true, lastError: null });
    expect(JSON.stringify(body)).not.toContain(token);
  });

  it('describes the windows a phone can target', async () => {
    const { base, token } = await startGateway();
    const response = await fetch(`${base}/api/windows`, { headers: { authorization: `Bearer ${token}` } });
    expect(await response.json()).toMatchObject({ ok: true, data: [{ id: 7, projectName: 'KAI', focused: true }] });
  });

  it('has no route for anything else', async () => {
    const { base, token } = await startGateway();
    const response = await fetch(`${base}/api/nope`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(404);
  });

  it('stops listening when disabled, and toggles back on', async () => {
    const { gateway, base } = await startGateway();
    expect(gateway.isRunning()).toBe(true);
    await gateway.apply({ enabled: false, lanEnabled: false, port: 0 });
    expect(gateway.isRunning()).toBe(false);
    expect((await gateway.status()).running).toBe(false);
    await expect(fetch(`${base}/api/status`)).rejects.toThrow();
    await gateway.apply({ enabled: true, lanEnabled: false, port: 0 });
    expect(gateway.isRunning()).toBe(true);
  });

  it('reports a taken port as a status error rather than throwing at the caller', async () => {
    const first = await startGateway();
    const port = (await first.gateway.status()).port!;
    const second = await startGateway();
    await expect(second.gateway.apply({ enabled: true, lanEnabled: false, port })).rejects.toThrow();
    expect((await second.gateway.status()).lastError).toMatch(/EADDRINUSE|address already in use/i);
  });
});

describe('remote bundle', () => {
  /**
   * The build directory the gateway is pointed at in `index.ts`: the phone's page inside `mobile/`,
   * its scripts in the shared `assets/` one level up, and the desktop workbench's own page sitting
   * right there beside them.
   */
  async function bundleFixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kai-bundle-'));
    directories.push(root);
    await mkdir(join(root, 'mobile'), { recursive: true });
    await mkdir(join(root, 'assets'), { recursive: true });
    await writeFile(join(root, 'index.html'), '<!doctype html><title>KAI workbench</title>', 'utf8');
    await writeFile(join(root, 'mobile', 'index.html'), '<!doctype html><div id="root">phone</div>', 'utf8');
    await writeFile(join(root, 'assets', 'mobile-abc.js'), 'export const phone = true;\n', 'utf8');
    await writeFile(join(root, 'assets', 'mobile-abc.css'), '.phone { height: 100dvh; }\n', 'utf8');
    await writeFile(join(root, 'package.json'), '{"name":"kai-desktop"}', 'utf8');
    return root;
  }

  it('has nothing to serve until a renderer build has produced a bundle', async () => {
    const { base } = await startGateway();
    const response = await fetch(`${base}/mobile/`);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('is not built into this copy of the gateway');
  });

  it('sends a phone with no path to the phone page, keeping the pairing token on the link', async () => {
    const { base } = await startGateway({ mobileRoot: await bundleFixture() });
    for (const path of ['/', '/mobile', '/?token=abc123']) {
      const response = await fetch(`${base}${path}`, { redirect: 'manual' });
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(path === '/?token=abc123' ? '/mobile/?token=abc123' : '/mobile/');
    }
  });

  it('does not redirect the page it just sent a phone to', async () => {
    // `/mobile/` and `/mobile` differ only by the slash; folding them together would loop.
    const { base } = await startGateway({ mobileRoot: await bundleFixture() });
    const response = await fetch(`${base}/mobile/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('id="root"');
  });

  it('serves the phone page and its scripts without a token, so a phone can pair at all', async () => {
    const { base } = await startGateway({ mobileRoot: await bundleFixture() });
    const page = await fetch(`${base}/mobile/`);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    // The page must be re-read on every visit: it is what learns the version that is running.
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');

    const script = await fetch(`${base}/assets/mobile-abc.js`);
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    // Vite fingerprints everything under assets/, so only those may be cached past the next build.
    expect(script.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await script.text()).toContain('phone = true');

    const style = await fetch(`${base}/assets/mobile-abc.css`);
    expect(style.headers.get('content-type')).toBe('text/css; charset=utf-8');
  });

  it('hands a deep link back to the page, which routes it itself', async () => {
    const { base } = await startGateway({ mobileRoot: await bundleFixture() });
    const response = await fetch(`${base}/mobile/run/workflow_1`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('id="root"');
  });

  it('keeps the desktop workbench page in the same build directory to itself', async () => {
    const { base } = await startGateway({ mobileRoot: await bundleFixture() });
    // The workbench is not secret, but handing it to the LAN publishes an app that would sit there
    // inert without the preload bridge — and it is the one page the gateway is not for.
    for (const path of ['/index.html', '/package.json', '/mobile/../package.json']) {
      const response = await fetch(`${base}${path}`);
      expect(response.status, path).toBe(404);
      expect(await response.text()).not.toContain('kai-desktop');
    }
  });

  it('refuses to climb out of the bundle, even with the separator encoded', async () => {
    const { base } = await startGateway({ mobileRoot: await bundleFixture() });
    for (const path of ['/mobile/..%2f..%2fpackage.json', '/assets/%2e%2e/%2e%2e/package.json']) {
      const response = await fetch(`${base}${path}`);
      expect(response.status, path).toBe(404);
      expect(await response.text()).not.toContain('kai-desktop');
    }
  });

  it('refuses a traversal written straight into the request line', async () => {
    // A request line is not parsed as a URL before it reaches the gateway, so this is the shape a
    // hand-written or non-browser client can send. Every one of these has to end as a 404 with no file.
    const { base } = await startGateway({ mobileRoot: await bundleFixture() });
    const port = Number(new URL(base).port);
    for (const target of ['/mobile/../package.json', '/mobile/../../package.json', '/../package.json', '/assets/../package.json']) {
      const response = await rawGet(port, target);
      expect(response, target).toMatch(/^HTTP\/1\.1 404/);
      expect(response, target).not.toContain('kai-desktop');
    }
  });

  it('answers a missing script as a 404 rather than the page, which would only be a MIME error', async () => {
    const { base } = await startGateway({ mobileRoot: await bundleFixture() });
    const response = await fetch(`${base}/assets/gone-abc.js`);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.text()).toContain('NOT_FOUND');
  });

  it('leaves the API behind the token however the page is fetched', async () => {
    const { base, token } = await startGateway({ mobileRoot: await bundleFixture() });
    expect((await fetch(`${base}/api/status`)).status).toBe(401);
    // The query token is for the one client that cannot send a header, and for nothing else.
    expect((await fetch(`${base}/api/status?token=${token}`)).status).toBe(401);
    expect((await fetch(`${base}/api/status`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  });
});

describe('RemoteDispatcher', () => {
  it('denies before resolving a window, so a denied channel cannot probe for windows', async () => {
    const windows = new DesktopWindowRegistry();
    const dispatcher = new RemoteDispatcher({ channels: () => [], dispatch: async () => undefined } as unknown as IpcRegistry, windows);
    await expect(dispatcher.dispatch('files:write', {}, null)).rejects.toBeInstanceOf(RemoteChannelDenied);
  });

  it('reports a missing window distinctly from a denied channel', () => {
    const windows = new DesktopWindowRegistry();
    const dispatcher = new RemoteDispatcher({ channels: () => [], dispatch: async () => undefined } as unknown as IpcRegistry, windows);
    expect(() => dispatcher.resolveWindow(null)).toThrow(RemoteWindowUnavailable);
    expect(() => dispatcher.resolveWindow(42)).toThrow(RemoteWindowUnavailable);
  });
});

interface SseFrame {
  /** `<epoch>.<seq>`, or null on a frame the server sent without one. */
  id: string | null;
  event: string;
  data: Record<string, unknown>;
}

/** A reader for the live stream. Bodies are read by hand: Node has no `EventSource` to lean on. */
class SseClient {
  readonly frames: SseFrame[] = [];
  private failure: unknown = null;

  private constructor(private readonly response: Response, private readonly abort: AbortController) {
    void this.read();
  }

  static async connect(base: string, token: string | null, resume?: string): Promise<SseClient> {
    const headers: Record<string, string> = {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(resume === undefined ? {} : { 'last-event-id': resume }),
    };
    const abort = new AbortController();
    const response = await fetch(`${base}/api/events`, { headers, signal: abort.signal });
    return new SseClient(response, abort);
  }

  async status(): Promise<number> {
    return this.response.status;
  }

  headers(): Headers {
    return this.response.headers;
  }

  /** Waits for at least `count` frames, then a moment more, so a duplicate would have time to show up. */
  async waitFor(count: number, timeoutMs = 3000): Promise<SseFrame[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.frames.length < count && Date.now() < deadline) {
      if (this.failure) throw this.failure;
      await delay(10);
    }
    await delay(60);
    return this.frames;
  }

  close(): void {
    this.abort.abort();
  }

  private async read(): Promise<void> {
    try {
      const text = new TextDecoder();
      let buffer = '';
      for await (const chunk of this.response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += text.decode(chunk, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const frame = parseSseBlock(block);
          if (frame) this.frames.push(frame);
          boundary = buffer.indexOf('\n\n');
        }
      }
    } catch (error) {
      if (!this.abort.signal.aborted) this.failure = error;
    }
  }
}

function parseSseBlock(block: string): SseFrame | null {
  if (!block || block.startsWith(':')) return null;
  let id: string | null = null;
  let event = 'message';
  let data = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('id:')) id = line.slice(3).trim();
    else if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) return null;
  return { id, event, data: JSON.parse(data) as Record<string, unknown> };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function agentDelta(text: string): { conversationId: string; event: unknown } {
  return { conversationId: 'conversation-1', event: { type: 'text.delta', text } };
}

describe('remote live stream', () => {
  it('carries only channels the desktop really pushes, so a typo cannot silently mute the phone', () => {
    // Push channels are not request channels — they have no entry in `ipcChannels` — so the thing that
    // proves a name is real is the preload subscription the desktop itself listens on.
    const preload = readFileSync(new URL('../apps/desktop/src/preload/index.ts', import.meta.url), 'utf8');
    expect([...REMOTE_PUSH_CHANNELS].sort()).toEqual([
      'agents:event',
      'app:shared-state',
      'app:update-state',
      'studio:board-changed',
      'workflows:changed',
    ]);
    for (const channel of REMOTE_PUSH_CHANNELS) {
      expect(preload).toContain(`ipcRenderer.on('${channel}'`);
    }
  });

  it('authenticates like every other route', async () => {
    const { base } = await startGateway();
    const anonymous = await SseClient.connect(base, null);
    expect(await anonymous.status()).toBe(401);
    const wrong = await SseClient.connect(base, 'not-the-token');
    expect(await wrong.status()).toBe(401);
  });

  it('serves a stream, not a page, and does not let a proxy buffer it', async () => {
    const { base, token } = await startGateway();
    const client = await SseClient.connect(base, token);
    expect(await client.status()).toBe(200);
    expect(client.headers().get('content-type')).toContain('text/event-stream');
    expect(client.headers().get('cache-control')).toContain('no-store');
    expect(client.headers().get('x-accel-buffering')).toBe('no');
    client.close();
  });

  it('delivers a window push with the window it came from', async () => {
    const { base, token, windows } = await startGateway();
    const client = await SseClient.connect(base, token);
    windows.send(7, 'agents:event', agentDelta('hello'));
    const [frame] = await client.waitFor(1);
    expect(frame?.event).toBe('agents:event');
    expect(frame?.data.windowId).toBe(7);
    expect(frame?.data.payload).toEqual(agentDelta('hello'));
    client.close();
  });

  it('tags a broadcast as coming from every window', async () => {
    const { base, token, windows } = await startGateway();
    const client = await SseClient.connect(base, token);
    windows.broadcast('workflows:changed', { reason: 'save' });
    const [frame] = await client.waitFor(1);
    expect(frame?.data.windowId).toBeNull();
    client.close();
  });

  it('drops the renderer-only channels rather than forwarding the whole registry', async () => {
    const { base, token, windows } = await startGateway();
    const client = await SseClient.connect(base, token);
    windows.broadcast('terminal:data', { chunk: 'secret' });
    windows.broadcast('agents:event', agentDelta('kept'));
    const frames = await client.waitFor(1);
    expect(frames.map((frame) => frame.event)).toEqual(['agents:event']);
    client.close();
  });

  it('starts a fresh connection at the present rather than replaying the buffer', async () => {
    const { base, token, windows } = await startGateway();
    windows.broadcast('agents:event', agentDelta('before anyone was listening'));
    const client = await SseClient.connect(base, token);
    windows.broadcast('agents:event', agentDelta('after'));
    const frames = await client.waitFor(1);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.data.payload).toEqual(agentDelta('after'));
    client.close();
  });

  it('resumes from the last frame seen, with no gap and no duplicate', async () => {
    const { base, token, windows } = await startGateway();
    const first = await SseClient.connect(base, token);
    windows.broadcast('agents:event', agentDelta('one'));
    windows.broadcast('agents:event', agentDelta('two'));
    const seen = await first.waitFor(2);
    const resumeFrom = seen[1]?.id;
    expect(resumeFrom).toMatch(/^[0-9a-f-]{36}\.\d+$/);
    first.close();

    windows.broadcast('agents:event', agentDelta('missed while away'));
    const second = await SseClient.connect(base, token, resumeFrom ?? undefined);
    const replayed = await second.waitFor(1);
    expect(replayed.map((frame) => (frame.data.payload as { event: { text: string } }).event.text))
      .toEqual(['missed while away']);
    second.close();
  });

  it('asks a client from a previous run to resync instead of handing it frames', async () => {
    const { base, token, windows } = await startGateway();
    const client = await SseClient.connect(base, token, '11111111-2222-3333-4444-555555555555.4');
    const [frame] = await client.waitFor(1);
    expect(frame?.event).toBe('resync');
    expect(typeof frame?.data.reason).toBe('string');
    client.close();
  });

  it('survives a client that disappears mid-run', async () => {
    const { base, token, windows } = await startGateway();
    const client = await SseClient.connect(base, token);
    await client.waitFor(0);
    client.close();
    await delay(50);
    windows.broadcast('agents:event', agentDelta('after the phone slept'));
    const response = await fetch(`${base}/api/status`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
  });

  it('counts attached phones, so an idle gateway is visibly idle', async () => {
    const { base, token, gateway } = await startGateway();
    expect((await gateway.status()).connectedClients).toBe(0);
    const client = await SseClient.connect(base, token);
    await client.waitFor(0);
    expect((await gateway.status()).connectedClients).toBe(1);
    client.close();
    const deadline = Date.now() + 2000;
    while ((await gateway.status()).connectedClients > 0 && Date.now() < deadline) await delay(20);
    expect((await gateway.status()).connectedClients).toBe(0);
  });
});

describe('RemoteEventStream', () => {
  it('evicts old frames and reports a position it can no longer replay', () => {
    const stream = new RemoteEventStream(2);
    for (const text of ['one', 'two', 'three']) stream.record({ windowId: 1, channel: 'agents:event', payload: text });
    // Frame 1 is gone, so a client that stopped there has a gap it cannot be caught up on.
    expect(stream.since(0)).toBeNull();
    // A client that saw frame 1 is still fully served by what is held.
    expect(stream.since(1)?.map((frame) => frame.payload)).toEqual(['two', 'three']);
    expect(stream.since(2)?.map((frame) => frame.payload)).toEqual(['three']);
    expect(stream.since(3)).toEqual([]);
  });

  it('replays everything it still holds when a client is only slightly behind', () => {
    const stream = new RemoteEventStream();
    stream.record({ windowId: 1, channel: 'agents:event', payload: 'one' });
    stream.record({ windowId: 1, channel: 'agents:event', payload: 'two' });
    expect(stream.since(0)?.map((frame) => frame.seq)).toEqual([1, 2]);
  });

  it('only treats a live tail as droppable; a lifecycle event is never dropped', () => {
    expect(isDroppableFrame({ seq: 1, channel: 'agents:event', windowId: null, payload: agentDelta('x') })).toBe(true);
    expect(isDroppableFrame({ seq: 2, channel: 'agents:event', windowId: null, payload: { event: { type: 'turn.changes' } } })).toBe(false);
    expect(isDroppableFrame({ seq: 3, channel: 'workflows:changed', windowId: null, payload: agentDelta('x') })).toBe(false);
  });

  it('keeps serving the remaining clients when one listener throws', () => {
    const stream = new RemoteEventStream();
    const seen: number[] = [];
    stream.attach(() => {
      throw new Error('this client hung up badly');
    });
    stream.attach((frame) => void seen.push(frame.seq));
    stream.record({ windowId: null, channel: 'agents:event', payload: agentDelta('x') });
    expect(seen).toEqual([1]);
  });
});

describe('parseStreamPosition', () => {
  const epoch = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  it('treats a missing position as a fresh connection', () => {
    expect(parseStreamPosition(undefined, epoch)).toBe('fresh');
    expect(parseStreamPosition('', epoch)).toBe('fresh');
    expect(parseStreamPosition('   ', epoch)).toBe('fresh');
  });

  it('reads a position from this run', () => {
    expect(parseStreamPosition(`${epoch}.12`, epoch)).toBe(12);
    expect(parseStreamPosition([`${epoch}.0`], epoch)).toBe(0);
  });

  it('refuses a position from another run or one that is not a position', () => {
    expect(parseStreamPosition('99999999-0000-0000-0000-000000000000.12', epoch)).toBe('stale');
    expect(parseStreamPosition('12', epoch)).toBe('stale');
    expect(parseStreamPosition(`${epoch}.`, epoch)).toBe('stale');
    expect(parseStreamPosition(`${epoch}.later`, epoch)).toBe('stale');
    expect(parseStreamPosition(`${epoch}.-1`, epoch)).toBe('stale');
  });
});
