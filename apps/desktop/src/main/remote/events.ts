import * as crypto from 'node:crypto';
import { REMOTE_PUSH_CHANNELS as REMOTE_PUSH_CHANNEL_LIST } from '@kai/contracts';
import type { WindowPush } from '../desktop-windows';

/** The same list the phone subscribes to, as a set so the hot path is a lookup rather than a scan. */
export const REMOTE_PUSH_CHANNELS: ReadonlySet<string> = new Set(REMOTE_PUSH_CHANNEL_LIST);

/** What the registry pushes. Named here for this side's use; the shape is the registry's. */
export type WindowEventLike = WindowPush;

export interface RemoteFrame {
  seq: number;
  channel: string;
  windowId: number | null;
  payload: unknown;
}

/**
 * The replay buffer behind the live stream. Every frame carries a sequence number so a phone that
 * loses its connection can say where it got to and be handed exactly what it missed — rather than
 * either replaying everything or silently skipping to the present.
 *
 * `epoch` exists because sequence numbers restart with the app: a client that reconnects after a
 * restart would otherwise ask to resume from a position that now means something else.
 */
export class RemoteEventStream {
  readonly epoch = crypto.randomUUID();
  private readonly frames: RemoteFrame[] = [];
  private readonly listeners = new Set<(frame: RemoteFrame) => void>();
  private seq = 0;

  constructor(private readonly limit = 500) {}

  get latestSeq(): number {
    return this.seq;
  }

  get clientCount(): number {
    return this.listeners.size;
  }

  /** Records one window event for replay, then hands it to every attached client. */
  record(event: WindowEventLike): void {
    if (!REMOTE_PUSH_CHANNELS.has(event.channel)) return;
    const frame: RemoteFrame = { seq: ++this.seq, channel: event.channel, windowId: event.windowId, payload: event.payload };
    this.frames.push(frame);
    if (this.frames.length > this.limit) this.frames.shift();
    for (const listener of [...this.listeners]) {
      try {
        listener(frame);
      } catch {
        // One client failing to accept a frame must not stop the others from getting it.
      }
    }
  }

  /** Frames newer than `lastSeq`, or null when that position is older than the buffer can replay. */
  since(lastSeq: number): RemoteFrame[] | null {
    const oldest = this.frames[0]?.seq ?? this.seq + 1;
    if (lastSeq < oldest - 1) return null;
    return this.frames.filter((frame) => frame.seq > lastSeq);
  }

  /** Subscribes to live frames. Returns the unsubscribe function. */
  attach(listener: (frame: RemoteFrame) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** A `text.delta` frame. It is a tail rather than a fact, so it is the one thing safe to drop. */
export function isDroppableFrame(frame: RemoteFrame): boolean {
  if (frame.channel !== 'agents:event') return false;
  const payload = frame.payload as { event?: { type?: string } } | null;
  return payload?.event?.type === 'text.delta';
}
