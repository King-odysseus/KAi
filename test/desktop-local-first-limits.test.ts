import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultSettings, modelHostOf, type AgentRunRequest, type BrainEntry } from '../packages/contracts/src';
import { withGatewayProfile } from '../apps/desktop/src/main/api-connection';
import { buildProjectContext, distinctMemories, namedPaths } from '../apps/desktop/src/main/context-builder';
import { DesktopDirectProviderRuntime } from '../apps/desktop/src/main/direct-provider-runtime';
import { capToolOutput, toolOutputLimit } from '../apps/desktop/src/main/tool-output-cap';

const folders: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

function project(files: Record<string, string> = {}): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-local-first-'));
  folders.push(folder);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    fs.writeFileSync(path.join(folder, name), text);
  }
  return folder;
}

describe('tool output sized to the model', () => {
  it('scales with the window, within bounds', () => {
    expect(toolOutputLimit(65_536)).toBe(20_971);
    expect(toolOutputLimit(131_072)).toBe(41_943);
    expect(toolOutputLimit(4_000)).toBe(6_000);
    expect(toolOutputLimit(1_000_000)).toBe(60_000);
  });

  it('keeps the errors and the end of a command, and saves the rest where it can be read', async () => {
    const root = project();
    const stdout = [
      ...Array.from({ length: 2_000 }, (_, index) => `ok test ${index}`),
      'Error: expected 2 to equal 3',
      ...Array.from({ length: 2_000 }, (_, index) => `ok later ${index}`),
      'Tests: 1 failed, 4000 passed',
    ].join('\n');
    const result = await capToolOutput(root, 'call_1', 'run_command', { exitCode: 1, stdout, stderr: '' }, 8_000) as Record<string, string | number>;

    expect(JSON.stringify(result).length).toBeLessThan(9_000);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Error: expected 2 to equal 3');
    expect(result.stdout).toContain('Tests: 1 failed, 4000 passed');
    const saved = /\.kai\/outputs\/\S+\.log/.exec(String(result.kaiNotice))![0];
    expect(fs.readFileSync(path.join(root, saved), 'utf8')).toContain('ok test 1000\n');
    expect(fs.readFileSync(path.join(root, '.kai/outputs/.gitignore'), 'utf8')).toBe('*\n');
  });

  it('cuts a file read at a line and says where to go on', async () => {
    const text = Array.from({ length: 400 }, (_, index) => `${index + 1}: ${'y'.repeat(80)}`).join('\n');
    const result = await capToolOutput(project(), 'call_2', 'read_file', { path: 'a.ts', text }, 6_000) as { text: string; truncated: boolean; kaiNotice: string };

    const last = Number(/^(\d+):/.exec(result.text.split('\n').at(-1)!)![1]);
    expect(result.truncated).toBe(true);
    expect(result.kaiNotice).toContain(`start_line ${last + 1}`);
  });

  it('drops whole matches from a long search, and leaves a small result alone', async () => {
    const matches = Array.from({ length: 200 }, (_, index) => ({ path: `src/file-${index}.ts`, line: 1, text: 'z'.repeat(100) }));
    const result = await capToolOutput(project(), 'call_3', 'search_files', { matches }, 6_000) as { matches: unknown[]; kaiNotice: string };
    expect(result.matches.length).toBeLessThan(200);
    expect(result.kaiNotice).toContain('of 200 results');

    const small = { ok: true };
    expect(await capToolOutput(project(), 'call_4', 'list_files', small, 6_000)).toBe(small);
  });
});

describe('a lighter start for a small window', () => {
  it('outlines a long preloaded file', async () => {
    const long = `export function first() {}\n${'// filler\n'.repeat(1_000)}export function last() {}\n`;
    const root = project({ 'src/long.ts': long, 'src/short.ts': 'export const a = 1;\n' });
    const full = await buildProjectContext(root, { selectedPaths: ['src/long.ts', 'src/short.ts'] });
    const lean = await buildProjectContext(root, { selectedPaths: ['src/long.ts', 'src/short.ts'], outlineFilesOver: 6_000 });

    expect(full.text).toContain('// filler');
    expect(lean.text).not.toContain('// filler');
    expect(lean.text).toContain('Outline only');
    expect(lean.text).toContain('last');
    expect(lean.text).toContain('export const a = 1;');
  });

  it('picks the files a request names and no others', () => {
    const changed = ['desktop/chat/context.ts', 'src/components/TimeOffPages.test.jsx', 'src/mockups/Dashboard.jsx'];
    expect(namedPaths('Fix the labels in context.ts and add src/labels.ts.', changed)).toEqual(['desktop/chat/context.ts', 'src/labels.ts']);
    expect(namedPaths('Carry on with the plan.', changed)).toEqual([]);
  });

  it('keeps one of several memories that say the same thing', () => {
    const words = Array.from({ length: 80 }, (_, index) => `word${index}`);
    const memory = (title: string, from: number, type = 'decisions'): BrainEntry => ({
      title, type, project: 'p', agent: 'kai', status: '', tags: '', date: '2026-11-19', fields: { note: words.slice(from, from + 50).join(' ') },
    } as unknown as BrainEntry);
    const kept = distinctMemories([memory('first', 0), memory('again', 5), memory('other', 30), memory('a different kind', 0, 'bugs')]);

    expect(kept.map((entry) => entry.title)).toEqual(['first', 'other', 'a different kind']);
  });
});

describe('the agent loop on the person\'s own gateway', () => {
  async function gateway(bodies: Array<{ messages: Array<{ role: string; content?: string }> }>, command: string): Promise<string> {
    const server = http.createServer((incoming, response) => {
      let raw = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk) => { raw += chunk; });
      incoming.on('end', () => {
        bodies.push(JSON.parse(raw) as (typeof bodies)[number]);
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (bodies.length > 1) {
          response.end('data: {"choices":[{"delta":{"content":"Done."},"finish_reason":"stop"}],"usage":{"prompt_tokens":1000000,"completion_tokens":1000000}}\n\ndata: [DONE]\n\n');
          return;
        }
        const call = { index: 0, id: 'call_big', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command }) } };
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] } }] })}\n\ndata: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n`);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind.');
    return `http://127.0.0.1:${address.port}/v1`;
  }

  function runtime(baseUrl: string, model: string): DesktopDirectProviderRuntime {
    const settings = createDefaultSettings();
    settings.gatewayOwnHardware = true;
    settings.directApi = { enabled: true, provider: 'openai-compatible', model, baseUrl, credentialId: 'provider.custom' };
    return new DesktopDirectProviderRuntime(
      { load: async () => settings },
      { isAvailable: () => true, has: async () => true, get: async () => 'test-key' },
      undefined,
      { resolveGatewayAddress: async () => ({ baseUrl, label: 'home' }) },
    );
  }

  const request: AgentRunRequest = { conversationId: 'conv-local-first', prompt: 'Run it', agent: 'codex', execution: 'api', route: 'direct', autonomy: 'full' };

  it('sends the model a shortened command result and charges nothing', async () => {
    const root = project({ 'big.js': 'for (let i = 0; i < 4000; i++) console.log("line " + i + " " + "q".repeat(40));\n' });
    const bodies: Array<{ messages: Array<{ role: string; content?: string }> }> = [];
    const result = await runtime(await gateway(bodies, 'node big.js'), 'gateway/coding').run(request, root);

    expect(result.status).toBe('completed');
    const sent = bodies[1]!.messages.find((message) => message.role === 'tool')!.content!;
    expect(sent.length).toBeLessThan(toolOutputLimit(65_536) + 1_000);
    expect(sent).toContain('line 3999');
    expect(sent).toContain('.kai/outputs/');
    expect(result.events.filter((event) => event.type === 'cost.update').at(-1)).toMatchObject({ amountUsd: 0 });
  }, 30_000);

  it('sends a role that names only the gateway to the saved address while the default is another provider', async () => {
    const bodies: Array<{ messages: Array<{ role: string; content?: string }> }> = [];
    const away = await gateway(bodies, 'node -v');
    const settings = createDefaultSettings();
    settings.gatewayOwnHardware = true;
    settings.gatewayAwayUrl = away;
    settings.gatewayCredentialId = 'provider.my-gateway';
    settings.directApi = { enabled: true, provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', credentialId: 'provider.deepseek' };
    const asked: string[] = [];
    const roleRuntime = new DesktopDirectProviderRuntime(
      { load: async () => settings },
      { isAvailable: () => true, has: async () => true, get: async (id: string) => { asked.push(id); return 'test-key'; } },
    );

    const result = await roleRuntime.run({ ...request, apiConnection: { provider: 'openai-compatible', model: 'gateway/coding' } }, project());

    expect(result.status).toBe('completed');
    expect(bodies.length).toBeGreaterThan(0);
    expect(asked).toEqual(['provider.my-gateway']);
    expect(result.events.filter((event) => event.type === 'cost.update').at(-1)).toMatchObject({ amountUsd: 0 });
  }, 30_000);

  it('does not count another default service as the person\'s own once a gateway address is saved', () => {
    const settings = createDefaultSettings();
    settings.gatewayOwnHardware = true;
    settings.gatewayAwayUrl = 'https://my-relay.example/v1';
    settings.directApi = { enabled: true, provider: 'openai-compatible', model: 'm', baseUrl: 'https://someone-else.example/v1', credentialId: 'provider.custom' };

    expect(modelHostOf({ provider: 'openai-compatible', baseUrl: 'https://someone-else.example/v1' }, settings)).toBe('cloud');
    expect(modelHostOf({ provider: 'openai-compatible', baseUrl: 'https://my-relay.example/v1/' }, settings)).toBe('own-hardware');
    expect(withGatewayProfile(settings, { provider: 'openai-compatible' })).toEqual({ provider: 'openai-compatible' });
  });

  it('puts the "repeating itself" question on screen, not only in the waiting list', async () => {
    const root = project({ 'notes.txt': 'one line\n' });
    const server = http.createServer((incoming, response) => {
      let raw = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk) => { raw += chunk; });
      incoming.on('end', () => {
        const body = JSON.parse(raw) as { tools?: unknown[] };
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (!body.tools) {
          response.end('data: {"choices":[{"delta":{"content":"Stopping."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
          return;
        }
        const call = { index: 0, id: `call_${Math.random()}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'notes.txt' }) } };
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] } }] })}\n\ndata: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n`);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind.');
    const shown: Array<{ type: string; requestId?: string; runQuestion?: { continueLabel: string } }> = [];
    const asked: string[] = [];

    await runtime(`http://127.0.0.1:${address.port}/v1`, 'gateway/coding').run(
      request,
      root,
      undefined,
      (event) => shown.push(event as (typeof shown)[number]),
      { request: async (approval) => { asked.push(approval.requestId); return false; } },
    );

    expect(asked.length).toBeGreaterThan(0);
    const questions = shown.filter((event) => event.type === 'approval.request');
    expect(questions.map((event) => event.requestId)).toEqual(asked);
    expect(questions[0]!.runQuestion?.continueLabel).toBe('Continue');
  }, 30_000);

  it('asks by the fourth identical check failure, although every edit in between differs', async () => {
    const root = project({ 'check.js': 'console.log("Tests  2 failed | 12 passed (14)"); console.log("Duration " + Math.random() + "s"); process.exit(1);\n', 'work.txt': '0' });
    let round = 0;
    const server = http.createServer((incoming, response) => {
      let raw = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk) => { raw += chunk; });
      incoming.on('end', () => {
        const body = JSON.parse(raw) as { tools?: unknown[] };
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (!body.tools || round >= 40) {
          response.end('data: {"choices":[{"delta":{"content":"Stopping."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
          return;
        }
        round += 1;
        // Edit, check, edit, check: no two calls are the same.
        const call = round % 2
          ? { name: 'write_file', arguments: JSON.stringify({ path: 'work.txt', content: String(round) }) }
          : { name: 'run_command', arguments: JSON.stringify({ command: 'node check.js' }) };
        const toolCall = { index: 0, id: `call_${round}`, type: 'function', function: call };
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [toolCall] } }] })}\n\ndata: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n`);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind.');
    const asked: string[] = [];

    const result = await runtime(`http://127.0.0.1:${address.port}/v1`, 'gateway/coding').run(
      request,
      root,
      undefined,
      undefined,
      { request: async (approval) => { asked.push(approval.title); return false; } },
    );

    expect(asked).toEqual(['The same check keeps failing']);
    // Four checks and the edits before them; the person said finish.
    expect(round).toBe(8);
    expect(result.output).toContain('Stopping.');
  }, 60_000);

  it('refuses gateway/auto before sending anything', async () => {
    const bodies: Array<{ messages: Array<{ role: string; content?: string }> }> = [];
    const result = await runtime(await gateway(bodies, 'node -v'), 'gateway/auto').run(request, project());

    expect(result.status).toBe('failed');
    expect(result.error).toContain('gateway/coding');
    expect(bodies).toHaveLength(0);
  });
});
