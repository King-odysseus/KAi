import { parseImageDataUrl, type AttachedImage } from './image-attachments';

/**
 * Messages waiting to be handed to a run that is already going.
 *
 * Every other way of saying something during a run is a compromise. Queueing waits for the run to end, so a question
 * asked in the middle is answered at the end, by which time it may not matter. Steering cancels the run, which for an
 * agent in the middle of an edit throws away whatever it was doing.
 *
 * Interjecting is the third thing, and the one a person expects: the message is put to the agent at its next turn, so
 * it answers — or takes the correction — and carries on with what it was doing, plan intact.
 *
 * It only works for a run KAI is looping itself. A CLI run is one process invocation, and there is no moment between
 * turns to put anything to it; that case falls back to queueing, and the caller is told so rather than being promised
 * something that will not happen.
 */

/** An image the person attached, as the conversation records it. */
export interface InterjectionAttachment {
  name: string;
  dataUrl: string;
}

/**
 * What was said to a run in progress: the person's words, and whatever they attached beside them. A message that
 * carries only its words is a message that loses the image, the selection or the terminal output they meant to show.
 */
export interface Interjection {
  /** What the person typed. This is what the transcript records. */
  text: string;
  /** Attached context (a selection, terminal output, the files they pointed at) as text, for the model only. */
  context: string;
  /** Images the person attached. */
  attachments: InterjectionAttachment[];
}

export interface InterjectionExtras {
  context?: string;
  attachments?: readonly InterjectionAttachment[];
}

/** The words used when someone attaches an image and says nothing, so a message is never empty. */
export const IMAGE_ONLY_MESSAGE = 'Please look at the attached image.';

interface WaitingMessage extends Interjection { resolve: (delivered: boolean) => void }
const waiting = new Map<string, WaitingMessage[]>();
const active = new Set<string>();
const delivered = new Map<string, Interjection[]>();

export function setInterjectionActive(conversationId: string, enabled: boolean): void {
  if (enabled) active.add(conversationId);
  else active.delete(conversationId);
}

export function canInterject(conversationId: string): boolean {
  return active.has(conversationId);
}

/** Puts a message in line for the conversation's next turn. Resolves true once the run has actually taken it. */
export function interject(conversationId: string, text: string, extras: InterjectionExtras = {}): Promise<boolean> {
  const attachments = [...(extras.attachments ?? [])];
  const trimmed = text.trim() || (attachments.length > 0 ? IMAGE_ONLY_MESSAGE : '');
  if (!trimmed || !active.has(conversationId)) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const queue = waiting.get(conversationId);
    const item: WaitingMessage = { text: trimmed, context: extras.context?.trim() ?? '', attachments, resolve };
    if (queue) queue.push(item);
    else waiting.set(conversationId, [item]);
  });
}

/** Takes the oldest waiting message with everything attached to it, or null when there is none. */
export function takeInterjectionMessage(conversationId: string): Interjection | null {
  const queue = waiting.get(conversationId);
  if (!queue || queue.length === 0) return null;
  const next = queue.shift() ?? null;
  if (queue.length === 0) waiting.delete(conversationId);
  if (!next) return null;
  const message: Interjection = { text: next.text, context: next.context, attachments: next.attachments };
  delivered.set(conversationId, [...(delivered.get(conversationId) ?? []), message]);
  next.resolve(true);
  return message;
}

/** The words of the oldest waiting message, or null when there is none. */
export function takeInterjection(conversationId: string): string | null {
  return takeInterjectionMessage(conversationId)?.text ?? null;
}

export function takeDeliveredInterjections(conversationId: string): Interjection[] {
  const messages = delivered.get(conversationId) ?? [];
  delivered.delete(conversationId);
  return messages;
}

/** Drops anything still waiting, so a message for a finished run is never handed to the next one. */
export function clearInterjections(conversationId: string): void {
  for (const item of waiting.get(conversationId) ?? []) item.resolve(false);
  waiting.delete(conversationId);
  active.delete(conversationId);
}

export function hasInterjections(conversationId: string): boolean {
  return (waiting.get(conversationId)?.length ?? 0) > 0;
}

/** Keep the active task alive while handling a time-sensitive instruction at the next model step. */
export function steeringInstruction(text: string): string {
  return `The user has an immediate instruction for this active run. At the next safe boundary, handle it first: ${text}\n\nThen resume the original task from where you left off, preserving its plan, pending tool results, and unfinished work. Do not treat this interruption as a cancellation or final answer. Report completion only after both the immediate instruction and the original task are addressed.`;
}

/** The steering message for one interjection, with any attached context in front of the person's words. */
export function steeringInstructionFor(message: Interjection): string {
  return steeringInstruction(message.context ? `${message.context}\n\n${message.text}` : message.text);
}

/** The images in an interjection, in the form the providers take. Anything that is not a readable image is left out. */
export function interjectionImages(message: Interjection): AttachedImage[] {
  return message.attachments.flatMap((attachment) => {
    const image = parseImageDataUrl(attachment.dataUrl);
    return image ? [image] : [];
  });
}
