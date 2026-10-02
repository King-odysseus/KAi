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
  const shell = new DesktopShell({
    center,
    getWindow: () => window as never,
    stopRun: vi.fn(),
    canExit: () => options.canExit ?? true,
  });
  shell.apply(settings);
  return { shell, center, window };
}

describe('desktop shell residency', () => {
  beforeEach(() => {
    electron.quit.mockClear();
  });

  it('closes the window normally when no run would be abandoned', () => {
    const { shell } = harness();
    expect(shell.hideForActiveWork()).toBe(false);
  });

  it('hides the window while a run is active, then ends the app once that run finishes', () => {
    const { shell, center } = harness({ visible: false });
    center.runStarted('run-1');

    expect(shell.hideForActiveWork()).toBe(true);
    // The window is hidden and the run is what is keeping the process up, so finishing it ends KAI rather than
    // leaving a window nobody can see and no tray icon to reach it by when notifications are off.
    expect(electron.quit).not.toHaveBeenCalled();

    center.runEnded('run-1');
    expect(electron.quit).toHaveBeenCalledTimes(1);
  });

  it('waits while another run is still going', () => {
    const { shell, center } = harness();
    center.runStarted('run-1');
    center.runStarted('run-2');
    shell.hideForActiveWork();

    center.runEnded('run-1');
    expect(electron.quit).not.toHaveBeenCalled();

    center.runEnded('run-2');
    expect(electron.quit).toHaveBeenCalledTimes(1);
  });

  it('keeps running when the window came back into view', () => {
    const { shell, center, window } = harness({ visible: false });
    center.runStarted('run-1');
    shell.hideForActiveWork();

    // The person reached the window again, so closing it from here is a fresh decision rather than the one that
    // was suspended, and finishing the run must not discard it.
    window.isVisible.mockReturnValue(true);
    center.runEnded('run-1');
    expect(electron.quit).not.toHaveBeenCalled();
  });

  it('leaves a window hidden on purpose alone', () => {
    const { center } = harness({ visible: false });
    // Hiding from the tray never asks the shell, so no residency was taken on this run's behalf.
    center.runStarted('run-1');
    center.runEnded('run-1');
    expect(electron.quit).not.toHaveBeenCalled();
  });

  it('waits for a headless job that has no window of its own', () => {
    const { shell, center } = harness({ canExit: false });
    center.runStarted('run-1');
    shell.hideForActiveWork();
    center.runEnded('run-1');
    expect(electron.quit).not.toHaveBeenCalled();
  });

  it('does not hide on close when the tray is off', () => {
    const { shell, center } = harness({ settings: { ...TRAY_ON, trayEnabled: false } });
    center.runStarted('run-1');
    expect(shell.hideForActiveWork()).toBe(false);
  });
});
