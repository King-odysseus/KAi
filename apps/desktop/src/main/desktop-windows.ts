import type { BrowserWindow } from 'electron';

export interface DesktopWindowSession {
  id: number;
  window: BrowserWindow;
  projectId: string | null;
  conversationId: string | null;
  view: string;
}

/** One push, as a non-window consumer sees it. `windowId` null means it was addressed to every window. */
export interface WindowPush {
  windowId: number | null;
  channel: string;
  payload: unknown;
}

export type WindowPushSubscriber = (push: WindowPush) => void;

/** Explicit null means a new independent window; only a missing session inherits the global project. */
export function projectSelectionForWindow(
  session: Pick<DesktopWindowSession, 'projectId'> | null | undefined,
  globalProjectId: string | null,
): string | null {
  return session ? session.projectId : globalProjectId;
}

/** Tracks renderer-local state while BrowserWindows share settings, credentials and managed services. */
export class DesktopWindowRegistry {
  private readonly sessions = new Map<number, DesktopWindowSession>();
  private readonly subscribers = new Set<WindowPushSubscriber>();

  register(window: BrowserWindow, projectId: string | null): DesktopWindowSession {
    const session: DesktopWindowSession = {
      id: window.webContents.id,
      window,
      projectId,
      conversationId: null,
      view: 'workspace',
    };
    this.sessions.set(session.id, session);
    return session;
  }

  remove(windowId: number): void {
    this.sessions.delete(windowId);
  }

  get(windowId: number): DesktopWindowSession | null {
    return this.sessions.get(windowId) ?? null;
  }

  fromWindow(window: BrowserWindow): DesktopWindowSession | null {
    return this.get(window.webContents.id);
  }

  fromWebContentsId(webContentsId: number): DesktopWindowSession | null {
    return this.get(webContentsId);
  }

  all(): DesktopWindowSession[] {
    return [...this.sessions.values()];
  }

  focused(): DesktopWindowSession | null {
    return this.all().find((session) => !session.window.isDestroyed() && session.window.isFocused())
      ?? this.all().find((session) => !session.window.isDestroyed())
      ?? null;
  }

  live(): DesktopWindowSession[] {
    return this.all().filter((session) => !session.window.isDestroyed());
  }

  send(windowId: number, channel: string, payload: unknown): boolean {
    const session = this.get(windowId);
    if (!session || session.window.isDestroyed()) return false;
    session.window.webContents.send(channel, payload);
    this.emit({ windowId, channel, payload });
    return true;
  }

  broadcast(channel: string, payload: unknown): void {
    for (const session of this.live()) session.window.webContents.send(channel, payload);
    this.emit({ windowId: null, channel, payload });
  }

  /**
   * Follows every push this registry makes, for consumers that are not a BrowserWindow. The remote
   * gateway uses it so the phone sees the same tail the desktop does, without the nine emit sites
   * having to know the phone exists.
   */
  subscribe(subscriber: WindowPushSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  private emit(push: WindowPush): void {
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(push);
      } catch {
        // A subscriber that throws must not break the window push that has already happened.
      }
    }
  }
}
