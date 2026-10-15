import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DIRECT_PROVIDER_ORDER,
  createDefaultSettings,
  directProviderPreset,
  isLocalProvider,
  pickLocalModel,
  type AgentRunRequest,
  type AppSettings,
} from '../packages/contracts/src';
import { DesktopDirectProviderRuntime } from '../apps/desktop/src/main/direct-provider-runtime';
import { probeLocalServer } from '../apps/desktop/src/main/local-provider';
import { listProviderModels } from '../apps/desktop/src/main/provider-models';
import { assignTeam, billingFor, type AssignmentEnvironment } from '../apps/desktop/src/main/team-assign';

const servers: http.Server[] = [];
const tempProjects: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const dir of tempProjects.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A stand-in for LM Studio's OpenAI-compatible server. */
function lmStudio(models: string[], seen: Array<{ url?: string; authorization?: string; body?: Record<string, unknown> }> = []): http.Server {
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
      response.write('data: {"choices":[{"delta":{"content":"Local "},"finish_reason":null}]}\n\n');
      response.end('data: {"choices":[{"delta":{"content":"model ready."},"finish_reason":"stop"}],"usage":{"prompt_tokens":40,"completion_tokens":6}}\n\ndata: [DONE]\n\n');
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

function lmStudioSettings(baseUrl: string, model = 'qwen2.5-coder-7b-instruct'): AppSettings {
  const settings = createDefaultSettings();
  settings.directApi = { ...settings.directApi, enabled: true, provider: 'lmstudio', baseUrl, model, credentialId: 'provider.lmstudio' };
  return settings;
}

/** A vault that is not even available: a local server must not depend on it. */
function noVault(): { isAvailable(): boolean; has(id: string): Promise<boolean>; get(id: string): Promise<string | undefined> } {
  return { isAvailable: () => false, has: async () => false, get: async () => undefined };
}

function request(): AgentRunRequest {
  return { conversationId: 'conv-local', prompt: 'Say hello', agent: 'codex', execution: 'api', route: 'direct', autonomy: 'ask' };
}

// A directory with no .kai/plan.json: the runtime reads the project's own plan to decide whether a run is finished.
function emptyProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-lmstudio-'));
  tempProjects.push(dir);
  return dir;
}

describe('LM Studio as a provider', () => {
  it('is a first-class provider with LM Studio\'s own address and no bundled models', () => {
    const preset = directProviderPreset('lmstudio');
    expect(preset).toMatchObject({ id: 'lmstudio', protocol: 'chat-completions', defaultBaseUrl: 'http://127.0.0.1:1234/v1', defaultModel: '', models: [] });
    expect(DIRECT_PROVIDER_ORDER).toContain('lmstudio');
    expect(isLocalProvider('lmstudio')).toBe(true);
    expect(isLocalProvider('openai')).toBe(false);
  });

  it('starts from a coding model and never from an embedding model', () => {
    expect(pickLocalModel(['text-embedding-nomic-embed-text-v1.5', 'llava-v1.5-7b', 'qwen2.5-coder-7b-instruct'])).toBe('qwen2.5-coder-7b-instruct');
    expect(pickLocalModel(['text-embedding-nomic-embed-text-v1.5', 'llama-3.2-3b'])).toBe('llama-3.2-3b');
    expect(pickLocalModel(['text-embedding-nomic-embed-text-v1.5'])).toBe('');
    expect(pickLocalModel([])).toBe('');
  });

  it('lists the models a running server has, with no key and no vault', async () => {
    const seen: Array<{ url?: string; authorization?: string }> = [];
    const baseUrl = await listen(lmStudio(['qwen2.5-coder-7b-instruct', 'llava-v1.5-7b'], seen));

    const catalog = await listProviderModels({ provider: 'lmstudio', baseUrl, credentialId: 'provider.lmstudio' }, { get: async () => undefined });

    expect(catalog).toMatchObject({ source: 'live', models: ['llava-v1.5-7b', 'qwen2.5-coder-7b-instruct'], error: null });
    // Even a server on another machine (not loopback) needs no key just because it is LM Studio.
    expect(seen[0]!.authorization).toBeUndefined();
  });

  it('says how to start the server when it is not reachable', async () => {
    const catalog = await listProviderModels({ provider: 'lmstudio', baseUrl: 'http://127.0.0.1:9/v1', credentialId: 'provider.lmstudio' }, { get: async () => undefined }, 2_000);

    expect(catalog.source).toBe('preset');
    expect(catalog.error).toMatch(/LM Studio \(local models\) is not reachable at http:\/\/127\.0\.0\.1:9\/v1\. Open it, start its local server/);
  });

  it('probes a server quickly, and reports a stopped one instead of hanging', async () => {
    const baseUrl = await listen(lmStudio(['a-model']));
    await expect(probeLocalServer(baseUrl)).resolves.toMatchObject({ reachable: true, models: ['a-model'] });
    const stopped = await probeLocalServer('http://127.0.0.1:9/v1', 1_000);
    expect(stopped.reachable).toBe(false);
    expect(stopped.models).toEqual([]);
  });

  it('is available with no credential when the server is up, and explains each way it is not', async () => {
    const baseUrl = await listen(lmStudio(['qwen2.5-coder-7b-instruct']));
    const ready = new DesktopDirectProviderRuntime({ load: async () => lmStudioSettings(baseUrl) }, noVault());
    await expect(ready.capability()).resolves.toMatchObject({ available: true, provider: 'lmstudio', credentialStored: false });

    const stopped = new DesktopDirectProviderRuntime({ load: async () => lmStudioSettings('http://127.0.0.1:9/v1') }, noVault());
    await expect(stopped.capability()).resolves.toMatchObject({
      available: false,
      unavailableReason: expect.stringMatching(/not reachable at http:\/\/127\.0\.0\.1:9\/v1\. Open LM Studio, start its local server \(Developer tab\), load a model/),
    });

    const empty = await listen(lmStudio([]));
    const noModels = new DesktopDirectProviderRuntime({ load: async () => lmStudioSettings(empty) }, noVault());
    await expect(noModels.capability()).resolves.toMatchObject({ available: false, unavailableReason: expect.stringContaining('has no models') });

    const noModel = new DesktopDirectProviderRuntime({ load: async () => lmStudioSettings(baseUrl, '') }, noVault());
    await expect(noModel.capability()).resolves.toMatchObject({ available: false, unavailableReason: 'Set a direct API model in Settings.' });
  });

  it('keeps every other provider strict about its key', async () => {
    const settings = createDefaultSettings();
    settings.directApi = { ...settings.directApi, enabled: true, model: 'gpt-5.5' };
    const runtime = new DesktopDirectProviderRuntime({ load: async () => settings }, { isAvailable: () => true, has: async () => false, get: async () => undefined });
    await expect(runtime.capability()).resolves.toMatchObject({ available: false, unavailableReason: expect.stringContaining('Save the provider.openai credential') });
  });

  it('runs a chat with a placeholder bearer, streams the reply, and records it as free', async () => {
    const seen: Array<{ url?: string; authorization?: string; body?: Record<string, unknown> }> = [];
    const baseUrl = await listen(lmStudio(['gpt-oss-20b'], seen));
    // "gpt-oss" looks like a paid GPT to the price table; a local run must still cost nothing.
    const runtime = new DesktopDirectProviderRuntime({ load: async () => lmStudioSettings(baseUrl, 'gpt-oss-20b') }, noVault());

    const result = await runtime.run(request(), emptyProject());

    expect(result).toMatchObject({ status: 'completed', output: 'Local model ready.' });
    const chat = seen.find((entry) => entry.url === '/v1/chat/completions')!;
    expect(chat.authorization).toBe('Bearer lm-studio');
    expect(chat.body).toMatchObject({ model: 'gpt-oss-20b', stream: true });
    const cost = result.events.find((event) => event.type === 'cost.update');
    expect(cost).toMatchObject({ provider: 'lmstudio', model: 'gpt-oss-20b', inputTokens: 40, outputTokens: 6, amountUsd: 0 });
  });

  it('uses a key when the user stored one (LM Studio can require API tokens)', async () => {
    const seen: Array<{ url?: string; authorization?: string }> = [];
    const baseUrl = await listen(lmStudio(['qwen2.5-coder-7b-instruct'], seen));
    const vault = { isAvailable: () => true, has: async (id: string) => id === 'provider.lmstudio', get: async (id: string) => (id === 'provider.lmstudio' ? 'lm-token' : undefined) };
    const runtime = new DesktopDirectProviderRuntime({ load: async () => lmStudioSettings(baseUrl) }, vault);

    await runtime.run(request(), emptyProject());

    expect(seen.find((entry) => entry.url === '/v1/chat/completions')!.authorization).toBe('Bearer lm-token');
  });

  it('refuses a run when the server is down instead of sending it anywhere', async () => {
    const runtime = new DesktopDirectProviderRuntime({ load: async () => lmStudioSettings('http://127.0.0.1:9/v1') }, noVault());
    const result = await runtime.run(request(), emptyProject());
    expect(result.status).toBe('failed');
    expect(result.error).toContain('not reachable');
  });
});

describe('a local model on the agent team', () => {
  const ALL = ['claude', 'codex', 'qwen', 'gemini', 'kimi'] as const;
  function environment(local: boolean): AssignmentEnvironment {
    return {
      capabilities: ALL.map((id) => ({ id, displayName: id, available: true, state: 'ready' as const, supportsRoutes: ['direct', 'proxy'] as Array<'direct' | 'proxy'> })),
      api: { available: true, displayName: 'LM Studio (local models)', local },
      proxyReady: true,
    };
  }
  const tests = { id: 't', title: 'Tests', role: 'tests' as const, prompt: 'Write tests', dependsOn: [], paths: [] };

  it('labels the local model as free and other API use as per-token', () => {
    expect(billingFor('api', 'direct', true)).toBe('local');
    expect(billingFor('api', 'direct', false)).toBe('api');
    expect(billingFor('api', 'proxy', true)).toBe('api');
    expect(billingFor('claude', 'direct', true)).toBe('subscription');
  });

  it('gives routine parts to the free local model on the Budget preset only', () => {
    const budget = { ...createDefaultSettings().agentTeam, preset: 'budget' as const };
    const balanced = { ...createDefaultSettings().agentTeam, preset: 'balanced' as const };

    expect(assignTeam([tests], budget, environment(true)).assignments[0]).toMatchObject({ assignee: 'api', billing: 'local' });
    expect(assignTeam([tests], budget, environment(false)).assignments[0]!.assignee).not.toBe('api');
    expect(assignTeam([tests], balanced, environment(true)).assignments[0]!.assignee).not.toBe('api');
  });
});
