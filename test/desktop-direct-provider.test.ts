import * as http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultSettings, type AgentRunRequest, type AppSettings } from '../packages/contracts/src';
import {
  DesktopDirectProviderRuntime,
  outputBudgetRejected,
  type DirectApiApprovalRequest,
} from '../apps/desktop/src/main/direct-provider-runtime';

const servers: http.Server[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('desktop direct provider runtime', () => {
  it('reports missing model and credential setup without making a request', async () => {
    const settings = createDefaultSettings();
    settings.directApi.model = '';
    const runtime = new DesktopDirectProviderRuntime(settingsPort(settings), credentialPort());

    await expect(runtime.capability()).resolves.toMatchObject({
      available: false,
      provider: 'openai',
      unavailableReason: 'Set a direct API model in Settings.',
    });
  });

  it('routes direct API runs through the authenticated Universal Proxy without reading the provider key', async () => {
    const requests: Array<{ path?: string; authorization?: string; body: Record<string, unknown> }> = [];
    const server = http.createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        requests.push({
          path: request.url,
          authorization: request.headers.authorization,
          body: JSON.parse(raw) as Record<string, unknown>,
        });
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-proxy","output":[{"type":"message","content":[{"type":"output_text","text":"Proxy ready."}]}]}}\n\n');
      });
    });
    const baseUrl = await listen(server);
    const settings = enabledSettings('https://api.openai.com/v1', 'test-model');
    const runtime = new DesktopDirectProviderRuntime(
      settingsPort(settings),
      credentialPort(),
      undefined,
      {
        resolveProxyRoute: async () => ({ baseUrl, apiKey: 'loopback-token' }),
      },
    );

    const result = await runtime.run({ ...runRequest(), route: 'proxy' }, process.cwd());

    expect(result).toMatchObject({ status: 'completed', output: 'Proxy ready.', sessionId: 'resp-proxy' });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      path: '/v1/responses',
      authorization: 'Bearer loopback-token',
      body: { model: 'test-model', stream: true },
    });
  });

  it('streams Responses API text and records measured usage', async () => {
    const requests: Array<{ authorization?: string; body: Record<string, unknown> }> = [];
    const server = http.createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        requests.push({
          authorization: request.headers.authorization,
          body: JSON.parse(raw) as Record<string, unknown>,
        });
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp-1"}}\n\n');
        response.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hel');
        response.write('lo "}\n\n');
        response.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"world"}\n\n');
        response.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1","usage":{"input_tokens":12,"output_tokens":4},"output":[]}}\n\n');
      });
    });
    const baseUrl = await listen(server);
    const settings = enabledSettings(baseUrl, 'test-model');
    const runtime = new DesktopDirectProviderRuntime(
      settingsPort(settings),
      credentialPort('provider.openai', 'sk-test-secret'),
    );
    const streamed: string[] = [];

    const result = await runtime.run(runRequest(), process.cwd(), undefined, (event) => {
      if (event.type === 'text.delta') streamed.push(event.text);
    });

    expect(result).toMatchObject({
      status: 'completed',
      output: 'Hello world',
      sessionId: 'resp-1',
    });
    expect(streamed).toEqual(['Hello ', 'world']);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      authorization: 'Bearer sk-test-secret',
      body: {
        model: 'test-model',
        input: 'Inspect the project',
        stream: true,
        tool_choice: 'auto',
      },
    });
    expect(requests[0].body.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function', name: 'read_file' }),
      expect.objectContaining({ type: 'function', name: 'replace_in_file' }),
    ]));
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text.delta', text: 'Hello world' }),
        expect.objectContaining({ type: 'cost.update', inputTokens: 12, outputTokens: 4, estimateProvenance: 'measured' }),
      ]),
    );
    // A model with no known price is tagged as a paid run but gets no invented dollar amount.
    const cost = result.events.find((event) => event.type === 'cost.update');
    expect(cost).toMatchObject({ model: 'test-model', provider: expect.any(String) });
    expect(cost).not.toHaveProperty('amountUsd');
  });

  it('streams OpenRouter Chat Completions with attribution and measured usage', async () => {
    const requests: Array<{ path?: string; authorization?: string; title?: string; body: Record<string, unknown> }> = [];
    const server = http.createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        requests.push({
          path: request.url,
          authorization: request.headers.authorization,
          title: request.headers['x-title'] as string | undefined,
          body: JSON.parse(raw) as Record<string, unknown>,
        });
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('data: {"choices":[{"delta":{"content":"Router "},"finish_reason":null}]}\n\n');
        response.end('data: {"choices":[{"delta":{"content":"ready."},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\ndata: [DONE]\n\n');
      });
    });
    const baseUrl = await listen(server);
    const runtime = new DesktopDirectProviderRuntime(
      settingsPort(chatProviderSettings(baseUrl, 'openrouter', 'anthropic/claude-3.7-sonnet')),
      credentialPort('provider.openrouter', 'or-test-secret'),
    );

    const result = await runtime.run(
      runRequest(),
      process.cwd(),
      undefined,
      undefined,
      undefined,
      '# KAI project context\nRouter context.',
      [{ role: 'user', text: 'Inspect the project' }],
    );

    expect(result).toMatchObject({ status: 'completed', output: 'Router ready.' });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      path: '/v1/chat/completions',
      authorization: 'Bearer or-test-secret',
      title: 'KAI Desktop',
      body: {
        model: 'anthropic/claude-3.7-sonnet',
        stream: true,
      },
    });
    expect(requests[0].body.messages).toEqual([
      { role: 'system', content: '# KAI project context\nRouter context.' },
      { role: 'user', content: 'Inspect the project' },
    ]);
    expect(requests[0].body.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'read_file' }) }),
    ]));
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'cost.update', inputTokens: 9, outputTokens: 2, provider: 'openrouter', model: 'anthropic/claude-3.7-sonnet' }),
    ]));
    const cost = result.events.find((event) => event.type === 'cost.update');
    expect(cost).toMatchObject({ amountUsd: (9 * 5 + 2 * 25) / 1_000_000 });
  });

  it('supports DeepSeek Chat Completions and ignores reasoning deltas', async () => {
    const requests: Array<{ path?: string; body: Record<string, unknown> }> = [];
    const server = http.createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        requests.push({ path: request.url, body: JSON.parse(raw) as Record<string, unknown> });
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('data: {"choices":[{"delta":{"reasoning_content":"hidden"},"finish_reason":null}]}\n\n');
        response.end('data: {"choices":[{"delta":{"content":"DeepSeek ready."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      });
    });
    const baseUrl = await listen(server);
    const runtime = new DesktopDirectProviderRuntime(
      settingsPort(chatProviderSettings(baseUrl, 'deepseek', 'deepseek-reasoner')),
      credentialPort('provider.deepseek', 'ds-test-secret'),
    );

    const result = await runtime.run(runRequest(), process.cwd());

    expect(result).toMatchObject({ status: 'completed', output: 'DeepSeek ready.' });
    expect(requests[0]).toMatchObject({ path: '/v1/chat/completions', body: { model: 'deepseek-reasoner' } });
  });

  it('keeps a DeepSeek run going past its per-request tool limit instead of handing the task back', async () => {
    const requests: Array<{ messages: Array<Record<string, unknown>>; tools?: unknown[] }> = [];
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'kai-deepseek-'));
    temporaryDirectories.push(projectRoot);
    await writeFile(path.join(projectRoot, 'notes.txt'), 'hello' + String.fromCharCode(10));
    const server = http.createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        const body = JSON.parse(raw) as { messages: Array<Record<string, unknown>>; tools?: unknown[] };
        requests.push(body);
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        // Nineteen tool rounds, then the answer: well past DeepSeek's seven per request.
        if (requests.length <= 19) {
          const call = { index: 0, id: `call_${requests.length}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'notes.txt', start_line: requests.length }) } };
          response.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] } }] })}

data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}

data: [DONE]

`);
          return;
        }
        response.end(`data: {"choices":[{"delta":{"content":"All done."},"finish_reason":"stop"}]}

data: [DONE]

`);
      });
    });
    const baseUrl = await listen(server);
    const runtime = new DesktopDirectProviderRuntime(
      settingsPort(chatProviderSettings(baseUrl, 'deepseek', 'deepseek-chat')),
      credentialPort('provider.deepseek', 'ds-test-secret'),
    );

    const result = await runtime.run({ ...runRequest(), autonomy: 'full' }, projectRoot);

    expect(result).toMatchObject({ status: 'completed', output: 'All done.' });
    expect(requests).toHaveLength(20);
    // No request carries more than seven tool rounds, and every one still offers tools until the answer.
    for (const request of requests) {
      const rounds = request.messages.filter((message) => message.role === 'assistant' && Array.isArray(message.tool_calls)).length;
      expect(rounds).toBeLessThanOrEqual(7);
      expect(Array.isArray(request.tools) && request.tools.length > 0).toBe(true);
    }
    // The request after the seventh round starts fresh, with the earlier work summarised instead of replayed.
    const continued = requests[7]!.messages;
    expect(continued.some((message) => message.role === 'tool')).toBe(false);
    const summary = continued.find((message) => typeof message.content === 'string' && message.content.includes('Progress so far'));
    expect(String(summary?.content)).toContain('read_file');
    expect(String(summary?.content)).toContain('Run any remaining commands and edits yourself');
  });

  it('keeps an Anthropic-shaped run going well past 100 tool rounds instead of stopping it', async () => {
    // The shape of DeepSeek's Anthropic-style endpoint, which is the path an official DeepSeek run actually takes.
    // It used to end at a flat 100 rounds with "The provider exceeded the 100-round tool limit." mid-task.
    const requests: Array<{ tools?: unknown[] }> = [];
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'kai-anthropic-'));
    temporaryDirectories.push(projectRoot);
    await writeFile(path.join(projectRoot, 'notes.txt'), 'hello' + String.fromCharCode(10));
    const server = http.createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        const body = JSON.parse(raw) as { tools?: unknown[] };
        requests.push(body);
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}\n\n');
        // A hundred and twenty rounds: past the old ceiling, and every call differs so repeat detection leaves it alone.
        if (requests.length <= 120) {
          response.end(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${requests.length}`, name: 'read_file', input: { path: 'notes.txt', start_line: requests.length } } })}

event: message_stop
data: {"type":"message_stop"}

`);
          return;
        }
        response.end(`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"All done."}}

event: message_stop
data: {"type":"message_stop"}

`);
      });
    });
    const baseUrl = await listen(server);
    const runtime = new DesktopDirectProviderRuntime(
      settingsPort(directProviderSettings(baseUrl, 'anthropic', 'claude-sonnet-5')),
      credentialPort('provider.anthropic', 'anthropic-secret'),
    );

    const result = await runtime.run({ ...runRequest(), autonomy: 'full' }, projectRoot);

    expect(result.status).toBe('completed');
    expect(result.output).toContain('All done.');
    expect(result.error).toBeUndefined();
    expect(requests.length).toBeGreaterThan(120);
  }, 60_000);

  it('asks a run at its tool ceiling to sum up, with the tools taken away, instead of failing it', async () => {
    const requests: Array<{ tools?: unknown[]; messages: Array<Record<string, unknown>> }> = [];
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'kai-ceiling-'));
    temporaryDirectories.push(projectRoot);
    await writeFile(path.join(projectRoot, 'notes.txt'), 'hello' + String.fromCharCode(10));
    const server = http.createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        const body = JSON.parse(raw) as { tools?: unknown[]; messages: Array<Record<string, unknown>> };
        requests.push(body);
        const wrappingUp = body.messages.some((message) => typeof message.content === 'string' && message.content.includes('Stop calling tools'));
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}\n\n');
        if (wrappingUp) {
          response.end(`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"I changed notes.txt; the parser is still unwritten."}}

event: message_stop
data: {"type":"message_stop"}

`);
          return;
        }
        response.end(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${requests.length}`, name: 'read_file', input: { path: 'notes.txt', start_line: requests.length } } })}

event: message_stop
data: {"type":"message_stop"}

`);
      });
    });
    const baseUrl = await listen(server);
    const runtime = new DesktopDirectProviderRuntime(
      settingsPort(directProviderSettings(baseUrl, 'anthropic', 'claude-sonnet-5')),
      credentialPort('provider.anthropic', 'anthropic-secret'),
      undefined,
      { maxToolRounds: 3 },
    );

    const result = await runtime.run({ ...runRequest(), autonomy: 'full' }, projectRoot);

    // The work is reported rather than thrown away with an error, and the run still ends cleanly.
    expect(result.status).toBe('completed');
    expect(result.output).toContain('the parser is still unwritten');
    expect(result.error).toBeUndefined();
    // The last request has no tools at all, so the model answers in words rather than calling again.
    expect(requests.length).toBeGreaterThan(3);
    expect(requests.at(-1)?.tools ?? []).toHaveLength(0);
  });

  it('asks before a per-run spend limit ends the run, once, and carries on when told to', async () => {
    const questions: DirectApiApprovalRequest[] = [];
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'kai-spend-'));
    temporaryDirectories.push(projectRoot);
    await writeFile(path.join(projectRoot, 'notes.txt'), 'hello' + String.fromCharCode(10));
    const server = http.createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        const body = JSON.parse(raw) as { messages: Array<Record<string, unknown>> };
        const wrappingUp = body.messages.some((message) => typeof message.content === 'string' && message.content.includes('Stop calling tools'));
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1200,"output_tokens":900}}}\n\n');
        if (wrappingUp || body.messages.length > 6) {
          response.end('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"All done."}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
          return;
        }
        response.end(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${body.messages.length}`, name: 'read_file', input: { path: 'notes.txt', start_line: body.messages.length } } })}

event: message_stop
data: {"type":"message_stop"}

`);
      });
    });
    const baseUrl = await listen(server);
    const runtime = new DesktopDirectProviderRuntime(
      settingsPort(directProviderSettings(baseUrl, 'anthropic', 'claude-sonnet-5')),
      credentialPort('provider.anthropic', 'anthropic-secret'),
      undefined,
      // A limit small enough that the first usage report passes it, so the question is reached quickly.
      { maxRunCostUsd: 0.000001 },
    );

    const result = await runtime.run(
      { ...runRequest(), autonomy: 'full' },
      projectRoot,
      undefined,
      undefined,
      { request: async (approval) => { questions.push(approval); return true; } },
    );

    expect(result.status).toBe('completed');
    expect(result.error).toBeUndefined();
    expect(questions).toHaveLength(1);
    expect(questions[0]!.title).toContain('limit');
    expect(questions[0]!.detail).toContain('Continue');
    // The prompt the person sees is built from these. Without them the dialog offered "Deny / Allow once / Allow &
    // use full access" for a question about spending money, and the third of those lifts the limit for good.
    expect(questions[0]!.runQuestion).toEqual({ continueLabel: 'Continue', finishLabel: 'Finish' });
  }, 30_000);

  it('asks before a repeated call ends the run, and carries on when told to', async () => {
    const questions: DirectApiApprovalRequest[] = [];
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'kai-repeat-'));
    temporaryDirectories.push(projectRoot);
    await writeFile(path.join(projectRoot, 'notes.txt'), 'hello' + String.fromCharCode(10));
    let calls = 0;
    const server = http.createServer((request, response) => {
      request.setEncoding('utf8');
      request.on('data', () => undefined);
      request.on('end', () => {
        calls += 1;
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":5}}}\n\n');
        // The same call with the same arguments and the same result, five times over.
        if (calls <= 6) {
          response.end(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${calls}`, name: 'read_file', input: { path: 'notes.txt' } } })}

event: message_stop
data: {"type":"message_stop"}

`);
          return;
        }
        response.end('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"All done."}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
      });
    });
    const baseUrl = await listen(server);
    const runtime = new DesktopDirectProviderRuntime(
      settingsPort(directProviderSettings(baseUrl, 'anthropic', 'claude-sonnet-5')),
      credentialPort('provider.anthropic', 'anthropic-secret'),
    );

    const result = await runtime.run(
      { ...runRequest(), autonomy: 'full' },
      projectRoot,
      undefined,
      undefined,
      { request: async (approval) => { questions.push(approval); return true; } },
    );

    expect(questions).toHaveLength(1);
    expect(questions[0]!.title).toContain('repeating');
    expect(questions[0]!.runQuestion).toEqual({ continueLabel: 'Continue', finishLabel: 'Finish' });
    // Told to carry on, so the run does rather than ending at the fifth identical call.
    expect(result.status).toBe('completed');
    expect(result.output).toContain('All done.');
  }, 30_000);

  it('wraps a limited run up with a summary when there is nobody to ask', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'kai-headless-'));
    temporaryDirectories.push(projectRoot);
    await writeFile(path.join(projectRoot, 'notes.txt'), 'hello' + String.fromCharCode(10));
    let calls = 0;
    let sawWrapUp = false;
    const server = http.createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        calls += 1;
        const body = JSON.parse(raw) as { messages: Array<Record<string, unknown>> };
        const wrappingUp = body.messages.some((message) => typeof message.content === 'string' && message.content.includes('Stop calling tools'));
        if (wrappingUp) sawWrapUp = true;
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":5}}}\n\n');
        if (calls <= 5) {
          response.end(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${calls}`, name: 'read_file', input: { path: 'notes.txt' } } })}

event: message_stop
data: {"type":"message_stop"}

`);
          return;
        }
        response.end('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"I read notes.txt and did not get further."}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
      });
    });
    const baseUrl = await listen(server);
    const runtime = new DesktopDirectProviderRuntime(
      settingsPort(directProviderSettings(baseUrl, 'anthropic', 'claude-sonnet-5')),
      credentialPort('provider.anthropic', 'anthropic-secret'),
    );

    // No approval port: a scheduled or team run, where nobody can answer a question.
    const result = await runtime.run({ ...runRequest(), autonomy: 'full' }, projectRoot);

    expect(sawWrapUp).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('did not get further');
  }, 30_000);

  it('streams native Anthropic Messages with the Anthropic credential headers', async () => {
    const requests: Array<{ path?: string; apiKey?: string; version?: string; body: Record<string, unknown> }> = [];
    const server = http.createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        requests.push({
          path: request.url,
          apiKey: request.headers['x-api-key'] as string | undefined,
          version: request.headers['anthropic-version'] as string | undefined,
          body: JSON.parse(raw) as Record<string, unknown>,
        });
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":0}}}\n\n');
        response.end('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Claude ready."}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":3}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
      });
    });
    const baseUrl = await listen(server);
    const settings = directProviderSettings(baseUrl, 'anthropic', 'claude-sonnet-5');
    const runtime = new DesktopDirectProviderRuntime(
      settingsPort(settings),
      credentialPort('provider.anthropic', 'anthropic-secret'),
    );

    const result = await runtime.run(runRequest(), process.cwd(), undefined, undefined, undefined, '# KAI project context\nAnthropic context.');

    expect(result).toMatchObject({ status: 'completed', output: 'Claude ready.' });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      path: '/v1/messages',
      apiKey: 'anthropic-secret',
      version: '2023-06-01',
      body: {
        model: 'claude-sonnet-5',
        system: '# KAI project context\nAnthropic context.',
        stream: true,
      },
    });
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'cost.update', inputTokens: 7, outputTokens: 3, provider: 'anthropic' }),
    ]));
  });

  it('resumes a turn that ran out of output budget instead of ending the run with nothing', async () => {
    const bodies: Record<string, unknown>[] = [];
    const server = http.createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (bodies.length === 1) {
          // A reasoning model that spends the whole output budget thinking: a thinking block, no visible text and no
          // tool call. This is the shape that used to end the run as "the provider returned no output".
          response.end('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Weighing the options."}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":20},"delta":{"stop_reason":"max_tokens"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
          return;
        }
        response.end('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Carried on and finished."}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":5},"delta":{"stop_reason":"end_turn"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
      });
    });
    const baseUrl = await listen(server);
    const runtime = new DesktopDirectProviderRuntime(
      settingsPort(directProviderSettings(baseUrl, 'anthropic', 'claude-sonnet-5')),
      credentialPort('provider.anthropic', 'anthropic-secret'),
    );

    const result = await runtime.run(runRequest(), process.cwd());

    expect(result).toMatchObject({ status: 'completed', output: 'Carried on and finished.' });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.max_tokens).toBe(32_768);
  });

  it('asks for the smaller output budget when the endpoint refuses the larger one', () => {
    expect(outputBudgetRejected('Provider request failed (400): max_tokens is too large')).toBe(true);
    expect(outputBudgetRejected('Provider request failed (400): invalid model')).toBe(false);
    expect(outputBudgetRejected(undefined)).toBe(false);
  });

  it('streams native Gemini generative AI responses with the Google credential header', async () => {
    const requests: Array<{ path?: string; apiKey?: string; body: Record<string, unknown> }> = [];
    const server = http.createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        requests.push({
          path: request.url,
          apiKey: request.headers['x-goog-api-key'] as string | undefined,
          body: JSON.parse(raw) as Record<string, unknown>,
        });
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end('data: {"candidates":[{"content":{"parts":[{"text":"Gemini ready."}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"totalTokenCount":7}}\n\n');
      });
    });
    const baseUrl = await listen(server);
    const settings = directProviderSettings(baseUrl, 'google', 'gemini-3.8-flash');
    const runtime = new DesktopDirectProviderRuntime(
      settingsPort(settings),
      credentialPort('provider.google', 'google-secret'),
    );

    const result = await runtime.run(runRequest(), process.cwd());

    expect(result).toMatchObject({ status: 'completed', output: 'Gemini ready.' });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      path: '/v1/models/gemini-3.8-flash:streamGenerateContent?alt=sse',
      apiKey: 'google-secret',
      body: { contents: [{ role: 'user', parts: [{ text: 'Inspect the project' }] }] },
    });
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'cost.update', inputTokens: 5, outputTokens: 2, provider: 'google' }),
    ]));
  });

  it('cancels an in-flight Chat Completions stream', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"working"}}]}\n\n');
      const timer = setInterval(() => response.write(': keep-alive\n\n'), 100);
      response.on('close', () => clearInterval(timer));
    });
    const baseUrl = await listen(server);
    const runtime = new DesktopDirectProviderRuntime(
      settingsPort(chatProviderSettings(baseUrl, 'openrouter', 'openai/gpt-4o-mini')),
      credentialPort('provider.openrouter', 'or-test-secret'),
    );

    const pending = runtime.run(runRequest(), process.cwd());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(runtime.cancel('conv-direct')).toBe(true);

    // A run the person stopped is not an error: it still did not complete, but nothing went wrong, and reporting it
    // as one put a red "run cancelled" box in the transcript for something they had just done deliberately.
    const outcome = await pending;
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toBeUndefined();
    expect(outcome.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'agent.lifecycle', status: 'cancelled' }),
    ]));
  });

  it('executes fragmented Chat Completions tool calls and returns durable results', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'kai-chat-tools-'));
    temporaryDirectories.push(projectRoot);
    await writeFile(path.join(projectRoot, 'router.txt'), 'openrouter tool result\n', 'utf8');
    const bodies: Record<string, unknown>[] = [];
    let count = 0;
    const server = http.createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        count += 1;
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (count === 1) {
          response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_router","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"router"}}]}}]}\n\n');
          response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":".txt\\"}"}}]}}]}\n\n');
          response.end('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
          return;
        }
        response.write('data: {"choices":[{"delta":{"content":"OpenRouter tools."},"finish_reason":"stop"}]}\n\n');
        response.end('data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":3}}\n\ndata: [DONE]\n\n');
      });
    });
    const baseUrl = await listen(server);
    const runtime = new DesktopDirectProviderRuntime(
      settingsPort(chatProviderSettings(baseUrl, 'openrouter', 'deepseek/deepseek-chat')),
      credentialPort('provider.openrouter', 'or-test-secret'),
    );

    const result = await runtime.run(runRequest(), projectRoot);

    expect(result).toMatchObject({ status: 'completed', output: 'OpenRouter tools.' });
    expect(bodies).toHaveLength(2);
    const followUp = bodies[1].messages as Array<Record<string, unknown>>;
    expect(followUp).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', tool_calls: [expect.objectContaining({ id: 'call_router' })] }),
      expect.objectContaining({ role: 'tool', tool_call_id: 'call_router', content: expect.stringContaining('openrouter tool result') }),
    ]));
  });

  it('prepends collected project context to the provider input', async () => {
    let body: Record<string, unknown> | undefined;
    const server = http.createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        body = JSON.parse(raw) as Record<string, unknown>;
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-context","output":[{"type":"message","content":[{"type":"output_text","text":"Context received."}]}]}}\n\n');
      });
    });
    const baseUrl = await listen(server);
    const runtime = new DesktopDirectProviderRuntime(
      settingsPort(enabledSettings(baseUrl, 'test-model')),
      credentialPort('provider.openai', 'sk-test-secret'),
    );

    const result = await runtime.run(
      runRequest(),
      process.cwd(),
      undefined,
      undefined,
      undefined,
      '# KAI project context\nFollow the project rules.',
    );

    expect(result).toMatchObject({ status: 'completed', output: 'Context received.' });
    expect(body?.input).toContain('Follow the project rules.');
    expect(body?.input).toContain('User request:\nInspect the project');
  });

  it('continues through previous_response_id and surfaces provider errors', async () => {
    const bodies: Record<string, unknown>[] = [];
    let requestCount = 0;
    const server = http.createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        requestCount += 1;
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
        if (requestCount === 1) {
          response.writeHead(200, { 'Content-Type': 'text/event-stream' });
          response.end('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"first"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-parent","usage":{"input_tokens":1,"output_tokens":1}}}\n\n');
          return;
        }
        response.writeHead(429, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Rate limit reached' } }));
      });
    });
    const baseUrl = await listen(server);
    const runtime = new DesktopDirectProviderRuntime(
      settingsPort(enabledSettings(baseUrl, 'test-model')),
      credentialPort('provider.openai', 'sk-test-secret'),
      undefined,
      { retryBaseDelayMs: 1 },
    );

    await expect(runtime.run(runRequest(), process.cwd(), undefined)).resolves.toMatchObject({ status: 'completed', sessionId: 'resp-parent' });
    const failed = await runtime.run(runRequest(), process.cwd(), 'resp-parent');

    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('429');
    expect(failed.error).toContain('Rate limit reached');
    expect(bodies).toHaveLength(4);
    expect(bodies[1]).toMatchObject({ previous_response_id: 'resp-parent' });
  });

  it('retries a rate-limited provider request and persists retry evidence', async () => {
    let requestCount = 0;
    const server = http.createServer((_request, response) => {
      requestCount += 1;
      if (requestCount === 1) {
        response.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
        response.end(JSON.stringify({ error: { message: 'Slow down' } }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-retry","output":[{"type":"message","content":[{"type":"output_text","text":"Recovered."}]}]}}\n\n');
    });
    const baseUrl = await listen(server);
    const runtime = new DesktopDirectProviderRuntime(
      settingsPort(enabledSettings(baseUrl, 'test-model')),
      credentialPort('provider.openai', 'sk-test-secret'),
      undefined,
      { retryBaseDelayMs: 1 },
    );
    const events: Array<Record<string, unknown>> = [];

    const result = await runtime.run(runRequest(), process.cwd(), undefined, (event) => events.push(event as Record<string, unknown>));

    expect(result).toMatchObject({ status: 'completed', output: 'Recovered.', sessionId: 'resp-retry' });
    expect(requestCount).toBe(2);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'agent.lifecycle',
        detail: expect.stringContaining('returned 429'),
      }),
    ]));
  });

  it('executes a bounded provider tool call and sends its durable result back', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'kai-direct-tools-'));
    temporaryDirectories.push(projectRoot);
    await writeFile(path.join(projectRoot, 'hello.txt'), 'hello from the project\n', 'utf8');
    const bodies: Record<string, unknown>[] = [];
    let requestCount = 0;
    const server = http.createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        requestCount += 1;
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (requestCount === 1) {
          response.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-tool-parent","usage":{"input_tokens":2,"output_tokens":3},"output":[{"type":"function_call","id":"fc_1","call_id":"call_1","name":"read_file","arguments":"{\\"path\\":\\"hello.txt\\"}"}]}}\n\n');
          return;
        }
        response.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"The file says hello."}\n\n');
        response.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-tool-final","usage":{"input_tokens":4,"output_tokens":5},"output":[]}}\n\n');
      });
    });
    const baseUrl = await listen(server);
    const runtime = new DesktopDirectProviderRuntime(
      settingsPort(enabledSettings(baseUrl, 'test-model')),
      credentialPort('provider.openai', 'sk-test-secret'),
    );
    const events: Array<Record<string, unknown>> = [];

    const result = await runtime.run(runRequest(), projectRoot, undefined, (event) => events.push(event as Record<string, unknown>));

    expect(result).toMatchObject({ status: 'completed', output: 'The file says hello.', sessionId: 'resp-tool-final' });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({ previous_response_id: 'resp-tool-parent' });
    expect(bodies[1].input).toEqual([
      expect.objectContaining({ type: 'function_call_output', call_id: 'call_1' }),
    ]);
    expect(JSON.stringify(bodies[1].input)).toContain('hello from the project');
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool.call', name: 'read_file', status: 'completed' }),
    ]));
  });

  it('requires approval before editing and then applies the change', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'kai-direct-edit-'));
    temporaryDirectories.push(projectRoot);
    const target = path.join(projectRoot, 'index.ts');
    await writeFile(target, 'export const value = 1;\n', 'utf8');
    let requestCount = 0;
    const server = http.createServer((_request, response) => {
      requestCount += 1;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (requestCount === 1) {
        response.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-edit-1","output":[{"type":"function_call","id":"fc_edit","call_id":"call_edit","name":"replace_in_file","arguments":"{\\"path\\":\\"index.ts\\",\\"old_text\\":\\"value = 1\\",\\"new_text\\":\\"value = 2\\"}"}]}}\n\n');
        return;
      }
      response.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-edit-2","output":[{"type":"message","content":[{"type":"output_text","text":"Updated the value."}]}]}}\n\n');
    });
    const baseUrl = await listen(server);
    const runtime = new DesktopDirectProviderRuntime(
      settingsPort(enabledSettings(baseUrl, 'test-model')),
      credentialPort('provider.openai', 'sk-test-secret'),
    );
    const approvals: string[] = [];

    const result = await runtime.run(runRequest(), projectRoot, undefined, undefined, {
      request: async (approval) => {
        approvals.push(approval.tool);
        return true;
      },
    });

    expect(result).toMatchObject({ status: 'completed', output: 'Updated the value.' });
    expect(approvals).toEqual(['replace_in_file']);
    await expect(readText(target)).resolves.toBe('export const value = 2;\n');
  });

  it('requires approval before running a command and returns its output to the provider', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'kai-direct-command-'));
    temporaryDirectories.push(projectRoot);
    const command = nodeCommand("process.stdout.write('command-ok')");
    const bodies: Record<string, unknown>[] = [];
    let requestCount = 0;
    const server = http.createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        requestCount += 1;
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (requestCount === 1) {
          const call = {
            type: 'function_call',
            id: 'fc_command',
            call_id: 'call_command',
            name: 'run_command',
            arguments: JSON.stringify({ command }),
          };
          response.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp-command-1', output: [call] } })}\n\n`);
          return;
        }
        response.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-command-2","output":[{"type":"message","content":[{"type":"output_text","text":"Command completed."}]}]}}\n\n');
      });
    });
    const baseUrl = await listen(server);
    const runtime = new DesktopDirectProviderRuntime(
      settingsPort(enabledSettings(baseUrl, 'test-model')),
      credentialPort('provider.openai', 'sk-test-secret'),
    );
    const approvals: string[] = [];

    const result = await runtime.run(runRequest(), projectRoot, undefined, undefined, {
      request: async (approval) => {
        approvals.push(approval.tool);
        return true;
      },
    });

    expect(result).toMatchObject({ status: 'completed', output: 'Command completed.' });
    expect(approvals).toEqual(['run_command']);
    expect(bodies).toHaveLength(2);
    expect(JSON.stringify(bodies[1].input)).toContain('command-ok');
  });

  describe('publishing commands', () => {
    async function runFullControl(command: string, approve: boolean, autonomy: 'full' | 'custom' = 'full') {
      const projectRoot = await mkdtemp(path.join(tmpdir(), 'kai-direct-publish-'));
      temporaryDirectories.push(projectRoot);
      const bodies: Record<string, unknown>[] = [];
      let requestCount = 0;
      const server = http.createServer((request, response) => {
        let raw = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => { raw += chunk; });
        request.on('end', () => {
          requestCount += 1;
          bodies.push(JSON.parse(raw) as Record<string, unknown>);
          response.writeHead(200, { 'Content-Type': 'text/event-stream' });
          if (requestCount === 1) {
            const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'run_command', arguments: JSON.stringify({ command }) };
            response.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'r1', output: [call] } })}\n\n`);
            return;
          }
          response.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"r2","output":[{"type":"message","content":[{"type":"output_text","text":"Done."}]}]}}\n\n');
        });
      });
      const baseUrl = await listen(server);
      const runtime = new DesktopDirectProviderRuntime(
        settingsPort(enabledSettings(baseUrl, 'test-model')),
        credentialPort('provider.openai', 'sk-test-secret'),
      );
      const asked: Array<{ tool: string; title: string }> = [];
      await runtime.run({ ...runRequest(), autonomy }, projectRoot, undefined, undefined, {
        request: async (approval) => {
          asked.push({ tool: approval.tool, title: approval.title });
          return approve;
        },
      }, undefined, undefined, { shellCommand: true });
      return { asked, followUp: JSON.stringify(bodies[1]?.input) };
    }

    it('runs an ordinary command without asking', async () => {
      const { asked, followUp } = await runFullControl(nodeCommand("process.stdout.write('plain-ok')"), true);
      expect(asked).toEqual([]);
      expect(followUp).toContain('plain-ok');
    });

    it.each([
      'git push origin main',
      'git -C repo push --force-with-lease',
      'gh pr create --title x --body y',
      'npm publish',
    ])('runs "%s" without asking when the user chose Full access', async (command) => {
      const { asked } = await runFullControl(command, false);
      expect(asked).toEqual([]);
    });

    it.each([
      'git push origin main',
      'git -C repo push --force-with-lease',
      'gh pr create --title x --body y',
      'npm publish',
    ])('still asks before "%s" under custom permissions and does not run it when denied', async (command) => {
      const { asked, followUp } = await runFullControl(command, false, 'custom');
      expect(asked).toEqual([{ tool: 'run_command', title: 'Publish work off this machine?' }]);
      expect(followUp).toContain('The user denied this project change.');
    });
  });

  it('cancels an in-flight provider stream', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp-slow"}}\n\n');
      const timer = setInterval(() => response.write(': keep-alive\n\n'), 100);
      response.on('close', () => clearInterval(timer));
    });
    const baseUrl = await listen(server);
    const runtime = new DesktopDirectProviderRuntime(
      settingsPort(enabledSettings(baseUrl, 'test-model')),
      credentialPort('provider.openai', 'sk-test-secret'),
    );

    const pending = runtime.run(runRequest(), process.cwd());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(runtime.cancel('conv-direct')).toBe(true);

    // Same as the chat path: stopped, not broken.
    const outcome = await pending;
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toBeUndefined();
    expect(outcome.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'agent.lifecycle', status: 'cancelled' }),
    ]));
  });

  it('asks the user through ask_user and feeds the chosen option back as the tool result', async () => {
    const requests: Array<{ messages: Array<Record<string, unknown>> }> = [];
    const server = http.createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        const body = JSON.parse(raw) as { messages: Array<Record<string, unknown>> };
        requests.push(body);
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (requests.length === 1) {
          response.end(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_ask', name: 'ask_user', input: { question: 'Which branch should I use?', options: ['main', 'release'] } } })}

event: message_stop
data: {"type":"message_stop"}

`);
          return;
        }
        response.end('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Using main, as chosen."}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
      });
    });
    const baseUrl = await listen(server);
    const runtime = new DesktopDirectProviderRuntime(
      settingsPort(directProviderSettings(baseUrl, 'anthropic', 'claude-sonnet-5')),
      credentialPort('provider.anthropic', 'anthropic-secret'),
    );
    const approvalRequests: DirectApiApprovalRequest[] = [];
    const approvals = {
      request: async () => false,
      requestChoice: async (approval: DirectApiApprovalRequest) => {
        approvalRequests.push(approval);
        return 'main';
      },
    };

    const result = await runtime.run(runRequest(), process.cwd(), undefined, undefined, approvals);

    expect(result.status).toBe('completed');
    expect(result.output).toContain('Using main, as chosen.');
    expect(approvalRequests).toEqual([
      expect.objectContaining({ title: 'Which branch should I use?', options: ['main', 'release'] }),
    ]);
    const followUp = requests[1]!.messages;
    const toolResult = followUp.find((message) =>
      message.role === 'user'
      && Array.isArray(message.content)
      && (message.content as Array<Record<string, unknown>>).some((block) => block.type === 'tool_result'));
    expect(JSON.stringify(toolResult)).toContain('main');
  });

  it('asks the user through ask_user and reports it clearly when nobody is there to answer', async () => {
    let calls = 0;
    const server = http.createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        calls += 1;
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (calls === 1) {
          response.end(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_ask', name: 'ask_user', input: { question: 'Continue?', options: ['Yes', 'No'] } } })}

event: message_stop
data: {"type":"message_stop"}

`);
          return;
        }
        response.end('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Nobody answered, so I stopped here."}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
      });
    });
    const baseUrl = await listen(server);
    const runtime = new DesktopDirectProviderRuntime(
      settingsPort(directProviderSettings(baseUrl, 'anthropic', 'claude-sonnet-5')),
      credentialPort('provider.anthropic', 'anthropic-secret'),
    );

    // No approvals port at all: the same as a scheduled or unattended run.
    const result = await runtime.run(runRequest(), process.cwd());

    expect(result.status).toBe('completed');
    expect(result.output).toContain('Nobody answered, so I stopped here.');
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool.call',
        name: 'ask_user',
        status: 'failed',
        output: expect.objectContaining({ error: expect.stringContaining('Nobody answered') }),
      }),
    ]));
  });

  it('hands a question to explore and returns only its answer to the main run', async () => {
    const requests: Array<{ tools?: Array<{ name: string }>; messages: Array<Record<string, unknown>> }> = [];
    const server = http.createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        const body = JSON.parse(raw) as { tools?: Array<{ name: string }>; messages: Array<Record<string, unknown>> };
        requests.push(body);
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const toolNames = (body.tools ?? []).map((tool) => tool.name);
        const isExploreSubRun = toolNames.length > 0 && toolNames.every((name) => name === 'read_file' || name === 'search_files' || name === 'list_files');
        if (requests.length === 1) {
          // The main run's first turn: it hands the question off instead of reading files itself.
          response.end(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_explore', name: 'explore', input: { question: 'How does login work?' } } })}

event: message_stop
data: {"type":"message_stop"}

`);
          return;
        }
        if (isExploreSubRun) {
          response.end('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Login uses JWT in auth.ts."}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
          return;
        }
        // The main run's second turn, now holding the helper's answer as the tool result.
        response.end('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Done: login uses JWT."}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
      });
    });
    const baseUrl = await listen(server);
    const runtime = new DesktopDirectProviderRuntime(
      settingsPort(directProviderSettings(baseUrl, 'anthropic', 'claude-sonnet-5')),
      credentialPort('provider.anthropic', 'anthropic-secret'),
    );

    const result = await runtime.run(runRequest(), process.cwd());

    expect(result.status).toBe('completed');
    expect(result.output).toContain('Done: login uses JWT.');
    expect(requests).toHaveLength(3);
    // The helper was offered only the three read-only tools, never the full project tool set.
    expect(requests[1]!.tools).toHaveLength(3);
    expect(JSON.stringify(requests[1]!.messages)).toContain('How does login work?');
    // Its answer, not its (nonexistent, in this test) intermediate reads, is what reaches the main run.
    expect(JSON.stringify(requests[2]!.messages)).toContain('Login uses JWT in auth.ts.');
  });
});

function runRequest(): AgentRunRequest {
  return {
    conversationId: 'conv-direct',
    prompt: 'Inspect the project',
    agent: 'codex',
    execution: 'api',
    route: 'direct',
    autonomy: 'ask',
  };
}

function enabledSettings(baseUrl: string, model: string): AppSettings {
  const settings = createDefaultSettings();
  settings.directApi.enabled = true;
  settings.directApi.model = model;
  settings.directApi.baseUrl = baseUrl;
  return settings;
}

function chatProviderSettings(
  baseUrl: string,
  provider: AppSettings['directApi']['provider'],
  model: string,
): AppSettings {
  const settings = enabledSettings(baseUrl, model);
  settings.directApi.provider = provider;
  settings.directApi.credentialId = provider === 'openrouter' ? 'provider.openrouter' : 'provider.deepseek';
  return settings;
}

function directProviderSettings(
  baseUrl: string,
  provider: 'anthropic' | 'google',
  model: string,
): AppSettings {
  const settings = enabledSettings(baseUrl, model);
  settings.directApi.provider = provider;
  settings.directApi.credentialId = provider === 'anthropic' ? 'provider.anthropic' : 'provider.google';
  return settings;
}

function settingsPort(settings: AppSettings): { load(): Promise<AppSettings> } {
  return { load: async () => structuredClone(settings) };
}

function credentialPort(id?: string, value?: string): {
  isAvailable(): boolean;
  has(requestedId: string): Promise<boolean>;
  get(requestedId: string): Promise<string | undefined>;
} {
  return {
    isAvailable: () => true,
    has: async (requestedId) => requestedId === id,
    get: async (requestedId) => requestedId === id ? value : undefined,
  };
}

async function listen(server: http.Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind to a TCP port.');
  return `http://127.0.0.1:${address.port}/v1`;
}

async function readText(filePath: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(filePath, 'utf8');
}

function nodeCommand(script: string): string {
  return `"${process.execPath}" -e "${script}"`;
}
