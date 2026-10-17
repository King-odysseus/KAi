import * as http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultSettings, type AgentRunRequest, type AppSettings, type PersistedEvent } from '../packages/contracts/src';
import { DesktopDirectProviderRuntime, appendUserInput } from '../apps/desktop/src/main/direct-provider-runtime';
import {
  clearInterjections,
  interject,
  interjectionImages,
  setInterjectionActive,
  steeringInstructionFor,
  takeDeliveredInterjections,
  takeInterjectionMessage,
} from '../apps/desktop/src/main/interjections';

/**
 * A message steered into a run in progress used to carry its words and nothing else: the image attached beside it
 * was dropped before the run ever saw it, and the model answered "no image came through". These tests put a steered
 * message on each protocol the run loops itself and read what the provider is actually sent.
 */

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUg==';
const CONVERSATION = 'conv-steer';

const servers: http.Server[] = [];
const directories: string[] = [];
let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(path.join(tmpdir(), 'kai-steer-images-'));
  directories.push(projectRoot);
  setInterjectionActive(CONVERSATION, true);
});

afterEach(async () => {
  clearInterjections(CONVERSATION);
  takeDeliveredInterjections(CONVERSATION);
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function request(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return { conversationId: CONVERSATION, prompt: 'Inspect the project', agent: 'codex', execution: 'api', route: 'direct', autonomy: 'ask', ...overrides };
}

function settingsFor(baseUrl: string, provider: AppSettings['directApi']['provider'], model: string, credentialId: string): AppSettings {
  const settings = createDefaultSettings();
  settings.directApi = { enabled: true, provider, model, baseUrl, credentialId };
  return settings;
}

function runtimeFor(settings: AppSettings, credentialId: string): DesktopDirectProviderRuntime {
  return new DesktopDirectProviderRuntime(
    { load: async () => structuredClone(settings) },
    {
      isAvailable: () => true,
      has: async (id) => id === credentialId,
      get: async (id) => (id === credentialId ? 'test-key' : undefined),
    },
  );
}

type Body = Record<string, unknown>;

async function serve(respond: (body: Body, index: number) => { status: number; text: string }): Promise<{ baseUrl: string; requests: Body[] }> {
  const requests: Body[] = [];
  const server = http.createServer((incoming, outgoing) => {
    let raw = '';
    incoming.setEncoding('utf8');
    incoming.on('data', (chunk) => { raw += chunk; });
    incoming.on('end', () => {
      const body = JSON.parse(raw) as Body;
      requests.push(body);
      const { status, text } = respond(body, requests.length);
      outgoing.writeHead(status, { 'Content-Type': status === 200 ? 'text/event-stream' : 'application/json' });
      outgoing.end(text);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind to a TCP port.');
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests };
}

const CHAT_OK = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
const RESPONSES_OK = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}}\n\n';
const ANTHROPIC_OK = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
const GEMINI_OK = 'data: {"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"},"finishReason":"STOP"}]}\n\n';

const IMAGE_CHIP = { type: 'image' as const, name: 'shot.png', path: 'attachments/shot.png', dataUrl: PNG };

function steer(): Promise<boolean> {
  return interject(CONVERSATION, 'also look at this', {
    context: 'Files the user pointed at: src/a.ts',
    attachments: [{ name: 'shot.png', dataUrl: PNG }],
  });
}

function noticeMessages(events: readonly PersistedEvent[]): string[] {
  return events.flatMap((event) => (event.type === 'notice' ? [event.message] : []));
}

describe('a steered message keeps its attachments', () => {
  it('reaches a chat run with the image beside the words', async () => {
    const { baseUrl, requests } = await serve(() => ({ status: 200, text: CHAT_OK }));
    const delivered = steer();
    const result = await runtimeFor(settingsFor(baseUrl, 'deepseek', 'deepseek-flash', 'provider.deepseek'), 'provider.deepseek').run(request(), projectRoot);

    expect(result.status).toBe('completed');
    const messages = requests[0]!.messages as Array<{ role: string; content: unknown }>;
    const last = messages.at(-1)!;
    expect(last.role).toBe('user');
    const parts = last.content as Array<Record<string, unknown>>;
    expect(parts[0]).toMatchObject({ type: 'text', text: expect.stringContaining('also look at this') });
    expect(String(parts[0]!.text)).toContain('Files the user pointed at: src/a.ts');
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: PNG } });
    await expect(delivered).resolves.toBe(true);
  });

  it('reaches a Responses run as an input_image part of the same user message', async () => {
    const { baseUrl, requests } = await serve(() => ({ status: 200, text: RESPONSES_OK }));
    const delivered = steer();
    const result = await runtimeFor(settingsFor(baseUrl, 'openai', 'test-model', 'provider.openai'), 'provider.openai').run(request(), projectRoot);

    expect(result.status).toBe('completed');
    const input = requests[0]!.input as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(input).toHaveLength(1);
    expect(input[0]!.role).toBe('user');
    expect(String(input[0]!.content[0]!.text)).toContain('also look at this');
    expect(input[0]!.content[1]).toEqual({ type: 'input_image', image_url: PNG });
    await expect(delivered).resolves.toBe(true);
  });

  it('reaches an Anthropic run as a base64 image block', async () => {
    const { baseUrl, requests } = await serve(() => ({ status: 200, text: ANTHROPIC_OK }));
    const delivered = steer();
    const result = await runtimeFor(settingsFor(baseUrl, 'anthropic', 'claude-test', 'provider.anthropic'), 'provider.anthropic').run(request(), projectRoot);

    expect(result.status).toBe('completed');
    const messages = requests[0]!.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    const last = messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(last.content.at(-1)).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 } });
    await expect(delivered).resolves.toBe(true);
  });

  it('reaches a Gemini run as inline data', async () => {
    const { baseUrl, requests } = await serve(() => ({ status: 200, text: GEMINI_OK }));
    const delivered = steer();
    const result = await runtimeFor(settingsFor(baseUrl, 'google', 'gemini-test', 'provider.google'), 'provider.google').run(request(), projectRoot);

    expect(result.status).toBe('completed');
    const contents = requests[0]!.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    const last = contents.at(-1)!;
    expect(last.role).toBe('user');
    expect(last.parts.at(-1)).toEqual({ inline_data: { mime_type: 'image/png', data: PNG_BASE64 } });
    await expect(delivered).resolves.toBe(true);
  });

  it('is recorded with its attachments for the transcript, without the context built for the model', async () => {
    const { baseUrl } = await serve(() => ({ status: 200, text: CHAT_OK }));
    void steer();
    await runtimeFor(settingsFor(baseUrl, 'deepseek', 'deepseek-flash', 'provider.deepseek'), 'provider.deepseek').run(request(), projectRoot);

    const recorded = takeDeliveredInterjections(CONVERSATION);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.text).toBe('also look at this');
    expect(recorded[0]!.attachments).toEqual([{ name: 'shot.png', dataUrl: PNG }]);
    // The transcript shows what was typed. The context belongs to the request, and is recorded separately.
    expect(recorded[0]!.text).not.toContain('Files the user pointed at');
  });

  it('puts an image on the Responses message appended between rounds', () => {
    const toolResult = { type: 'function_call_output', call_id: 'call-1', output: 'done' };
    const image = { mediaType: 'image/png', base64: PNG_BASE64 };
    expect(appendUserInput([toolResult], 'look', [image])).toEqual([
      toolResult,
      { role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_image', image_url: PNG }] },
    ]);
    // A string input has no room for an image, so it becomes a user message of parts.
    expect(appendUserInput('Inspect the project', 'look', [image])).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Inspect the project\n\nUser update: look' }, { type: 'input_image', image_url: PNG }] },
    ]);
    // With nothing attached it is exactly what it always was.
    expect(appendUserInput('Inspect the project', 'look')).toBe('Inspect the project\n\nUser update: look');
  });

  it('sends only readable images, and gives an image sent alone its own words', () => {
    void interject(CONVERSATION, '', {
      attachments: [{ name: 'a.png', dataUrl: PNG }, { name: 'b.svg', dataUrl: 'data:image/svg+xml;base64,AAAA' }],
    });
    const message = takeInterjectionMessage(CONVERSATION)!;
    // An image alone is a complete message, so it is never empty and never refused for having no words.
    expect(message.text).toBe('Please look at the attached image.');
    // A drawing is not something the vision models take, so it is left out rather than sent to be refused.
    expect(interjectionImages(message)).toEqual([{ mediaType: 'image/png', base64: PNG_BASE64 }]);
    expect(steeringInstructionFor(message)).toContain('Please look at the attached image.');
  });

  it('is refused only when there is neither a word nor an image to say', async () => {
    await expect(interject(CONVERSATION, '   ')).resolves.toBe(false);
    await expect(interject('conv-not-running', 'hello', { attachments: [{ name: 'a.png', dataUrl: PNG }] })).resolves.toBe(false);
  });
});

describe('an image sent on the Responses API', () => {
  it('is attached to the first message instead of being described in the prompt', async () => {
    const { baseUrl, requests } = await serve(() => ({ status: 200, text: RESPONSES_OK }));
    const result = await runtimeFor(settingsFor(baseUrl, 'openai', 'test-model', 'provider.openai'), 'provider.openai')
      .run(request({ contextChips: [IMAGE_CHIP] }), projectRoot);

    expect(result.status).toBe('completed');
    expect(requests[0]!.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Inspect the project' }, { type: 'input_image', image_url: PNG }] },
    ]);
  });

  it('is dropped when the model refuses it, and the person and the model are both told', async () => {
    const { baseUrl, requests } = await serve((body) => (
      JSON.stringify(body).includes('input_image')
        ? { status: 400, text: '{"error":{"message":"This model does not support image input."}}' }
        : { status: 200, text: RESPONSES_OK }
    ));
    const result = await runtimeFor(settingsFor(baseUrl, 'openai', 'test-model', 'provider.openai'), 'provider.openai')
      .run(request({ contextChips: [IMAGE_CHIP] }), projectRoot);

    expect(result.status).toBe('completed');
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1])).not.toContain('input_image');
    // The model is told what happened, so it says so instead of searching the disk for the file.
    expect(JSON.stringify(requests[1])).toContain('do not search the file system for it');
    // And the person sees it in the transcript, not only in a status line.
    expect(noticeMessages(result.events).some((message) => message.includes('would not take the attached image'))).toBe(true);
  });
});

describe('an image refused on a chat run', () => {
  it('is dropped with a visible notice and a note to the model', async () => {
    const { baseUrl, requests } = await serve((body) => (
      JSON.stringify(body).includes('image_url')
        ? { status: 400, text: '{"error":{"message":"image_url is not supported by this model"}}' }
        : { status: 200, text: CHAT_OK }
    ));
    const result = await runtimeFor(settingsFor(baseUrl, 'deepseek', 'deepseek-v4-pro', 'provider.deepseek'), 'provider.deepseek')
      .run(request({ contextChips: [IMAGE_CHIP] }), projectRoot);

    expect(result.status).toBe('completed');
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1])).not.toContain('image_url');
    expect(JSON.stringify(requests[1])).toContain('do not search the file system for it');
    expect(noticeMessages(result.events).some((message) => message.includes('deepseek-v4-pro'))).toBe(true);
  });
});
