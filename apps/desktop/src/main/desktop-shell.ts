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
}

/** Owns the system tray, close-to-tray behaviour and native notifications. */
export class DesktopShell {
  private tray: Tray | null = null;
  private trayEnabled = false;
  private quitting = false;
  private readonly notificationsOff = process.env.KAI_DESKTOP_NOTIFICATIONS === 'off';

  constructor(private readonly deps: DesktopShellDeps) {
    deps.center.onRunsChanged(() => this.refreshMenu());
    app.on('before-quit', () => {
      this.quitting = true;
    });
  }

  /** Keep the app resident only when closing would otherwise abandon active work. */
  shouldHideOnClose(): boolean {
    return this.trayEnabled && !this.quitting && this.deps.center.activeRunIds().length > 0;
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
