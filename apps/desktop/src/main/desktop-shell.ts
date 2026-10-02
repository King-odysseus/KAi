import { BrowserWindow, Menu, Notification, Tray, app, nativeImage } from 'electron';
import type { NotificationSettings } from '@kai/contracts';
import type { DesktopNotification, NotificationCenter } from './notification-rules';

const ICON_SIZE = 32;

/** A small mint disc drawn in memory, so the tray needs no image asset. */
function trayIcon(): Electron.NativeImage {
  const buffer = Buffer.alloc(ICON_SIZE * ICON_SIZE * 4);
  const centre = (ICON_SIZE - 1) / 2;
  const radius = ICON_SIZE / 2 - 2;
  for (let y = 0; y < ICON_SIZE; y += 1) {
    for (let x = 0; x < ICON_SIZE; x += 1) {
      const offset = (y * ICON_SIZE + x) * 4;
      if (Math.hypot(x - centre, y - centre) > radius) continue;
      // BGRA order, as createFromBitmap expects.
      buffer[offset] = 0xa1;
      buffer[offset + 1] = 0xe3;
      buffer[offset + 2] = 0x66;
      buffer[offset + 3] = 0xff;
    }
  }
  return nativeImage.createFromBitmap(buffer, { width: ICON_SIZE, height: ICON_SIZE });
}

export interface DesktopShellDeps {
  center: NotificationCenter;
  getWindow: () => BrowserWindow | null;
  stopRun: (conversationId: string) => void;
  /** Whether the process may end now: nothing else is in flight that quitting would cut short. */
  canExit: () => boolean;
  /** Whether any window is on screen at all. A window that is not is one nobody can reach. */
  hasVisibleWindow: () => boolean;
  /** Records why KAI ended itself, so a window that went missing says so rather than leaving a mystery. */
  log: (message: string) => void;
}

/** Owns the system tray, close-to-tray behaviour and native notifications. */
export class DesktopShell {
  private tray: Tray | null = null;
  private trayEnabled = false;
  private quitting = false;
  /** Set when a window went away to keep a run alive, so the process can end once that run does. */
  private residentForWork = false;
  private readonly notificationsOff = process.env.KAI_DESKTOP_NOTIFICATIONS === 'off';

  constructor(private readonly deps: DesktopShellDeps) {
    deps.center.onRunsChanged(() => {
      this.refreshMenu();
      this.endResidencyIfWorkFinished();
    });
    app.on('before-quit', () => {
      this.quitting = true;
    });
  }

  /**
   * Whether closing the window should hide it instead, because a run would be abandoned by closing.
   *
   * Yes only while there is work to protect, and it remembers that it said yes: the app is resident for a reason
   * that can expire, and this is what tells it so.
   */
  hideForActiveWork(): boolean {
    if (!this.trayEnabled || this.quitting || this.deps.center.activeRunIds().length === 0) return false;
    this.residentForWork = true;
    return true;
  }

  /**
   * Ends KAI when nothing of it is left on screen and there is no tray to bring it back.
   *
   * A window that is not on screen is not reachable. With the tray off there is no way back to it at all, so the
   * process runs on with nothing anyone can see or click — which is what closing KAI kept leaving behind, and why
   * every install ended with Task Manager. Whatever leaves a window out of sight, this catches it: hidden, moved to
   * a display that is no longer attached, or a renderer that died and left its window standing.
   *
   * A window hidden on purpose is the one case where staying up is the whole point, and hiding the window by hand
   * is only possible with the tray on, so the tray being enabled is what this leaves alone.
   */
  windowVisibilityChanged(): void {
    if (this.quitting || this.trayEnabled) return;
    if (this.deps.hasVisibleWindow()) {
      this.residentForWork = false;
      return;
    }
    if (!this.deps.canExit()) return;
    this.deps.log('No KAI window is on screen and the tray is off; ending KAI rather than leaving it unreachable.');
    app.quit();
  }

  /**
   * Ends the process once the work it stayed up for has finished.
   *
   * A window hidden to protect a run is not a window anyone asked to keep running. When the last run ends there is
   * nothing left to protect and nothing that will bring the window back, so KAI was left resident with no window —
   * invisible, and with notifications off not even a tray icon to reach it by, which is a process the person
   * believed they had closed. Hiding the window on purpose is untouched: that never sets the flag this reads.
   */
  private endResidencyIfWorkFinished(): void {
    if (!this.residentForWork || this.quitting) return;
    if (this.deps.center.activeRunIds().length > 0) return;
    const window = this.deps.getWindow();
    if (window?.isVisible()) {
      // The window came back, so closing it again is a fresh decision to act on.
      this.residentForWork = false;
      return;
    }
    if (this.deps.canExit()) app.quit();
  }

  apply(settings: NotificationSettings): void {
    this.trayEnabled = settings.trayEnabled;
    if (this.trayEnabled && !this.tray && !this.notificationsOff) {
      this.tray = new Tray(trayIcon());
      this.tray.setToolTip('KAI');
      this.tray.on('click', () => this.toggleWindow());
      this.deps.getWindow()?.on('show', () => this.refreshMenu());
      this.deps.getWindow()?.on('hide', () => this.refreshMenu());
    } else if (!this.trayEnabled && this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
    this.refreshMenu();
  }

  show(notification: DesktopNotification): void {
    if (this.notificationsOff || !Notification.isSupported()) return;
    const toast = new Notification({ title: notification.title, body: notification.body });
    toast.on('click', () => {
      this.showWindow();
      const window = this.deps.getWindow();
      if (window && notification.conversationId) {
        window.webContents.send('app:open-conversation', { conversationId: notification.conversationId });
      }
    });
    toast.show();
  }

  dispose(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  private showWindow(): void {
    const window = this.deps.getWindow();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  private toggleWindow(): void {
    const window = this.deps.getWindow();
    if (window?.isVisible()) window.hide();
    else this.showWindow();
  }

  private refreshMenu(): void {
    if (!this.tray) return;
    const active = this.deps.center.activeRunIds();
    const visible = this.deps.getWindow()?.isVisible() ?? false;
    this.tray.setToolTip(active.length ? `KAI — ${active.length} run${active.length === 1 ? '' : 's'} active` : 'KAI');
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: visible ? 'Hide KAI' : 'Show KAI', click: () => this.toggleWindow() },
      { type: 'separator' },
      { label: active.length ? `${active.length} run${active.length === 1 ? '' : 's'} active` : 'No active runs', enabled: false },
      {
        label: 'Stop active runs',
        enabled: active.length > 0,
        click: () => {
          for (const id of this.deps.center.activeRunIds()) this.deps.stopRun(id);
        },
      },
      { type: 'separator' },
      { label: 'Quit KAI', click: () => app.quit() },
    ]));
  }
}
