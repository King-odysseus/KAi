import {
  AnthropicRequest, AnthropicContentBlock, AnthropicMessage,
  OpenAIRequest, OpenAIMessage, OpenAITool,
  ProxyConfig
} from './types';

// ---- Request: OpenAI -> Anthropic ----

export function buildAnthropicRequestFromOpenAI(oaiReq: OpenAIRequest, config: ProxyConfig): AnthropicRequest {
  const targetModel = config.modelMap[oaiReq.model] ?? config.defaultModel ?? oaiReq.model;

  let system: string | undefined;
  const messages: AnthropicMessage[] = [];

  for (const msg of oaiReq.messages) {
    if (msg.role === 'system') {
      system = system ? system + '\n' + (msg.content ?? '') : (msg.content ?? '');
    } else if (msg.role === 'tool') {
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id ?? '', content: msg.content ?? '' }],
      });
    } else if (msg.role === 'assistant' && msg.tool_calls?.length) {
      const blocks: AnthropicContentBlock[] = [];
      if (msg.content) { blocks.push({ type: 'text', text: msg.content }); }
      for (const tc of msg.tool_calls) {
        try {
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments || '{}') });
        } catch {
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: {} });
        }
      }
      messages.push({ role: 'assistant', content: blocks });
    } else {
      messages.push({ role: msg.role as 'user' | 'assistant', content: msg.content ?? '' });
    }
  }

  const req: AnthropicRequest = { model: targetModel, messages, stream: oaiReq.stream ?? false };
  if (system) { req.system = system; }
  const maxTok = oaiReq.max_tokens ?? oaiReq.max_completion_tokens;
  if (maxTok) { req.max_tokens = maxTok; }
  if (oaiReq.temperature !== undefined) { req.temperature = oaiReq.temperature; }
  if (oaiReq.tools?.length) {
    req.tools = oaiReq.tools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
  }
  return req;
}

// ---- Response: Anthropic -> OpenAI (non-streaming) ----

const STOP_REASON_TO_FINISH: Record<string, string> = {
  end_turn: 'stop', max_tokens: 'length', tool_use: 'tool_calls',
};

export function buildOpenAIResponseFromAnthropic(anthropicRes: Record<string, unknown>, oaiModel: string): Record<string, unknown> {
  const content = anthropicRes.content as Array<Record<string, unknown>> | undefined;
  const textBlocks = content?.filter(b => b.type === 'text') ?? [];
  const text = textBlocks.map(b => (b.text as string) ?? '').join('');
  const stopReason = anthropicRes.stop_reason as string | undefined;
  const usage = anthropicRes.usage as Record<string, number> | undefined;

  // Map tool_use blocks to OpenAI tool_calls
  const toolUseBlocks = content?.filter(b => b.type === 'tool_use') ?? [];
  const toolCalls = toolUseBlocks.length > 0
    ? toolUseBlocks.map(b => ({
        id: (b.id as string) || randomHex(24),
        type: 'function',
        function: {
          name: (b.name as string) ?? '',
          arguments: JSON.stringify(b.input ?? {}),
        },
      }))
    : undefined;

  return {
    id: `chatcmpl_${randomHex(24)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: oaiModel,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: STOP_REASON_TO_FINISH[stopReason ?? 'end_turn'] ?? 'stop',
    }],
    usage: {
      prompt_tokens: usage?.input_tokens ?? 0,
      completion_tokens: usage?.output_tokens ?? 0,
      total_tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
    },
  };
}

// ---- Streaming: Anthropic SSE -> OpenAI SSE ----
//
// Stateful translator that tracks tool_use blocks across SSE events.
// Anthropic streams tool_use as: content_block_start (tool_use) ->
// content_block_delta (input_json_delta) -> content_block_stop ->
// (possibly more content blocks) -> message_delta -> message_stop.

class AnthropicStreamTranslator {
  private buffer = '';
  private activeBlock: { index: number; type: string; id: string; name: string; inputJson: string } | null = null;

  translate(line: string, msgId: string, oaiModel: string): string | null {
    if (!line.startsWith('data: ')) { return null; }
    const data = line.slice(6).trim();
    try {
      const event = JSON.parse(data) as Record<string, unknown>;
      const type = event.type as string;

      if (type === 'content_block_start') {
        const block = event.content_block as Record<string, unknown> | undefined;
        if (block?.type === 'tool_use') {
          this.activeBlock = {
            index: event.index as number ?? 0,
            type: 'tool_use',
            id: (block.id as string) || randomHex(24),
            name: (block.name as string) ?? '',
            inputJson: '',
          };
        }
        return null;
      }

      if (type === 'content_block_delta') {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (delta?.type === 'text_delta') {
          return oaiChunk(msgId, oaiModel, delta.text as string, null);
        }
        if (delta?.type === 'input_json_delta' && this.activeBlock?.type === 'tool_use') {
          this.activeBlock.inputJson += (delta.partial_json as string) ?? '';
          return null; // accumulated until block_stop
        }
      }

      if (type === 'content_block_stop') {
        if (this.activeBlock?.type === 'tool_use') {
          const tc = this.activeBlock;
          this.activeBlock = null;
          return oaiToolCallChunk(msgId, oaiModel, tc.index, tc.id, tc.name, tc.inputJson);
        }
        return null;
      }

      if (type === 'message_delta') {
        const delta = event.delta as Record<string, unknown> | undefined;
        const stop = STOP_REASON_TO_FINISH[delta?.stop_reason as string ?? ''] ?? 'stop';
        return oaiChunk(msgId, oaiModel, '', stop) + 'data: [DONE]\n\n';
      }
    } catch { /* ignore */ }
    return null;
  }
}

export function createAnthropicStreamTranslator(): AnthropicStreamTranslator {
  return new AnthropicStreamTranslator();
}

function oaiChunk(id: string, model: string, text: string, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta: text ? { content: text } : {}, finish_reason: finishReason }],
  })}\n\n`;
}

function oaiToolCallChunk(id: string, model: string, index: number, toolId: string, name: string, args: string): string {
  return `data: ${JSON.stringify({
    id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index,
          id: toolId,
          type: 'function',
          function: { name, arguments: args },
        }],
      },
      finish_reason: null,
    }],
  })}\n\n`;
}

// ---- Request: Anthropic -> OpenAI ----

function contentBlocksToText(blocks: AnthropicContentBlock[]): string {
  return blocks
    .map(b => {
      if (b.type === 'text') { return b.text; }
      if (b.type === 'tool_use') { return `[Tool call: ${b.name}(${JSON.stringify(b.input)})]`; }
      if (b.type === 'tool_result') {
        const c = typeof b.content === 'string' ? b.content
          : b.content.map(x => x.text).join('');
        return `[Tool result: ${c}]`;
      }
      return '';
    })
    .join('\n');
}

function toOpenAIMessages(anthropicBody: AnthropicRequest): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];

  if (anthropicBody.system) {
    const sys = anthropicBody.system;
    const text = typeof sys === 'string' ? sys
      : sys.map(b => (b.type === 'text' ? b.text : '')).join(' ');
    if (text.trim()) { messages.push({ role: 'system', content: text }); }
  }

  for (const msg of anthropicBody.messages) {
    const content = msg.content;
    if (typeof content === 'string') {
      messages.push({ role: msg.role, content });
    } else {
      messages.push({ role: msg.role, content: contentBlocksToText(content) });
    }
  }

  return messages;
}

const MAX_DESC_LENGTH = 2048;

function safeSlice(str: string, maxLen: number): string {
  if (str.length <= maxLen) { return str; }
  let end = maxLen;
  if (str.charCodeAt(end - 1) >= 0xD800 && str.charCodeAt(end - 1) <= 0xDBFF) {
    end--;
  }
  return str.slice(0, end);
}

function truncateDescriptions(obj: unknown, depth: number): unknown {
  if (depth > 20) { return obj; }
  if (Array.isArray(obj)) {
    return obj.map(item => truncateDescriptions(item, depth + 1));
  }
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (key === 'description' && typeof value === 'string' && value.length > MAX_DESC_LENGTH) {
        result[key] = safeSlice(value, MAX_DESC_LENGTH) + '...';
      } else {
        result[key] = truncateDescriptions(value, depth + 1);
      }
    }
    return result;
  }
  return obj;
}

function toOpenAITools(anthropicTools: AnthropicRequest['tools']): OpenAITool[] | undefined {
  if (!anthropicTools?.length) { return undefined; }
  return anthropicTools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: (t.description?.length ?? 0) > MAX_DESC_LENGTH
        ? safeSlice(t.description!, MAX_DESC_LENGTH) + '...'
        : t.description,
      parameters: truncateDescriptions(t.input_schema, 0) as Record<string, unknown>,
    }
  }));
}

export function buildOpenAIRequest(body: AnthropicRequest, config: ProxyConfig): OpenAIRequest {
  const targetModel = config.modelMap[body.model] ?? config.defaultModel;
  const req: OpenAIRequest = {
    model: targetModel,
    messages: toOpenAIMessages(body),
    stream: body.stream ?? false,
  };
  if (body.max_tokens) {
    req.max_tokens = body.max_tokens;
    req.max_completion_tokens = body.max_tokens;
  }
  if (body.temperature !== undefined) { req.temperature = body.temperature; }
  const tools = toOpenAITools(body.tools);
  if (tools) { req.tools = tools; }
  return req;
}

// ---- Response: OpenAI -> Anthropic (non-streaming) ----

const FINISH_REASON_MAP: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'end_turn',
};

export function buildAnthropicResponse(
  oaiBody: Record<string, unknown>,
  anthropicModel: string
): Record<string, unknown> {
  const choices = oaiBody.choices as Array<Record<string, unknown>>;
  const choice = choices?.[0] ?? {};
  const message = choice.message as Record<string, unknown> | undefined;
  const text = (message?.content as string) ?? '';
  const finishReason = (choice.finish_reason as string) ?? 'stop';
  const usage = oaiBody.usage as Record<string, number> | undefined;

  // Build content blocks: text + tool_use blocks from OpenAI tool_calls
  const content: Array<Record<string, unknown>> = [];
  if (text) {
    content.push({ type: 'text', text });
  }
  const toolCalls = message?.tool_calls as Array<Record<string, unknown>> | undefined;
  if (toolCalls) {
    for (const tc of toolCalls) {
      const fn = tc.function as Record<string, unknown> | undefined;
      let input = {};
      try {
        input = typeof fn?.arguments === 'string' ? JSON.parse(fn.arguments) : (fn?.arguments ?? {});
      } catch { /* */ }
      content.push({
        type: 'tool_use',
        id: (tc.id as string) || randomHex(24),
        name: fn?.name ?? '',
        input,
      });
    }
  }

  return {
    id: `msg_${randomHex(24)}`,
    type: 'message',
    role: 'assistant',
    content,
    model: anthropicModel,
    stop_reason: FINISH_REASON_MAP[finishReason] ?? 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? 0,
    },
  };
}

// ---- Streaming: OpenAI SSE -> Anthropic SSE ----

export function makeMessageStartEvent(msgId: string, model: string): string {
  return sseEvent('message_start', {
    type: 'message_start',
    message: {
      id: msgId, type: 'message', role: 'assistant',
      content: [], model,
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
}

export function makeContentBlockStartEvent(): string {
  return sseEvent('content_block_start', {
    type: 'content_block_start', index: 0,
    content_block: { type: 'text', text: '' },
  });
}

export function makePingEvent(): string {
  return sseEvent('ping', { type: 'ping' });
}

export function makeTextDeltaEvent(text: string): string {
  return sseEvent('content_block_delta', {
    type: 'content_block_delta', index: 0,
    delta: { type: 'text_delta', text },
  });
}

export function makeContentBlockStopEvent(): string {
  return sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 });
}

export function makeMessageDeltaEvent(stopReason: string, outputTokens: number): string {
  return sseEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
}

export function makeMessageStopEvent(): string {
  return sseEvent('message_stop', { type: 'message_stop' });
}

export function translateStreamChunk(line: string): { text?: string; finishReason?: string } | null {
  if (!line.startsWith('data: ')) { return null; }
  const data = line.slice(6).trim();
  if (data === '[DONE]') { return { finishReason: '_done' }; }
  try {
    const chunk = JSON.parse(data) as Record<string, unknown>;
    const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    if (!choice) { return null; }
    const delta = choice.delta as Record<string, unknown> | undefined;
    const text = delta?.content as string | undefined;
    const finishReason = choice.finish_reason as string | null | undefined;
    return {
      text: text || undefined,
      finishReason: finishReason ?? undefined,
    };
  } catch {
    return null;
  }
}

// ---- Helpers ----

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function randomHex(length: number): string {
  return Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

// ---- Token estimation ----

const CHARS_PER_TOKEN = 3.5;

export function estimateTokenCount(req: Record<string, unknown>): number {
  let chars = 0;

  const system = req.system;
  if (typeof system === 'string') {
    chars += system.length;
  } else if (Array.isArray(system)) {
    for (const b of system as Array<Record<string, unknown>>) {
      if (typeof b.text === 'string') chars += b.text.length;
    }
  }

  const messages = req.messages as Array<Record<string, unknown>> | undefined;
  if (messages) {
    for (const msg of messages) {
      const content = msg.content;
      if (typeof content === 'string') {
        chars += content.length;
      } else if (Array.isArray(content)) {
        for (const block of content as Array<Record<string, unknown>>) {
          if (typeof block.text === 'string') chars += block.text.length;
          if (block.input) chars += JSON.stringify(block.input).length;
          const tr = block.content;
          if (typeof tr === 'string') chars += tr.length;
          else if (Array.isArray(tr)) {
            for (const tb of tr as Array<Record<string, unknown>>) {
              if (typeof tb.text === 'string') chars += tb.text.length;
            }
          }
        }
      }
    }
  }

  const tools = req.tools as Array<Record<string, unknown>> | undefined;
  if (tools) {
    for (const t of tools) {
      chars += JSON.stringify(t).length;
    }
  }

  return Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN));
}