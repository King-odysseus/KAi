import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultSettings, type AgentRunRequest } from '../packages/contracts/src';
import { DesktopDirectProviderRuntime, streamIdleTimeout } from '../apps/desktop/src/main/direct-provider-runtime';
import { modelFetch, ModelHostError, type ModelFetchOptions, type ModelTiming, type ModelWaitStatus } from '../apps/desktop/src/main/model-transport';

const servers: http.Server[] = [];
const folders: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

interface Seen {
  url: string;
  body: Record<string, unknown> | undefined;
}

type Handler = (response: http.ServerResponse, seen: Seen, index: number) => void;

/** A stand-in for the gateway: `/v1/...` is the model, anything else is a status route. */
async function gateway(model: Handler, status?: Handler): Promise<{ root: string; url: string; sends: Seen[] }> {
  const sends: Seen[] = [];
  let statusChecks = 0;
  const server = http.createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      const seen: Seen = { url: request.url ?? '', body: raw ? JSON.parse(raw) as Record<string, unknown> : undefined };
      if (seen.url.startsWith('/v1/')) {
        sends.push(seen);
        model(response, seen, sends.length - 1);
        return;
      }
      if (status) status(response, seen, statusChecks++);
      else { response.writeHead(404); response.end(); }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind.');
  const root = `http://127.0.0.1:${address.port}`;
  return { root, url: `${root}/v1/chat/completions`, sends };
}

const ok: Handler = (response) => { response.writeHead(200, { 'Content-Type': 'text/plain' }); response.end('done'); };
const json = (response: http.ServerResponse, code: number, value: unknown): void => {
  response.writeHead(code, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
};

const FAST: Partial<ModelTiming> = {
  pollMs: 10,
  quietNoticeMs: 20,
  busyDelaysMs: [10, 10],
  queueFullDelaysMs: [10],
  queueFullMaxMs: 25,
  reconnectDelayMs: 5,
  relayCutMs: 150,
};

function post(url: string, options: Partial<ModelFetchOptions> = {}, signal: AbortSignal = new AbortController().signal): Promise<Response> {
  return modelFetch(
    url,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gateway/coding' }), signal },
    { host: 'own-hardware', timing: FAST, ...options },
  );
}

async function failure(pending: Promise<unknown>): Promise<ModelHostError> {
  const error = await pending.then(() => new Error('The request succeeded.'), (reason: unknown) => reason);
  expect(error).toBeInstanceOf(ModelHostError);
  return error as ModelHostError;
}

describe('model transport: the person\'s own hardware', () => {
  it('waits for a queued request, shows its place, and sends it once', async () => {
    const statuses: ModelWaitStatus[] = [];
    const server = await gateway(
      (response, seen, index) => { setTimeout(() => ok(response, seen, index), 120); },
      (response, _seen, index) => json(response, 200, { status: 'queued', position: index < 3 ? 2 : 1 }),
    );
    const response = await post(server.url, { statusRoot: server.root, onStatus: (status) => statuses.push(status) });

    expect(await response.text()).toBe('done');
    expect(server.sends).toHaveLength(1);
    expect(server.sends[0]!.body?.gateway_request_id).toMatch(/^kai-/);
    expect(statuses.map((status) => `${status.state}:${status.position ?? ''}`)).toEqual(['queued:2', 'queued:1', 'running:']);
  });

  it('says the Mac may be busy when there is no status route, without adding a request id', async () => {
    const statuses: ModelWaitStatus[] = [];
    const server = await gateway((response, seen, index) => { setTimeout(() => ok(response, seen, index), 60); });
    await (await post(server.url, { onStatus: (status) => statuses.push(status) })).text();

    expect(server.sends).toHaveLength(1);
    expect(server.sends[0]!.body).not.toHaveProperty('gateway_request_id');
    expect(statuses[0]?.detail).toMatch(/may be busy/);
  });

  it('keeps waiting when the status route does not exist', async () => {
    const server = await gateway((response, seen, index) => { setTimeout(() => ok(response, seen, index), 100); });
    expect(await (await post(server.url, { statusRoot: server.root })).text()).toBe('done');
    expect(server.sends).toHaveLength(1);
  });

  it('tries a 503 again after a wait, then says why it stopped', async () => {
    const recovering = await gateway((response, seen, index) => {
      if (index < 2) json(response, 503, { error: { message: 'already swapping heavily' } });
      else ok(response, seen, index);
    });
    expect(await (await post(recovering.url)).text()).toBe('done');
    expect(recovering.sends).toHaveLength(3);

    const stuck = await gateway((response) => json(response, 503, { error: { message: 'already swapping heavily' } }));
    const error = await failure(post(stuck.url));
    expect(error.kind).toBe('busy');
    expect(error.message).toContain('already swapping heavily');
    expect(stuck.sends).toHaveLength(3);
  });

  it('waits out a full queue and gives up only after the longest wait', async () => {
    const full = { error: { code: 'model_queue_full' } };
    const draining = await gateway((response, seen, index) => { if (index === 0) json(response, 429, full); else ok(response, seen, index); });
    expect(await (await post(draining.url)).text()).toBe('done');
    expect(draining.sends).toHaveLength(2);

    const stuck = await gateway((response) => json(response, 429, full));
    expect((await failure(post(stuck.url))).kind).toBe('queue-full');
    expect(stuck.sends).toHaveLength(4);
  });

  it('hands any other 429 back to the caller with its body', async () => {
    const server = await gateway((response) => json(response, 429, { error: { message: 'slow down' } }));
    const response = await post(server.url);
    expect(response.status).toBe(429);
    expect(await response.text()).toContain('slow down');
    expect(server.sends).toHaveLength(1);
  });

  it('treats the relay\'s own time limit as "busy" and does not send again', async () => {
    const timedOut = await gateway((response) => { setTimeout(() => { response.writeHead(504); response.end(); }, 200); });
    expect((await failure(post(timedOut.url))).message).toMatch(/relay/);
    expect(timedOut.sends).toHaveLength(1);

    const cut = await gateway((response) => { setTimeout(() => response.destroy(), 200); });
    expect((await failure(post(cut.url))).kind).toBe('busy');
    expect(cut.sends).toHaveLength(1);
  });

  it('does not send again after a drop while the gateway still holds the request', async () => {
    const server = await gateway(
      (response) => { setTimeout(() => response.destroy(), 20); },
      (response) => json(response, 200, { status: 'queued', position: 1 }),
    );
    expect((await failure(post(server.url, { statusRoot: server.root }))).kind).toBe('dropped');
    expect(server.sends).toHaveLength(1);
  });

  it('sends once more after a drop when the gateway no longer holds the request', async () => {
    const server = await gateway((response, seen, index) => { if (index === 0) response.destroy(); else ok(response, seen, index); });
    expect(await (await post(server.url, { statusRoot: server.root })).text()).toBe('done');
    expect(server.sends).toHaveLength(2);
    expect(server.sends[1]!.body?.gateway_request_id).not.toBe(server.sends[0]!.body?.gateway_request_id);
  });

  it('stops waiting when the gateway reports the request failed', async () => {
    const server = await gateway(
      () => undefined,
      (response) => json(response, 200, { status: 'failed', detail: 'model would not load' }),
    );
    const error = await failure(post(server.url, { statusRoot: server.root }));
    expect(error.message).toContain('model would not load');
    expect(server.sends).toHaveLength(1);
  });

  it('can be cancelled while it waits, and while the reply streams', async () => {
    const silent = await gateway(() => undefined);
    const waiting = new AbortController();
    const pending = post(silent.url, {}, waiting.signal);
    setTimeout(() => waiting.abort(), 40);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(silent.sends).toHaveLength(1);

    const streaming = await gateway((response) => { response.writeHead(200); response.write('part'); });
    const reading = new AbortController();
    const response = await post(streaming.url, {}, reading.signal);
    const reader = response.body!.getReader();
    await reader.read();
    setTimeout(() => reading.abort(), 20);
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('survives a cancelled reply, and reports one cut off half way', async () => {
    const endless = await gateway((response) => { response.writeHead(200); response.write('part'); });
    const cancelled = await post(endless.url);
    await cancelled.body!.cancel();

    const halfway = await gateway((response) => { response.writeHead(200); response.write('part', () => setTimeout(() => response.destroy(), 20)); });
    await expect((await post(halfway.url)).text()).rejects.toThrow();
  });

  it('delivers a large reply whole', async () => {
    const text = 'x'.repeat(2_000_000);
    const server = await gateway((response) => { response.writeHead(200); response.end(text); });
    expect((await (await post(server.url)).text()).length).toBe(text.length);
  });

  it('reports a server that is not there the way fetch does', async () => {
    const server = await gateway(ok);
    const url = server.url;
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
    await expect(post(url)).rejects.toThrow('fetch failed');
  });

  it('tells the person when the gateway has no record of the request, and keeps waiting', async () => {
    const statuses: ModelWaitStatus[] = [];
    const server = await gateway((response, seen, index) => { setTimeout(() => ok(response, seen, index), 150); });
    expect(await (await post(server.url, { statusRoot: server.root, onStatus: (status) => statuses.push(status) })).text()).toBe('done');
    expect(statuses[0]?.detail).toMatch(/no record of this request/);
    expect(server.sends).toHaveLength(1);
  });

  it('reads the gateway\'s own status words, and shows no position of 0', async () => {
    const statuses: ModelWaitStatus[] = [];
    const words = [{ status: 'queued', position: 2, detail: '' }, { status: 'preparing', position: 0, detail: '' }, { status: 'running', position: 0, detail: 'Generating.' }, { status: 'done', position: 0 }];
    const server = await gateway(
      (response, seen, index) => { setTimeout(() => ok(response, seen, index), 150); },
      (response, _seen, index) => json(response, 200, words[Math.min(index, words.length - 1)]),
    );
    await (await post(server.url, { statusRoot: server.root, onStatus: (status) => statuses.push(status) })).text();

    expect(statuses.slice(0, 3)).toEqual([
      { state: 'queued', position: 2 },
      { state: 'queued', detail: 'Preparing the model.' },
      { state: 'running', detail: 'Generating.' },
    ]);
    expect(statuses.every((status) => !String(status.detail ?? '').includes('done'))).toBe(true);
  });

  it('takes a queued request out of the queue when the person stops it', async () => {
    const methods: string[] = [];
    const server = http.createServer((incoming, response) => {
      incoming.resume();
      if (!incoming.url!.startsWith('/v1/')) {
        methods.push(`${incoming.method} ${incoming.headers.authorization}`);
        json(response, 200, { status: 'queued', position: 1 });
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const root = `http://127.0.0.1:${address.port}`;
    const stop = new AbortController();
    const pending = post(`${root}/v1/chat/completions`, { statusRoot: root, apiKey: 'test-key' }, stop.signal);
    setTimeout(() => stop.abort(), 50);

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect.poll(() => methods.includes('DELETE Bearer test-key')).toBe(true);
  });

  it('does not ask again when the gateway cannot route the request', async () => {
    const server = await gateway((response) => json(response, 409, { error: { code: 'routing_error', message: 'coder unavailable' } }));
    expect((await failure(post(server.url))).message).toContain('coder unavailable');
    expect(server.sends).toHaveLength(1);
  });

  it('shows a status word it does not recognise', async () => {
    const statuses: ModelWaitStatus[] = [];
    const server = await gateway(
      (response, seen, index) => { setTimeout(() => ok(response, seen, index), 80); },
      (response) => json(response, 200, { status: 'deferred' }),
    );
    await (await post(server.url, { statusRoot: server.root, onStatus: (status) => statuses.push(status) })).text();
    expect(statuses[0]?.detail).toContain('"deferred"');
  });

  it('gives a server on this computer two more tries after a drop', async () => {
    const twice = await gateway((response, seen, index) => { if (index < 2) response.destroy(); else ok(response, seen, index); });
    expect(await (await post(twice.url, { host: 'this-computer' })).text()).toBe('done');
    expect(twice.sends).toHaveLength(3);

    const always = await gateway((response) => response.destroy());
    await expect(post(always.url, { host: 'this-computer' })).rejects.toThrow('fetch failed');
    expect(always.sends).toHaveLength(3);
  });

  it('allows a longer silence inside a reply from the person\'s own models only', () => {
    expect(streamIdleTimeout({})).toBe(500_000);
    expect(streamIdleTimeout({ host: 'cloud' })).toBe(500_000);
    expect(streamIdleTimeout({ host: 'own-hardware' })).toBe(1_800_000);
    expect(streamIdleTimeout({ host: 'this-computer' })).toBe(1_800_000);
  });

  it('leaves a cloud request\'s status for the caller to handle', async () => {
    const server = await gateway((response) => json(response, 503, {}));
    expect((await post(server.url, { host: 'cloud' })).status).toBe(503);
    expect(server.sends).toHaveLength(1);
  });
});

describe('model transport: the agent loop', () => {
  function runtimeFor(baseUrl: string): DesktopDirectProviderRuntime {
    const settings = createDefaultSettings();
    settings.gatewayOwnHardware = true;
    settings.directApi = { enabled: true, provider: 'openai-compatible', model: 'gateway/coding', baseUrl: 'https://relay.invalid/v1', credentialId: 'provider.custom' };
    return new DesktopDirectProviderRuntime(
      { load: async () => settings },
      { isAvailable: () => true, has: async () => true, get: async () => 'test-key' },
      undefined,
      {
        retryBaseDelayMs: 1,
        modelTiming: FAST,
        resolveGatewayAddress: async () => ({ baseUrl, label: 'home' }),
      },
    );
  }

  const request: AgentRunRequest = { conversationId: 'conv-transport', prompt: 'Say hello', agent: 'codex', execution: 'api', route: 'direct', autonomy: 'ask' };

  function project(): string {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-transport-'));
    folders.push(folder);
    return folder;
  }

  it('uses the resolved address and adds no retries of its own to a busy Mac', async () => {
    const server = await gateway((response) => json(response, 503, { error: { message: 'already swapping heavily' } }));
    const result = await runtimeFor(`${server.root}/v1`).run(request, project());

    expect(result.status).toBe('failed');
    expect(result.error).toContain('already swapping heavily');
    // Two waits in the timing above, so three sends; the loop's own three attempts must not multiply them.
    expect(server.sends).toHaveLength(3);
    expect(result.events.some((event) => event.type === 'agent.lifecycle' && JSON.stringify(event).includes('at its home address'))).toBe(true);
  });
});
