import type { ContextChip } from '@kai/contracts';

/**
 * The images a person attached to a run, in the shape each provider asks for.
 *
 * Until now the Direct API path had no image channel at all: the composer described the attachment in the prompt
 * ("an image named X at path Y"), the model asked to read that path, `read_file` refused it as binary — a PNG is not
 * UTF-8 — and the run improvised. The model can see; KAI was not sending anything to see.
 *
 * The composer has carried the bytes all along: an image chip holds the data URL it was attached as.
 */

export interface AttachedImage {
  mediaType: string;
  base64: string;
}

/** What the providers accept, and nothing else — an unlisted type is one no vision model will take. */
const IMAGE_MEDIA_TYPE = /^image\/(?:png|jpe?g|gif|webp)$/i;
/** Enough for a screen or a photograph at a time; the composer converts and sends what was attached, so this is a wall. */
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** The images among a run's context chips, or an empty list when there are none to send. */
export function attachedImages(chips: readonly ContextChip[] | undefined): AttachedImage[] {
  const images: AttachedImage[] = [];
  for (const chip of chips ?? []) {
    if (chip.type !== 'image') continue;
    const image = parseImageDataUrl(chip.dataUrl);
    if (image) images.push(image);
    if (images.length >= MAX_IMAGES) break;
  }
  return images;
}

/** A data URL as an image the providers take, or null when it is not one, or is too large to send. */
export function parseImageDataUrl(dataUrl: string | undefined): AttachedImage | null {
  if (!dataUrl) return null;
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl.trim());
  if (!match) return null;
  const mediaType = match[1]!.toLowerCase();
  const base64 = match[2]!.replace(/\s+/g, '');
  if (!IMAGE_MEDIA_TYPE.test(mediaType) || base64.length === 0) return null;
  // Base64 carries three bytes for every four characters.
  if (base64.length * 0.75 > MAX_IMAGE_BYTES) return null;
  return { mediaType, base64 };
}

/** The OpenAI shape — a data URL under `image_url`, which is what DeepSeek's endpoint and the chat API take. */
export function openAiImagePart(image: AttachedImage): Record<string, unknown> {
  return { type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.base64}` } };
}

/** The Anthropic shape: base64 with its media type beside it. */
export function anthropicImagePart(image: AttachedImage): Record<string, unknown> {
  return { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } };
}

/** The Gemini shape. */
export function geminiImagePart(image: AttachedImage): Record<string, unknown> {
  return { inline_data: { mime_type: image.mediaType, data: image.base64 } };
}

/** True when this content part is an image in any of the shapes above. */
export function isImagePart(part: Record<string, unknown>): boolean {
  return part.type === 'image' || part.type === 'image_url' || part.type === 'input_image' || part.inline_data !== undefined;
}

/** Whether any of these messages carries an image, which is what makes a refusal worth retrying without them. */
export function hasImageParts(messages: readonly { content?: unknown }[]): boolean {
  return messages.some((message) => Array.isArray(message.content) && message.content.some((part) => isImagePart(part as Record<string, unknown>)));
}

/**
 * Whether a provider refused this request because of the image in it.
 *
 * The wording differs by provider — "invalid content type", "image_url is not supported by this model", "media type
 * not supported" — and the statuses are the ones a rejection of the payload uses. Kept narrow on purpose: dropping
 * an image is only ever right when the image is what was wrong.
 */
export function isImageRefusal(status: number, detail: string): boolean {
  if (status !== 400 && status !== 415 && status !== 422) return false;
  return /image|vision|media[_ ]?type|multimodal/i.test(detail);
}

/**
 * The same messages with every image part taken out, keeping the text.
 *
 * Used when a provider refuses a request because of the image: a model without vision rejects the whole thing, and
 * losing a run to an attachment the person did not have to think about would be worse than losing the attachment.
 * A content list that would be left empty keeps a text part, because a provider rejects an empty one.
 */
export function withoutImageParts<T extends { content?: string | Array<Record<string, unknown>> | null }>(messages: readonly T[]): T[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    const kept = message.content.filter((part) => !isImagePart(part));
    const content = kept.length > 0 ? kept : [{ type: 'text', text: '(the attached image could not be sent)' }];
    return { ...message, content };
  });
}
