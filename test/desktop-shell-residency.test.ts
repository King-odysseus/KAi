import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationSettings } from '../packages/contracts/src';
import { DesktopShell } from '../apps/desktop/src/main/desktop-shell';
import { NotificationCenter } from '../apps/desktop/src/main/notification-rules';

const electron = vi.hoisted(() => ({ quit: vi.fn(), on: vi.fn() }));

vi.mock('electron', () => ({
  app: { on: electron.on, quit: electron.quit },
  BrowserWindow: class {},
  Menu: { buildFromTemplate: vi.fn(() => ({})) },
  Notification: { isSupported: () => false },
  Tray: class {
    setToolTip(): void {}
    setContextMenu(): void {}
    on(): void {}
    destroy(): void {}
  },
  nativeImage: { createFromBitmap: (): object => ({}) },
}));

const TRAY_ON: NotificationSettings = {
  trayEnabled: true,
  launchAtLogin: false,
  onComplete: true,
  onFailure: true,
  onApproval: true,
  onBudget: true,
};

function harness(options: { visible?: boolean; canExit?: boolean; settings?: NotificationSettings } = {}) {
  const settings = options.settings ?? TRAY_ON;
  const window = {
    isVisible: vi.fn(() => options.visible ?? false),
    isMinimized: vi.fn(() => false),
    on: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    focus: vi.fn(),
  };
  const center = new NotificationCenter({
    getSettings: () => Promise.resolve(settings),
    isWindowFocused: () => false,
    show: () => undefined,
  });
  const log = vi.fn();
  const shell = new DesktopShell({
    center,
    getWindow: () => window as never,
    stopRun: vi.fn(),
    canExit: () => options.canExit ?? true,
    hasVisibleWindow: () => options.visible ?? false,
    log,
  });
  shell.apply(settings);
  return { shell, center, window, log };
}

describe('desktop shell residency', () => {
  beforeEach(() => {
    electron.quit.mockClear();
  });

  it('keeps KAI running in the background when the tray is on, even with no run active', () => {
    const { shell, center } = harness({ visible: false });
    // A schedule can come due after the window closes, so background mode cannot depend on an active run.
    expect(shell.hideOnClose()).toBe(true);

    center.runStarted('run-1');
    center.runEnded('run-1');
    expect(electron.quit).not.toHaveBeenCalled();
  });

  it('keeps running after a run finishes while hidden', () => {
    const { shell, center } = harness({ visible: false });
    center.runStarted('run-1');
    expect(shell.hideOnClose()).toBe(true);
    center.runEnded('run-1');
    expect(electron.quit).not.toHaveBeenCalled();
  });

  it('does not hide on close when the tray is off', () => {
    const { shell, center } = harness({ settings: { ...TRAY_ON, trayEnabled: false } });
    center.runStarted('run-1');
    expect(shell.hideOnClose()).toBe(false);
  });

  it('leaves a window hidden on purpose alone', () => {
    const { center } = harness({ visible: false });
    // Hiding from the tray never asks the shell; nothing should end KAI when the run finishes either.
    center.runStarted('run-1');
    center.runEnded('run-1');
    expect(electron.quit).not.toHaveBeenCalled();
  });

  it('does not end the process when a headless job finishes while resident', () => {
    const { shell, center } = harness({ canExit: false });
    center.runStarted('run-1');
    shell.hideOnClose();
    center.runEnded('run-1');
    expect(electron.quit).not.toHaveBeenCalled();
  });

  it('ends KAI when no window is on screen and there is no tray to bring one back', () => {
    // The state that kept needing Task Manager: nothing on screen, nothing to click, the process still there.
    const { shell, log } = harness({ visible: false, settings: { ...TRAY_ON, trayEnabled: false } });

    shell.windowVisibilityChanged();

    expect(electron.quit).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('No KAI window is on screen'));
  });

  it('leaves KAI alone while a window is on screen', () => {
    const { shell } = harness({ visible: true, settings: { ...TRAY_ON, trayEnabled: false } });
    shell.windowVisibilityChanged();
    expect(electron.quit).not.toHaveBeenCalled();
  });

  it('leaves a hidden window alone when the tray is on, because that is how it comes back', () => {
    const { shell } = harness({ visible: false });
    shell.windowVisibilityChanged();
    expect(electron.quit).not.toHaveBeenCalled();
  });

  it('waits for a headless job before ending an unreachable KAI', () => {
    const { shell } = harness({ visible: false, canExit: false, settings: { ...TRAY_ON, trayEnabled: false } });
    shell.windowVisibilityChanged();
    expect(electron.quit).not.toHaveBeenCalled();
  });
});
