import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

// ---- Types (local, avoids VS Code dependency) ----

export interface ProxyServerConfig {
  port: number;
  targetBaseUrl: string;
  apiKey: string;
  defaultModel: string;
  modelMap: Record<string, string>;
  codexConfig?: {
    enabled?: boolean;
    baseUrl?: string;
    apiKey?: string;
    defaultModel?: string;
  };
}

// ---- HTTP helpers ----

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => { chunks.push(chunk); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function makeRequest(
  targetUrl: URL,
  options: http.RequestOptions,
  callback: (res: http.IncomingMessage) => void
): http.ClientRequest {
  return targetUrl.protocol === 'https:'
    ? https.request(options, callback)
    : http.request(options, callback);
}

function buildRequestOptions(
  targetUrl: URL,
  config: ProxyServerConfig,
  contentLength: number,
): http.RequestOptions {
  return {
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
    path: targetUrl.pathname + targetUrl.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': contentLength,
      'Authorization': 'Bearer ' + config.apiKey,
      'Accept': 'text/event-stream, application/json',
    },
    timeout: 300000,
  };
}

function isOpenAIResponseTarget(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return hostname === 'api.openai.com' || hostname.endsWith('.openai.com');
  } catch {
    return false;
  }
}

// ---- Responses API → Chat Completions translation ----

function randomHex(length: number): string {
  return Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

function responsesToChatCompletions(body: string): string {
  const req = JSON.parse(body) as Record<string, unknown>;
  const messages: Array<Record<string, unknown>> = [];

  const mapRole = (role: string): string => (role === 'developer' ? 'system' : role);

  if (typeof req.instructions === 'string' && req.instructions.length > 0) {
    messages.push({ role: 'system', content: req.instructions });
  }

  let pendingReasoning: string | null = null;
  const takeReasoning = (): Record<string, unknown> => {
    if (pendingReasoning === null) return {};
    const r = pendingReasoning;
    pendingReasoning = null;
    return { reasoning_content: r };
  };

  let openAssistant: Record<string, unknown> | null = null;
  const input = req.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input as Array<Record<string, unknown>>) {
      if (typeof item === 'string') {
        openAssistant = null;
        messages.push({ role: 'user', content: item });
      } else if ((item.type === 'message' || item.type === undefined) && typeof item.role === 'string') {
        const role = mapRole(item.role);
        const reasoning = role === 'assistant' ? takeReasoning() : {};
        const msgContent = item.content;
        let pushed: Record<string, unknown> | null = null;
        if (typeof msgContent === 'string') {
          pushed = { role, content: msgContent, ...reasoning };
        } else if (Array.isArray(msgContent)) {
          const parts: Array<{ type: string; text?: string }> = [];
          for (const part of msgContent as Array<Record<string, unknown>>) {
            if (part.type === 'output_text' || part.type === 'input_text') {
              parts.push({ type: 'text', text: part.text as string });
            }
          }
          if (parts.length === 1 && parts[0].text) {
            pushed = { role, content: parts[0].text, ...reasoning };
          } else {
            pushed = { role, content: parts, ...reasoning };
          }
        }
        if (pushed) messages.push(pushed);
        openAssistant = pushed && role === 'assistant' ? pushed : null;
      } else if (item.type === 'reasoning') {
        openAssistant = null;
        const enc = item.encrypted_content;
        if (typeof enc === 'string' && enc.length > 0) {
          pendingReasoning = enc;
        } else if (Array.isArray(item.summary)) {
          const txt = (item.summary as Array<Record<string, unknown>>)
            .map(s => (typeof s.text === 'string' ? s.text : '')).join('');
          if (txt) pendingReasoning = txt;
        }
      } else if (item.type === 'function_call') {
        const toolCall = {
          id: (item.call_id as string) || (item.id as string) || 'call_' + randomHex(24),
          type: 'function',
          function: { name: (item.name as string) || '', arguments: (item.arguments as string) || '{}' },
        };
        if (openAssistant) {
          const calls = (openAssistant.tool_calls as Array<unknown> | undefined) ?? [];
          calls.push(toolCall);
          openAssistant.tool_calls = calls;
          if (openAssistant.reasoning_content === undefined) Object.assign(openAssistant, takeReasoning());
        } else {
          openAssistant = { role: 'assistant', content: null, ...takeReasoning(), tool_calls: [toolCall] };
          messages.push(openAssistant);
        }
      } else if (item.type === 'function_call_output') {
        openAssistant = null;
        const out = item.output;
        messages.push({
          role: 'tool',
          tool_call_id: (item.call_id as string) || '',
          content: typeof out === 'string' ? out : JSON.stringify(out ?? ''),
        });
      }
    }
  }

  const chatReq: Record<string, unknown> = {
    model: req.model,
    messages,
    stream: req.stream ?? false,
  };

  if (req.max_output_tokens) chatReq.max_tokens = req.max_output_tokens;
  if (req.temperature !== undefined) chatReq.temperature = req.temperature;
  if (req.top_p !== undefined) chatReq.top_p = req.top_p;
  if (Array.isArray(req.tools)) {
    const tools = (req.tools as Array<Record<string, unknown>>).map(t => {
      if (t?.type === 'function' && typeof t.name === 'string') {
        return {
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        };
      }
      if (t?.type === 'function' && t.function) return t;
      return null;
    }).filter((t): t is NonNullable<typeof t> => t !== null);
    if (tools.length > 0) chatReq.tools = tools;
  }
  if (req.tool_choice && typeof req.tool_choice === 'string') chatReq.tool_choice = req.tool_choice;

  return JSON.stringify(chatReq);
}

// ---- Chat Completions response → Responses API format ----

function chatToResponsesNonStreaming(chatData: Record<string, unknown>, reqModel: string): Record<string, unknown> {
  const respId = 'resp_' + randomHex(24);
  const choices = chatData.choices as Array<Record<string, unknown>> | undefined;
  const choice = choices?.[0];
  const chatMessage = choice?.message as Record<string, unknown> | undefined;
  const output: Array<Record<string, unknown>> = [];

  if (chatMessage) {
    const msgId = 'msg_' + randomHex(24);
    const content: Array<Record<string, unknown>> = [];

    const reasoning = chatMessage.reasoning_content;
    if (typeof reasoning === 'string' && reasoning.length > 0) {
      output.push({
        type: 'reasoning', id: 'rs_' + randomHex(24),
        summary: [{ type: 'summary_text', text: reasoning }],
        encrypted_content: reasoning,
      });
    }

    if (typeof chatMessage.content === 'string' && chatMessage.content.length > 0) {
      content.push({ type: 'output_text', text: chatMessage.content, annotations: [] });
    }

    if (content.length > 0) {
      output.push({ type: 'message', id: msgId, status: 'completed', role: 'assistant', content });
    }

    const toolCalls = chatMessage.tool_calls as Array<Record<string, unknown>> | undefined;
    if (toolCalls) {
      for (const tc of toolCalls) {
        const fn = tc.function as Record<string, unknown> | undefined;
        output.push({
          type: 'function_call', status: 'completed',
          id: 'fc_' + randomHex(24), call_id: tc.id,
          name: fn?.name || '', arguments: fn?.arguments || '',
        });
      }
    }
  }

  const usage = chatData.usage as Record<string, number> | undefined;
  return {
    id: respId,
    object: 'response',
    created_at: chatData.created || Math.floor(Date.now() / 1000),
    status: 'completed',
    model: chatData.model || reqModel,
    output,
    usage: usage ? {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0,
    } : null,
  };
}

// ---- Streaming: Chat Completions SSE → Responses SSE ----

function translateChatStreamToResponses(
  res: http.ServerResponse,
  chatStream: http.IncomingMessage,
  reqModel: string
): void {
  const respId = 'resp_' + randomHex(24);
  const msgId = 'msg_' + randomHex(24);

  // Send response.created
  res.write('event: response.created\ndata: ' + JSON.stringify({
    type: 'response.created',
    response: { id: respId, object: 'response', status: 'in_progress', model: reqModel, output: [] },
  }) + '\n\n');

  let buffer = '';
  let outputTokens = 0;
  let sentContentBlock = false;

  chatStream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf-8');
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') {
        // Send output_item.done + response.completed
        if (sentContentBlock) {
          res.write('event: output_item.done\ndata: ' + JSON.stringify({
            type: 'output_item.done', item: { type: 'message', id: msgId, status: 'completed' },
          }) + '\n\n');
        }
        res.write('event: response.completed\ndata: ' + JSON.stringify({
          type: 'response.completed',
          response: {
            id: respId, object: 'response', status: 'completed', model: reqModel,
            usage: { input_tokens: 0, output_tokens: outputTokens, total_tokens: outputTokens },
          },
        }) + '\n\n');
        continue;
      }
      try {
        const chunk = JSON.parse(data) as Record<string, unknown>;
        const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
        const choice = choices?.[0];
        if (!choice) continue;

        const delta = choice.delta as Record<string, unknown> | undefined;
        const text = delta?.content as string | undefined;

        if (text) {
          if (!sentContentBlock) {
            sentContentBlock = true;
            res.write('event: output_item.added\ndata: ' + JSON.stringify({
              type: 'output_item.added',
              item: { type: 'message', id: msgId, status: 'in_progress', role: 'assistant', content: [] },
            }) + '\n\n');
            res.write('event: content_part.added\ndata: ' + JSON.stringify({
              type: 'content_part.added', item_id: msgId, part: { type: 'output_text', text: '', annotations: [] },
            }) + '\n\n');
          }
          outputTokens += Math.ceil(text.length / 3.5);
          res.write('event: content_part.delta\ndata: ' + JSON.stringify({
            type: 'content_part.delta', item_id: msgId, delta: text,
          }) + '\n\n');
        }
      } catch { /* skip unparseable chunks */ }
    }
  });

  chatStream.on('end', () => {
    if (!res.writableEnded) res.end();
  });

  chatStream.on('error', () => {
    if (!res.writableEnded) res.end();
  });
}

// ---- Proxy Server ----

export class KaiProxyServer {
  private server: http.Server | null = null;
  private config: ProxyServerConfig;

  constructor(config: ProxyServerConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        void this.handleRequest(req, res);
      });

      this.server.on('error', (err) => {
        reject(err);
      });

      this.server.listen(this.config.port, '127.0.0.1', () => {
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) { resolve(); return; }
      this.server.close(() => resolve());
      this.server = null;
    });
  }

  getPort(): number {
    return this.config.port;
  }

  isRunning(): boolean {
    return this.server?.listening ?? false;
  }

  updateConfig(config: Partial<ProxyServerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsed = new URL(req.url || '/', 'http://localhost');
    const pathname = parsed.pathname;

    // Health check
    if (req.method === 'GET' && pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', port: this.config.port }));
      return;
    }

    // Model list (for OpenAI-compatible clients)
    if (req.method === 'GET' && pathname === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [{ id: this.config.defaultModel, object: 'model', created: 1700000000, owned_by: 'kai' }],
      }));
      return;
    }

    // Codex Responses API
    if (req.method === 'POST' && pathname === '/v1/responses') {
      await this.handleResponses(req, res);
      return;
    }

    // Chat Completions (passthrough)
    if (req.method === 'POST' && pathname === '/v1/chat/completions') {
      await this.handleChatCompletions(req, res);
      return;
    }

    // Anthropic Messages (translate → Chat Completions)
    if (req.method === 'POST' && pathname === '/v1/messages') {
      await this.handleAnthropicMessages(req, res);
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Not found: ' + pathname, type: 'not_found' } }));
  }

  private async handleResponses(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: string;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: { message: 'Failed to read body' } }));
      return;
    }

    let origModel = 'unknown';
    try { origModel = JSON.parse(body).model || 'unknown'; } catch { /* */ }

    // Resolve Codex config
    const codexCfg = this.config.codexConfig;
    let targetBaseUrl = this.config.targetBaseUrl;
    let apiKey = this.config.apiKey;
    let defaultModel = this.config.defaultModel;

    if (codexCfg?.enabled) {
      const hasCustomBackend = codexCfg.baseUrl
        && codexCfg.baseUrl !== 'https://api.openai.com/v1'
        && codexCfg.apiKey;
      targetBaseUrl = hasCustomBackend ? codexCfg.baseUrl! : this.config.targetBaseUrl;
      apiKey = hasCustomBackend ? codexCfg.apiKey! : this.config.apiKey;
      defaultModel = codexCfg.defaultModel || this.config.defaultModel;
    }

    // Model mapping
    const targetModel = this.config.modelMap[origModel] || defaultModel || origModel;
    let mappedBody = body;
    if (targetModel !== origModel) {
      try {
        const parsed = JSON.parse(body);
        parsed.model = targetModel;
        mappedBody = JSON.stringify(parsed);
      } catch { /* forward original */ }
    }

    const activeConfig: ProxyServerConfig = { ...this.config, targetBaseUrl, apiKey, defaultModel };

    try {
      if (isOpenAIResponseTarget(targetBaseUrl)) {
        // Native Responses API — passthrough
    const targetUrl = new URL('responses', targetBaseUrl.replace(/\/+$/, '') + '/');
        await this.proxyPassthrough(res, targetUrl, mappedBody, activeConfig);
      } else {
        // Non-OpenAI target — translate Responses → Chat Completions
        const isStream = (() => {
          try { return !!(JSON.parse(mappedBody) as { stream?: boolean }).stream; } catch { return false; }
        })();
        const chatBody = responsesToChatCompletions(mappedBody);
    const targetUrl = new URL('chat/completions', targetBaseUrl.replace(/\/+$/, '') + '/');

        if (isStream) {
          await this.proxyStreamingTranslated(res, targetUrl, chatBody, origModel, activeConfig);
        } else {
          await this.proxyNonStreamingTranslated(res, targetUrl, chatBody, origModel, activeConfig);
        }
      }
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Upstream error: ' + (err instanceof Error ? err.message : String(err)) } }));
      }
    }
  }

  private async handleChatCompletions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: string;
    try { body = await readBody(req); } catch {
      res.writeHead(400); res.end(JSON.stringify({ error: { message: 'Failed to read body' } })); return;
    }

    // DeepSeek's Anthropic endpoint drops tool_calls from streaming responses.
    // Strip tools and add a system note so the model describes actions as text.
    try {
      const parsed = JSON.parse(body);
      if (parsed.tools && parsed.tools.length > 0) {
        const toolNames = parsed.tools.map((t: any) => t.function?.name).filter(Boolean).join(', ');
        delete parsed.tools;
        delete parsed.tool_choice;
        if (toolNames) {
          const toolNote = '\n\nYou have access to these tools: ' + toolNames + '. Instead of calling them, describe the tool call you would make using this format on its own line:\n[TOOL_CALL: tool_name]\n{"arg": "value"}\nThe user will execute the tool and return the result.';
          const msgs = parsed.messages as Array<Record<string, unknown>>;
          if (msgs && msgs.length > 0 && msgs[0].role === 'system') {
            msgs[0].content = (msgs[0].content as string || '') + toolNote;
          } else {
            msgs.unshift({ role: 'system', content: toolNote });
          }
        }
        // Force text-only response — DeepSeek otherwise returns empty tool_calls
        parsed.tool_choice = "none";
        body = JSON.stringify(parsed);
      }
    } catch { /* forward original */ }

    // Map model name to a DeepSeek-supported model
    try {
      const parsed = JSON.parse(body);
      const origModel = parsed.model as string;
      const targetModel = this.config.modelMap[origModel] || this.config.defaultModel;
      if (targetModel && targetModel !== origModel) {
        parsed.model = targetModel;
        body = JSON.stringify(parsed);
      }
    } catch { /* forward original */ }

    const targetUrl = new URL('chat/completions', this.config.targetBaseUrl.replace(/\/+$/, '') + '/');
    await this.proxyPassthrough(res, targetUrl, body, this.config);
  }

  private async handleAnthropicMessages(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: string;
    try { body = await readBody(req); } catch {
      res.writeHead(400); res.end(JSON.stringify({ error: { message: 'Failed to read body' } })); return;
    }

    // Translate Anthropic → Chat Completions using the translator
    const anthropicReq = JSON.parse(body) as Record<string, unknown>;
    const targetModel = this.config.modelMap[anthropicReq.model as string] || this.config.defaultModel;

    const messages: Array<Record<string, unknown>> = [];
    if (anthropicReq.system) {
      const sys = anthropicReq.system;
      const text = typeof sys === 'string' ? sys
        : (sys as Array<{ type: string; text?: string }>).map(b => (b.type === 'text' ? b.text : '')).join(' ');
      if (text.trim()) messages.push({ role: 'system', content: text });
    }

    const anthropicMsgs = anthropicReq.messages as Array<Record<string, unknown>>;
    if (anthropicMsgs) {
      for (const msg of anthropicMsgs) {
        const content = msg.content;
        if (typeof content === 'string') {
          messages.push({ role: msg.role, content });
        } else if (Array.isArray(content)) {
          const text = (content as Array<Record<string, unknown>>)
            .map(b => b.type === 'text' ? b.text : '').join('\n');
          messages.push({ role: msg.role, content: text });
        }
      }
    }

    const chatReq: Record<string, unknown> = {
      model: targetModel,
      messages,
      stream: anthropicReq.stream ?? false,
    };
    if (anthropicReq.max_tokens) {
      chatReq.max_tokens = anthropicReq.max_tokens;
      chatReq.max_completion_tokens = anthropicReq.max_tokens;
    }
    if (anthropicReq.temperature !== undefined) chatReq.temperature = anthropicReq.temperature;

    const chatBody = JSON.stringify(chatReq);
    const targetUrl = new URL('chat/completions', this.config.targetBaseUrl.replace(/\/+$/, '') + '/');

    // Stream Anthropic SSE back
    const options = buildRequestOptions(targetUrl, this.config, Buffer.byteLength(chatBody));
    const proxyReq = makeRequest(targetUrl, options, (proxyRes) => {
      if (proxyRes.statusCode !== 200) {
        let data = '';
        proxyRes.on('data', c => { data += c; });
        proxyRes.on('end', () => {
          res.writeHead(proxyRes.statusCode || 500, { 'Content-Type': 'application/json' });
          res.end(data);
        });
        return;
      }

      const msgId = 'msg_' + randomHex(24);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      // Send message_start
      res.write('event: message_start\ndata: ' + JSON.stringify({
        type: 'message_start',
        message: { id: msgId, type: 'message', role: 'assistant', content: [], model: anthropicReq.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
      }) + '\n\n');

      res.write('event: content_block_start\ndata: ' + JSON.stringify({
        type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
      }) + '\n\n');

      let buffer = '';
      proxyRes.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8');
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            res.write('event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: 0 }) + '\n\n');
            res.write('event: message_delta\ndata: ' + JSON.stringify({
              type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 },
            }) + '\n\n');
            res.write('event: message_stop\ndata: ' + JSON.stringify({ type: 'message_stop' }) + '\n\n');
            continue;
          }
          try {
            const chunk = JSON.parse(data) as Record<string, unknown>;
            const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
            const choice = choices?.[0];
            const delta = choice?.delta as Record<string, unknown> | undefined;
            const text = delta?.content as string | undefined;
            if (text) {
              res.write('event: content_block_delta\ndata: ' + JSON.stringify({
                type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text },
              }) + '\n\n');
            }
          } catch { /* */ }
        }
      });

      proxyRes.on('end', () => { if (!res.writableEnded) res.end(); });
      proxyRes.on('error', () => { if (!res.writableEnded) res.end(); });
    });

    proxyReq.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Upstream unreachable' } }));
      }
    });
    proxyReq.write(chatBody);
    proxyReq.end();
  }

  // ---- Proxy helpers ----

  private proxyPassthrough(
    res: http.ServerResponse, targetUrl: URL, body: string, config: ProxyServerConfig,
  ): Promise<void> {
    return new Promise((resolve) => {
      const options = buildRequestOptions(targetUrl, config, Buffer.byteLength(body));
      const proxyReq = makeRequest(targetUrl, options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        proxyRes.pipe(res);
        proxyRes.on('end', resolve);
        proxyRes.on('error', () => { if (!res.writableEnded) res.end(); resolve(); });
      });
      proxyReq.on('error', () => {
        if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ error: 'Upstream unreachable' })); }
        resolve();
      });
      proxyReq.write(body);
      proxyReq.end();
    });
  }

  private proxyNonStreamingTranslated(
    res: http.ServerResponse, targetUrl: URL, chatBody: string, reqModel: string, config: ProxyServerConfig,
  ): Promise<void> {
    return new Promise((resolve) => {
      const options = buildRequestOptions(targetUrl, config, Buffer.byteLength(chatBody));
      const proxyReq = makeRequest(targetUrl, options, (proxyRes) => {
        let data = '';
        proxyRes.on('data', c => { data += c; });
        proxyRes.on('end', () => {
          if (proxyRes.statusCode !== 200) {
            res.writeHead(proxyRes.statusCode || 500, { 'Content-Type': 'application/json' });
            res.end(data);
            resolve();
            return;
          }
          try {
            const chatData = JSON.parse(data);
            const responsesData = chatToResponsesNonStreaming(chatData, reqModel);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(responsesData));
          } catch {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Failed to translate response' } }));
          }
          resolve();
        });
        proxyRes.on('error', () => { if (!res.writableEnded) res.end(); resolve(); });
      });
      proxyReq.on('error', () => {
        if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ error: 'Upstream unreachable' })); }
        resolve();
      });
      proxyReq.write(chatBody);
      proxyReq.end();
    });
  }

  private proxyStreamingTranslated(
    res: http.ServerResponse, targetUrl: URL, chatBody: string, reqModel: string, config: ProxyServerConfig,
  ): Promise<void> {
    return new Promise((resolve) => {
      const options = buildRequestOptions(targetUrl, config, Buffer.byteLength(chatBody));
      const proxyReq = makeRequest(targetUrl, options, (proxyRes) => {
        if (proxyRes.statusCode !== 200) {
          let data = '';
          proxyRes.on('data', c => { data += c; });
          proxyRes.on('end', () => {
            res.writeHead(proxyRes.statusCode || 500, { 'Content-Type': 'application/json' });
            res.end(data);
            resolve();
          });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        translateChatStreamToResponses(res, proxyRes, reqModel);
        resolve();
      });
      proxyReq.on('error', () => {
        if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ error: 'Upstream unreachable' })); }
        resolve();
      });
      proxyReq.write(chatBody);
      proxyReq.end();
    });
  }
}
