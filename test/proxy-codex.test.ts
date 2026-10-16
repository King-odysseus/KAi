import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'http';
import { KaiProxyServer } from '../src/proxy/proxy-server';

const TEST_PROXY_TOKEN = 'codex-proxy-test-token';

const running: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (running.length > 0) {
    await running.pop()?.();
  }
});

function startUpstream(chunks: Array<Record<string, unknown>>): Promise<{ url: string }> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url !== '/chat/completions') {
        res.writeHead(404);
        res.end('{}');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const chunk of chunks) {
        res.write('data: ' + JSON.stringify(chunk) + '\n\n');
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      running.push(() => new Promise<void>(done => server.close(() => done())));
      resolve({ url: 'http://127.0.0.1:' + port });
    });
  });
}

async function startProxy(targetBaseUrl: string): Promise<number> {
  const server = new KaiProxyServer({
    port: 0,
    targetBaseUrl,
    apiKey: 'sk-test',
    defaultModel: 'deepseek-chat',
    modelMap: { 'gpt-5.5': 'deepseek-chat' },
    authToken: TEST_PROXY_TOKEN,
  });
  await server.start();
  running.push(() => server.stop());
  return server.getPort();
}

function request(
  port: number,
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: `Bearer ${TEST_PROXY_TOKEN}`,
      },
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

describe('Codex proxy compatibility', () => {
  it('advertises the top-level models array expected by Codex', async () => {
    const upstream = await startUpstream([]);
    const port = await startProxy(upstream.url);

    const result = await request(port, '/v1/models', 'GET');
    expect(result.status).toBe(200);
    // `slug` is not decoration: Codex's models manager hard-requires it on every
    // entry, and a list it cannot decode logs a refresh failure on every turn.
    expect(JSON.parse(result.body).models).toEqual([
      { id: 'deepseek-chat', slug: 'deepseek-chat', object: 'model', created: 1700000000, owned_by: 'kai' },
    ]);
  });

  it('handles Codex UAP-tagged model and response paths', async () => {
    const upstream = await startUpstream([
      { choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]);
    const port = await startProxy(upstream.url);

    const models = await request(port, '/a/codex/v1/models', 'GET');
    expect(models.status).toBe(200);
    expect(JSON.parse(models.body).models[0].slug).toBe('deepseek-chat');

    const response = await request(port, '/a/codex/v1/responses', 'POST', {
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply with OK' }] }],
      stream: true,
    });
    expect(response.status).toBe(200);
    expect(response.body).toContain('"text":"OK"');
  });

  it('emits Responses stream events Codex can render', async () => {
    const upstream = await startUpstream([
      { choices: [{ index: 0, delta: { content: 'O' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: 'K' }, finish_reason: null }] },
      {
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 2 },
      },
    ]);
    const port = await startProxy(upstream.url);

    const result = await request(port, '/v1/responses', 'POST', {
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply with OK' }] }],
      stream: true,
    });

    expect(result.status).toBe(200);
    expect(result.body).toContain('event: response.output_text.delta');
    expect(result.body).toContain('event: response.output_text.done');
    expect(result.body).toContain('event: response.output_item.done');
    expect(result.body).toContain('"text":"OK"');
    expect(result.body).toContain('"output":[{"type":"message"');
    expect(result.body).not.toContain('content_part.delta');
  });

  it('translates streamed tool calls into Responses output items', async () => {
    const upstream = await startUpstream([
      {
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_123',
              function: { name: 'shell', arguments: '{"cmd"' },
            }],
          },
          finish_reason: null,
        }],
      },
      {
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: ':"echo hi"}' } }],
          },
          finish_reason: 'tool_calls',
        }],
      },
    ]);
    const port = await startProxy(upstream.url);

    const result = await request(port, '/v1/responses', 'POST', {
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'list files' }] }],
      tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }],
      stream: true,
    });

    expect(result.status).toBe(200);
    expect(result.body).toContain('event: response.function_call_arguments.delta');
    expect(result.body).toContain('event: response.function_call_arguments.done');
    expect(result.body).toContain('"type":"function_call"');
    expect(result.body).toContain('"name":"shell"');
    expect(result.body).toContain('"arguments":"{\\"cmd\\":\\"echo hi\\"}"');
  });
});
