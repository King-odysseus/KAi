import { normalizeToolResult } from '../apps/desktop/src/main/mcp-runtime';
import { describe, expect, it } from 'vitest';
import type { AgentRunRequest } from '@kai/contracts';
import {
  toolOutputImages,
  anthropicImagePart,
  attachedImages,
  geminiImagePart,
  hasImageParts,
  isImageRefusal,
  openAiImagePart,
  parseImageDataUrl,
  withoutImageParts,
} from '../apps/desktop/src/main/image-attachments';
import { anthropicToolOutput, chatToolOutput, functionCallOutput, anthropicMessages, chatMessages } from '../apps/desktop/src/main/direct-provider-runtime';

/**
 * The Direct API path had no image channel at all: the composer named the attachment in the prompt, the model asked
 * to read that path, `read_file` refused a PNG as binary, and the run improvised with a browser. The models can see —
 * `deepseek-flash` is DeepSeek's native-vision model and the one configured here — KAI simply never sent the bytes.
 */

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

function imageChip(dataUrl = PNG) {
  return { type: 'image' as const, name: 'shot.png', path: 'attachments/shot.png', dataUrl };
}

function request(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    conversationId: 'conv-images',
    prompt: 'What is wrong with this page?',
    agent: 'codex',
    execution: 'api',
    route: 'direct',
    autonomy: 'ask',
    ...overrides,
  };
}

describe('the images attached to a run', () => {
  it('reads the bytes the composer already carries', () => {
    expect(attachedImages([imageChip()])).toEqual([{ mediaType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUg==' }]);
  });

  it('takes only what a vision model accepts', () => {
    for (const media of ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']) {
      expect(parseImageDataUrl(`data:${media};base64,AAAA`)).toEqual({ mediaType: media, base64: 'AAAA' });
    }
    // A drawing is a document, not something these models take, and a chip with no bytes is nothing to send.
    expect(parseImageDataUrl('data:image/svg+xml;base64,AAAA')).toBeNull();
    expect(parseImageDataUrl('data:text/plain;base64,AAAA')).toBeNull();
    expect(parseImageDataUrl('data:image/png;base64,')).toBeNull();
    expect(parseImageDataUrl('https://example.com/shot.png')).toBeNull();
    expect(parseImageDataUrl(undefined)).toBeNull();
  });

  it('leaves out the chips that are not images', () => {
    const images = attachedImages([
      { type: 'file', path: 'src/app.ts' },
      imageChip(),
      { type: 'memory', query: 'pages', summary: 'nothing' },
    ]);
    expect(images).toHaveLength(1);
  });

  it('asks each provider in the shape it wants', () => {
    const image = { mediaType: 'image/png', base64: 'AAAA' };
    expect(openAiImagePart(image)).toEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,AAAA` } });
    expect(anthropicImagePart(image)).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
    expect(geminiImagePart(image)).toEqual({ inline_data: { mime_type: 'image/png', data: 'AAAA' } });
  });

  it('puts them on the request being sent, not on a turn already written', () => {
    const messages = chatMessages(request({ contextChips: [imageChip()] }), 'context', [
      { role: 'user', text: 'an earlier question' },
      { role: 'assistant', text: 'an earlier answer' },
      { role: 'user', text: 'this one comes with a picture' },
    ]);
    const last = messages.at(-1)!;
    expect(Array.isArray(last.content)).toBe(true);
    expect(last.content).toEqual([
      { type: 'text', text: 'this one comes with a picture' },
      { type: 'image_url', image_url: { url: PNG } },
    ]);
    // The turns before it are untouched — text, as they were saved.
    expect(messages[1]!.content).toBe('an earlier question');
    expect(messages[2]!.content).toBe('an earlier answer');
  });

  it('says the same thing to the Anthropic-shaped endpoint', () => {
    const messages = anthropicMessages(request({ contextChips: [imageChip()] }));
    expect(messages.at(-1)!.content).toEqual([
      { type: 'text', text: 'What is wrong with this page?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' } },
    ]);
  });

  it('sends exactly the text it always did when nothing is attached', () => {
    expect(chatMessages(request(), 'context', undefined)).toEqual([
      { role: 'system', content: 'context' },
      { role: 'user', content: 'What is wrong with this page?' },
    ]);
  });
});

describe('a provider that will not take the image', () => {
  it('is recognised by what it said, not by the status alone', () => {
    expect(isImageRefusal(400, '{"error":{"message":"image_url is not supported by this model"}}')).toBe(true);
    expect(isImageRefusal(400, 'unsupported media type: image/png')).toBe(true);
    expect(isImageRefusal(422, 'this model does not accept multimodal input')).toBe(true);
    // A bad request that has nothing to do with an image must still fail as one.
    expect(isImageRefusal(400, 'invalid model: deepseek-nope')).toBe(false);
    expect(isImageRefusal(429, 'rate limit reached')).toBe(false);
    expect(isImageRefusal(500, 'internal error')).toBe(false);
  });

  it('drops the image and keeps the words, so the run carries on', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'What is wrong here?' }, openAiImagePart({ mediaType: 'image/png', base64: 'AAAA' })] },
      { role: 'assistant', content: 'looking' },
    ];
    const stripped = withoutImageParts(messages);
    expect(stripped[0]!.content).toEqual([{ type: 'text', text: 'What is wrong here?' }]);
    expect(stripped[1]).toEqual({ role: 'assistant', content: 'looking' });
    expect(hasImageParts(messages)).toBe(true);
    expect(hasImageParts(stripped)).toBe(false);
  });

  it('never leaves a message with nothing in it, which a provider rejects', () => {
    const stripped = withoutImageParts([{ role: 'user', content: [openAiImagePart({ mediaType: 'image/png', base64: 'AAAA' })] }]);
    expect(stripped[0]!.content).toEqual([{ type: 'text', text: '(the attached image could not be sent)' }]);
  });
});


describe('tool images reach providers as visual content', () => {
  const output = { text: 'Screenshot', content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }] };
  it('preserves MCP image bytes without embedding base64 in text', () => {
    const split = toolOutputImages(normalizeToolResult({ content: [{ type: 'text', text: 'Screenshot' }, ...output.content] }));
    expect(split.images).toEqual([{ mediaType: 'image/png', base64: 'AAAA' }]);
    expect(split.text).not.toContain('AAAA');
    expect(split.text).toContain('Screenshot');
    expect(anthropicToolOutput('a', output)).toMatchObject({ content: [expect.any(Object), { type: 'image', source: { data: 'AAAA' } }] });
    expect(chatToolOutput('a', output)).toMatchObject({ content: [expect.any(Object), { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] });
    expect(functionCallOutput('a', output)).toMatchObject({ output: [expect.any(Object), { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] });
  });
  it('preserves tool IDs when removing rejected nested images', () => {
    const messages = [{ content: [anthropicToolOutput('a', output)] }];
    expect(hasImageParts(messages)).toBe(true);
    const stripped = withoutImageParts(messages);
    expect(hasImageParts(stripped)).toBe(false);
    expect(stripped[0]!.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'a' });
  });
  it('reports unsupported image content without leaking its bytes into text', () => {
    const split = toolOutputImages({ content: [{ type: 'image', mimeType: 'image/svg+xml', data: 'AAAA' }] });
    expect(split.images).toEqual([]);
    expect(split.text).toContain('Image omitted');
    expect(split.text).not.toContain('AAAA');
  });
});
