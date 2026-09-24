import { describe, expect, it } from 'vitest';
import { appSettingsV1Schema, createDefaultSettings, normalizeReleaseNotes, type UpdateState } from '../packages/contracts/src';
import { NO_UPDATE_FEED_MESSAGE, UpdateController, type UpdaterPort } from '../apps/desktop/src/main/updater';

class FakeUpdater implements UpdaterPort {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  calls: string[] = [];
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();
  failCheck: Error | null = null;
  on(event: string, listener: (...args: any[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  async checkForUpdates(): Promise<unknown> {
    this.calls.push('check');
    if (this.failCheck) throw this.failCheck;
    return null;
  }
  async downloadUpdate(): Promise<unknown> {
    this.calls.push('download');
    return null;
  }
  quitAndInstall(silent?: boolean, forceRunAfter?: boolean): void {
    this.calls.push(`install:${String(silent)}:${String(forceRunAfter)}`);
  }
}

function harness(overrides: { enabled?: boolean; backup?: (name: string) => Promise<string> } = {}) {
  const port = new FakeUpdater();
  const states: UpdateState[] = [];
  const backups: string[] = [];
  const controller = new UpdateController(port, {
    currentVersion: '0.1.0',
    enabled: overrides.enabled ?? true,
    backup: overrides.backup ?? (async (name) => { backups.push(name); return name; }),
    onChange: (state) => states.push(state),
    now: () => new Date('2026-09-24T12:00:00.000Z'),
  });
  return { port, controller, states, backups };
}

describe('update controller', () => {
  it('turns off automatic downloading and installing, so the user decides each step', () => {
    const { port } = harness();
    expect(port.autoDownload).toBe(false);
    expect(port.autoInstallOnAppQuit).toBe(false);
  });

  it('does nothing in a development build', async () => {
    const { port, controller } = harness({ enabled: false });
    expect(controller.getState()).toMatchObject({ status: 'disabled', message: expect.stringContaining('installed builds') });
    await controller.check();
    await controller.download();
    await controller.installAndRestart();
    expect(port.calls).toEqual([]);
  });

  it('walks check, download and install, and shows release notes without markup', async () => {
    const { port, controller, backups } = harness();
    const check = controller.check();
    port.emit('update-available', { version: '0.2.0', releaseNotes: '<h2>New</h2><ul><li>Git page</li><li>Themes &amp; more</li></ul>' });
    await check;
    expect(controller.getState()).toMatchObject({ status: 'available', version: '0.2.0', currentVersion: '0.1.0', checkedAt: '2026-09-24T12:00:00.000Z' });
    expect(controller.getState().notes).toBe('New\n- Git page\n- Themes & more');

    await controller.download();
    port.emit('download-progress', { percent: 42.4 });
    expect(controller.getState()).toMatchObject({ status: 'downloading', percent: 42 });
    port.emit('update-downloaded', {});
    expect(controller.getState()).toMatchObject({ status: 'ready', percent: 100 });

    await controller.installAndRestart();
    expect(backups).toEqual(['Before update to 0.2.0']);
    expect(controller.getState().backupName).toBe('Before update to 0.2.0');
    expect(port.calls).toEqual(['check', 'download', 'install:false:true']);
  });

  it('refuses to download or install out of order', async () => {
    const { port, controller } = harness();
    await controller.download();
    await controller.installAndRestart();
    expect(port.calls).toEqual([]);
    port.emit('update-available', { version: '0.2.0' });
    await controller.installAndRestart();
    expect(port.calls).toEqual([]);
  });

  it('does not install when the configuration backup fails', async () => {
    const { port, controller } = harness({ backup: async () => { throw new Error('disk full'); } });
    port.emit('update-available', { version: '0.2.0' });
    await controller.download();
    port.emit('update-downloaded', {});
    await controller.installAndRestart();
    expect(port.calls).not.toContain('install:false:true');
    expect(controller.getState()).toMatchObject({ status: 'error', message: expect.stringContaining('disk full') });
  });

  it('reports network errors without leaking secrets, and lets the user try again', async () => {
    const { port, controller } = harness();
    port.failCheck = new Error('GET https://api.github.com failed with Authorization: Bearer ghp_abcdefghijklmnop');
    await controller.check();
    const state = controller.getState();
    expect(state.status).toBe('error');
    expect(state.message).not.toContain('ghp_abcdefghijklmnop');
    port.failCheck = null;
    await controller.check();
    expect(port.calls.filter((call) => call === 'check')).toHaveLength(2);
  });

  it('reports a private or unpublished release feed as no update, not an authentication failure', async () => {
    const { port, controller } = harness();
    port.failCheck = new Error('404 "method: GET url: https://github.com/King-odysseus/KAi/releases.atom\n\nPlease double check that your authentication token is correct."');

    await controller.check();

    expect(controller.getState()).toMatchObject({
      status: 'none',
      message: NO_UPDATE_FEED_MESSAGE,
      checkedAt: '2026-09-24T12:00:00.000Z',
    });
  });

  it('keeps a downloaded update when checked again, and reports being up to date', async () => {
    const { port, controller } = harness();
    port.emit('update-available', { version: '0.2.0' });
    await controller.download();
    port.emit('update-downloaded', {});
    await controller.check();
    expect(controller.getState().status).toBe('ready');
    expect(port.calls).toEqual(['download']);

    const fresh = harness();
    const check = fresh.controller.check();
    fresh.port.emit('update-not-available', {});
    await check;
    expect(fresh.controller.getState()).toMatchObject({ status: 'none', message: 'You are on the latest version.' });
  });
});

describe('release notes and settings', () => {
  it('reads notes given as a per-version list, and drops empty ones', () => {
    expect(normalizeReleaseNotes([{ version: '0.2.0', note: 'Faster startup' }, { version: '0.1.5', note: null }])).toBe('0.2.0\nFaster startup\n\n0.1.5');
    expect(normalizeReleaseNotes(null)).toBeNull();
    expect(normalizeReleaseNotes('   ')).toBeNull();
  });

  it('checks automatically by default, and settings saved before this existed still load', () => {
    const defaults = createDefaultSettings();
    expect(defaults.updates).toEqual({ autoCheck: true });
    const { updates: _omitted, ...legacy } = defaults;
    expect(appSettingsV1Schema.parse(legacy).updates.autoCheck).toBe(true);
  });
});
