/**
 * A run re-sends every tool result on every round, so a long run that reads many files pays for each of them again
 * and again. Once the results add up to more than TRIM_TRIGGER_CHARS, the oldest ones are replaced by a one-line note
 * until what is left is under TRIM_TARGET_CHARS. The newest results always stay whole, and trimming happens in batches
 * so a provider's prompt cache is not broken on every round.
 */
export const TRIM_TRIGGER_CHARS = 100_000;
export const TRIM_TARGET_CHARS = 50_000;
export const KEEP_RECENT_RESULTS = 8;
const MIN_TRIMMABLE_CHARS = 600;
const PREVIEW_CHARS = 140;

/** One tool result inside a provider's message list, with a way to read its size and replace its text. */
interface ResultSlot {
  length: number;
  preview: string;
  replace: (note: string) => void;
}

export function trimNote(length: number, preview: string): string {
  return `[Earlier tool result trimmed to save context (${length} characters). It began: ${preview} ... Call the tool again if you need it.]`;
}

function previewOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS);
}

/** Trims the oldest results among `slots` (in order) and returns how many were replaced. */
function trimSlots(slots: readonly ResultSlot[]): number {
  let total = slots.reduce((sum, slot) => sum + slot.length, 0);
  if (total <= TRIM_TRIGGER_CHARS) return 0;
  let trimmed = 0;
  const candidates = slots.slice(0, Math.max(0, slots.length - KEEP_RECENT_RESULTS));
  for (const slot of candidates) {
    if (total <= TRIM_TARGET_CHARS) break;
    if (slot.length < MIN_TRIMMABLE_CHARS) continue;
    const note = trimNote(slot.length, slot.preview);
    total -= slot.length - note.length;
    slot.replace(note);
    trimmed += 1;
  }
  return trimmed;
}

interface ChatLike {
  role: string;
  /** Text, or the parts a message with an image is made of — a tool result is always the former. */
  content?: string | Array<Record<string, unknown>> | null;
}

/** Chat Completions: tool results are messages with role "tool". */
export function trimChatToolResults(messages: ChatLike[]): number {
  const slots: ResultSlot[] = [];
  for (const message of messages) {
    if (message.role !== 'tool' || typeof message.content !== 'string') continue;
    const text = message.content;
    slots.push({ length: text.length, preview: previewOf(text), replace: (note) => { message.content = note; } });
  }
  return trimSlots(slots);
}

interface AnthropicLike {
  role: string;
  content: string | Array<Record<string, unknown>>;
}

/** Anthropic Messages: tool results are tool_result blocks inside user messages. */
export function trimAnthropicToolResults(messages: AnthropicLike[]): number {
  const slots: ResultSlot[] = [];
  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== 'tool_result' || typeof block.content !== 'string') continue;
      const text = block.content;
      slots.push({ length: text.length, preview: previewOf(text), replace: (note) => { block.content = note; } });
    }
  }
  return trimSlots(slots);
}

interface GeminiLike {
  role: string;
  parts: Array<Record<string, unknown>>;
}

/** Gemini: tool results are functionResponse parts inside user contents. */
export function trimGeminiToolResults(contents: GeminiLike[]): number {
  const slots: ResultSlot[] = [];
  for (const content of contents) {
    if (content.role !== 'user') continue;
    for (const part of content.parts) {
      const response = part.functionResponse as { name?: string; response?: unknown } | undefined;
      if (!response || response.response === undefined) continue;
      const text = JSON.stringify(response.response);
      slots.push({ length: text.length, preview: previewOf(text), replace: (note) => { response.response = { output: note }; } });
    }
  }
  return trimSlots(slots);
}
