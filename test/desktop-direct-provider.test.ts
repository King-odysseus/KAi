import * as http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultSettings, type AgentRunRequest, type AppSettings } from '../packages/contracts/src';
import { DesktopDirectProviderRuntime } from '../apps/desktop/src/main/direct-provider-runtime';

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

    await expect(pending).resolves.toMatchObject({ status: 'failed', error: 'OpenRouter run cancelled.' });
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

  describe('publishing commands in Full control', () => {
    async function runFullControl(command: string, approve: boolean) {
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
      await runtime.run({ ...runRequest(), autonomy: 'full' }, projectRoot, undefined, undefined, {
        request: async (approval) => {
          asked.push({ tool: approval.tool, title: approval.title });
          return approve;
        },
      });
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
    ])('still asks before "%s" and does not run it when denied', async (command) => {
      const { asked, followUp } = await runFullControl(command, false);
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

    await expect(pending).resolves.toMatchObject({
      status: 'failed',
      error: 'OpenAI Responses API run cancelled.',
    });
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
