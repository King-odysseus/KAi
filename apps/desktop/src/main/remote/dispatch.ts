import type { IpcChannel } from '@kai/contracts';
import type { DesktopWindowRegistry, DesktopWindowSession } from '../desktop-windows';
import type { IpcRegistry, IpcRequestContext } from '../ipc';
import { remoteScopeFor } from './allowlist';

/** Thrown when the caller names no window, or names one that is no longer open. */
export class RemoteWindowUnavailable extends Error {}

/** Thrown when the channel is not on the allowlist, so the gateway has no handler to run for it. */
export class RemoteChannelDenied extends Error {}

/**
 * Runs a remote request through the same handler the desktop renderer would reach, with one difference:
 * the window a request acts as is chosen by the caller rather than by the sender. That is why
 * `IpcRequestContext` carries a pre-resolved `ownerWindowId` — a gateway has no `IpcMainInvokeEvent`,
 * but a window-scoped channel such as `agents:approval-response` still has to resolve to a real one.
 */
export class RemoteDispatcher {
  constructor(
    private readonly registry: IpcRegistry,
    private readonly windows: DesktopWindowRegistry,
  ) {}

  /** The window a request runs as: the one it names, or the focused window when it names none. */
  resolveWindow(windowId: number | null): DesktopWindowSession {
    const session = windowId === null ? this.windows.focused() : this.windows.get(windowId);
    if (!session || session.window.isDestroyed()) {
      throw new RemoteWindowUnavailable(
        windowId === null ? 'No KAI window is open to act on.' : `Window ${windowId} is not open.`,
      );
    }
    return session;
  }

  /** Checks the allowlist, resolves the target window, then runs the handler and returns its output. */
  async dispatch(channel: IpcChannel, input: unknown, windowId: number | null): Promise<unknown> {
    if (!remoteScopeFor(channel)) throw new RemoteChannelDenied(`${channel} is not available remotely.`);
    const session = this.resolveWindow(windowId);
    const request: IpcRequestContext = { session, ownerWindowId: session.id };
    return this.registry.dispatch(channel, input, request);
  }
}
