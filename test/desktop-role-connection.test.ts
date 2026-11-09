import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultSettings, type AgentRunRequest, type AppSettings } from '../packages/contracts/src';
import { DesktopDirectProviderRuntime } from '../apps/desktop/src/main/direct-provider-runtime';

/**
 * "Implementation runs through the selected API": a run that names its own connection must talk to that connection,
 * with that connection's key and model, whatever Settings happens to say.
 */

const servers: http.Server[] = [];
const tempProjects: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const dir of tempProjects.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Seen { url?: string; authorization?: string; body?: Record<string, unknown> }

function openAiCompatible(models: string[], seen: Seen[], reply = 'Done.'): http.Server {
  return http.createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      seen.push({ url: request.url, authorization: request.headers.authorization, ...(raw ? { body: JSON.parse(raw) as Record<string, unknown> } : {}) });
      if (request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', data: models.map((id) => ({ id, object: 'model' })) }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply }, finish_reason: null }] })}\n\n`);
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
    });
  });
}

async function listen(server: http.Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind.');
  return `http://127.0.0.1:${address.port}/v1`;
}

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-role-'));
  tempProjects.push(dir);
  return dir;
}

/** Settings that point somewhere else entirely, with the direct API switched off. */
function settingsElsewhere(): AppSettings {
  const settings = createDefaultSettings();
  settings.directApi = { ...settings.directApi, enabled: false, provider: 'openai', model: 'gpt-6-astra', baseUrl: 'http://127.0.0.1:9/v1', credentialId: 'provider.openai' };
  return settings;
}

const vault = (keys: Record<string, string>) => ({
  isAvailable: () => true,
  has: async (id: string) => id in keys,
  get: async (id: string) => keys[id],
});

const base: Omit<AgentRunRequest, 'apiConnection'> = {
  conversationId: 'conv-role', prompt: 'Build it', agent: 'claude', execution: 'api', route: 'direct', autonomy: 'full',
};

describe('a run that names its own API connection', () => {
  it('goes to that server with that model, even though Settings points elsewhere and has the API off', async () => {
    const seen: Seen[] = [];
    const baseUrl = await listen(openAiCompatible(['qwen2.5-coder'], seen, 'Built by the local model.'));
    const runtime = new DesktopDirectProviderRuntime({ load: async () => settingsElsewhere() }, vault({}));

    const result = await runtime.run(
      { ...base, apiConnection: { provider: 'ollama', baseUrl, model: 'qwen2.5-coder' } },
      project(),
    );

    expect(result).toMatchObject({ status: 'completed', output: 'Built by the local model.' });
    const chat = seen.find((entry) => entry.url === '/v1/chat/completions')!;
    expect(chat.body).toMatchObject({ model: 'qwen2.5-coder', stream: true });
    // Nothing went to the Settings address (port 9 refuses connections, so a stray call would have failed the run).
    expect(result.events.find((event) => event.type === 'cost.update')).toMatchObject({ provider: 'ollama', amountUsd: 0 });
  });

  it('uses the role\'s own saved key, not the provider\'s default one', async () => {
    const seen: Seen[] = [];
    const baseUrl = await listen(openAiCompatible(['some-model'], seen));
    const runtime = new DesktopDirectProviderRuntime(
      { load: async () => settingsElsewhere() },
      vault({ 'provider.vllm': 'default-key', 'provider.vllm-work': 'work-key' }),
    );

    await runtime.run({ ...base, apiConnection: { provider: 'vllm', baseUrl, credentialId: 'provider.vllm-work', model: 'some-model' } }, project());
    await runtime.run({ ...base, conversationId: 'conv-role-2', apiConnection: { provider: 'vllm', baseUrl, model: 'some-model' } }, project());

    const chats = seen.filter((entry) => entry.url === '/v1/chat/completions');
    expect(chats.map((entry) => entry.authorization)).toEqual(['Bearer work-key', 'Bearer default-key']);
  });

  it('lets two runs use two different servers at the same time', async () => {
    const seenA: Seen[] = [];
    const seenB: Seen[] = [];
    const a = await listen(openAiCompatible(['model-a'], seenA, 'from A'));
    const b = await listen(openAiCompatible(['model-b'], seenB, 'from B'));
    const runtime = new DesktopDirectProviderRuntime({ load: async () => settingsElsewhere() }, vault({}));

    const [first, second] = await Promise.all([
      runtime.run({ ...base, conversationId: 'c-a', apiConnection: { provider: 'ollama', baseUrl: a, model: 'model-a' } }, project()),
      runtime.run({ ...base, conversationId: 'c-b', apiConnection: { provider: 'llamacpp', baseUrl: b, model: 'model-b' } }, project()),
    ]);

    expect(first.output).toBe('from A');
    expect(second.output).toBe('from B');
    expect(seenA.find((entry) => entry.url === '/v1/chat/completions')!.body).toMatchObject({ model: 'model-a' });
    expect(seenB.find((entry) => entry.url === '/v1/chat/completions')!.body).toMatchObject({ model: 'model-b' });
  });

  it('keeps a role\'s model over the composer\'s, and the composer\'s when the role has none', async () => {
    const seen: Seen[] = [];
    const baseUrl = await listen(openAiCompatible(['role-model', 'composer-model'], seen));
    const runtime = new DesktopDirectProviderRuntime({ load: async () => settingsElsewhere() }, vault({}));

    await runtime.run({ ...base, model: 'composer-model', apiConnection: { provider: 'ollama', baseUrl, model: 'role-model' } }, project());
    await runtime.run({ ...base, conversationId: 'conv-2', model: 'composer-model', apiConnection: { provider: 'ollama', baseUrl } }, project());

    const models = seen.filter((entry) => entry.url === '/v1/chat/completions').map((entry) => entry.body?.model);
    expect(models).toEqual(['role-model', 'composer-model']);
  });

  it('says which server to start when a local role is not running', async () => {
    const runtime = new DesktopDirectProviderRuntime({ load: async () => settingsElsewhere() }, vault({}));

    const ollama = await runtime.capability({ provider: 'ollama', baseUrl: 'http://127.0.0.1:9/v1', model: 'm' });
    expect(ollama.available).toBe(false);
    expect(ollama.unavailableReason).toMatch(/Ollama \(local models\) is not reachable at http:\/\/127\.0\.0\.1:9\/v1\. Start Ollama/);

    const llama = await runtime.capability({ provider: 'llamacpp', baseUrl: 'http://127.0.0.1:9/v1', model: 'm' });
    expect(llama.unavailableReason).toMatch(/llama-server/);

    const vllm = await runtime.capability({ provider: 'vllm', baseUrl: 'http://127.0.0.1:9/v1', model: 'm' });
    expect(vllm.unavailableReason).toMatch(/vllm serve/);

    const result = await runtime.run({ ...base, apiConnection: { provider: 'ollama', baseUrl: 'http://127.0.0.1:9/v1', model: 'm' } }, project());
    expect(result.status).toBe('failed');
    expect(result.error).toContain('not reachable');
  });

  it('refuses a paid provider with no saved key instead of borrowing another', async () => {
    const runtime = new DesktopDirectProviderRuntime({ load: async () => settingsElsewhere() }, vault({ 'provider.openai': 'the-openai-key' }));
    const capability = await runtime.capability({ provider: 'anthropic', model: 'claude-opus-5-5' });
    expect(capability).toMatchObject({ available: false, provider: 'anthropic', credentialId: 'provider.anthropic' });
    expect(capability.unavailableReason).toContain('provider.anthropic');
    const result = await runtime.run({ ...base, apiConnection: { provider: 'anthropic', model: 'claude-opus-5-5' } }, project());
    expect(result.status).toBe('failed');
  });

  it('is unchanged for a run with no connection of its own', async () => {
    const seen: Seen[] = [];
    const baseUrl = await listen(openAiCompatible(['settings-model'], seen));
    const settings = createDefaultSettings();
    settings.directApi = { ...settings.directApi, enabled: true, provider: 'lmstudio', model: 'settings-model', baseUrl, credentialId: 'provider.lmstudio' };
    const runtime = new DesktopDirectProviderRuntime({ load: async () => settings }, vault({}));

    const result = await runtime.run(base, project());

    expect(result.status).toBe('completed');
    expect(seen.find((entry) => entry.url === '/v1/chat/completions')!.body).toMatchObject({ model: 'settings-model' });
  });
});
