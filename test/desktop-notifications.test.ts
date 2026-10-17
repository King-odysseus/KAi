import { describe, expect, it } from 'vitest';
import {
  appSettingsV1Schema,
  createDefaultSettings,
  defaultNotificationSettings,
  type NotificationSettings,
  type UsageLimitStatus,
} from '../packages/contracts/src';
import { NotificationCenter, type DesktopNotification } from '../apps/desktop/src/main/notification-rules';

function harness(overrides: Partial<NotificationSettings> = {}, focused = false) {
  const shown: DesktopNotification[] = [];
  const state = { focused, settings: { ...defaultNotificationSettings, ...overrides } };
  const center = new NotificationCenter({
    getSettings: async () => state.settings,
    isWindowFocused: () => state.focused,
    show: (notification) => shown.push(notification),
  });
  return { center, shown, state };
}

const limit = (level: UsageLimitStatus['level'], scope: UsageLimitStatus['scope'] = 'daily'): UsageLimitStatus => ({
  scope,
  limitUsd: 10,
  spentUsd: level === 'ok' ? 1 : level === 'warning' ? 8.5 : 10,
  ratio: level === 'ok' ? 0.1 : level === 'warning' ? 0.85 : 1,
  level,
});

describe('notification rules', () => {
  it('notifies on completion and failure but never on a cancelled run', async () => {
    const { center, shown } = harness();
    expect(await center.notifyRunFinished('c1', 'Fix bug', 'completed')).toBe(true);
    expect(await center.notifyRunFinished('c1', 'Fix bug', 'failed', 'boom')).toBe(true);
    expect(await center.notifyRunFinished('c1', 'Fix bug', 'cancelled')).toBe(false);
    expect(shown.map((item) => item.kind)).toEqual(['complete', 'failure']);
    expect(shown[1]?.body).toContain('boom');
  });

  it('respects each per-type setting', async () => {
    const { center, shown } = harness({ onComplete: false, onFailure: false, onApproval: false, onBudget: false });
    await center.notifyRunFinished('c1', 't', 'completed');
    await center.notifyRunFinished('c1', 't', 'failed', 'x');
    await center.notifyApproval('c1', 't', 'Run npm test');
    await center.notifyBudget('c1', [limit('exceeded')]);
    expect(shown).toEqual([]);
  });

  it('stays quiet only when the window is focused on that exact conversation', async () => {
    const { center, shown, state } = harness({}, true);
    center.setViewing('workspace', 'c1');
    expect(await center.notifyRunFinished('c1', 't', 'completed')).toBe(false);
    expect(await center.notifyRunFinished('c2', 't', 'completed')).toBe(true);
    center.setViewing('settings', 'c1');
    expect(await center.notifyRunFinished('c1', 't', 'completed')).toBe(true);
    center.setViewing('workspace', 'c1');
    state.focused = false;
    expect(await center.notifyRunFinished('c1', 't', 'completed')).toBe(true);
    expect(shown).toHaveLength(3);
  });

  it('carries the approval title and asks the user to act', async () => {
    const { center, shown } = harness();
    await center.notifyApproval('c1', 'Refactor', 'Run npm install');
    expect(shown[0]).toMatchObject({ kind: 'approval', conversationId: 'c1', title: 'Approval needed' });
    expect(shown[0]?.body).toContain('Run npm install');
  });

  it('raises a budget notification only when a level newly worsens', async () => {
    const { center, shown } = harness();
    expect(await center.notifyBudget('c1', [limit('ok')])).toBe(false);
    expect(await center.notifyBudget('c1', [limit('warning')])).toBe(true);
    expect(await center.notifyBudget('c1', [limit('warning')])).toBe(false);
    expect(await center.notifyBudget('c1', [limit('exceeded')])).toBe(true);
    expect(await center.notifyBudget('c1', [limit('exceeded')])).toBe(false);
    expect(await center.notifyBudget('c1', [limit('ok')])).toBe(false);
    expect(await center.notifyBudget('c1', [limit('warning')])).toBe(true);
    expect(shown.map((item) => item.title)).toEqual(['Budget warning', 'Budget limit reached', 'Budget warning']);
  });

  it('tracks active runs and tells listeners when they change', () => {
    const { center } = harness();
    let changes = 0;
    const off = center.onRunsChanged(() => { changes += 1; });
    center.runStarted('a');
    center.runStarted('b');
    center.runEnded('a');
    center.runEnded('a');
    expect(center.activeRunIds()).toEqual(['b']);
    expect(changes).toBe(3);
    off();
    center.runEnded('b');
    expect(changes).toBe(3);
  });

  it('truncates long bodies for the native toast', async () => {
    const { center, shown } = harness();
    await center.notifyRunFinished('c1', 'x'.repeat(500), 'completed');
    expect(shown[0]?.body.length).toBeLessThanOrEqual(200);
  });
});

describe('notification settings contract', () => {
  it('defaults the tray off and every notification on, and loads settings saved before it existed', () => {
    const defaults = createDefaultSettings();
    expect(defaults.notifications).toEqual({ trayEnabled: false, launchAtLogin: false, onComplete: true, onFailure: true, onApproval: true, onBudget: true });
    const { notifications: _omitted, ...legacy } = defaults;
    expect(appSettingsV1Schema.parse(legacy).notifications.trayEnabled).toBe(false);
  });

  it('rejects unknown notification keys', () => {
    const defaults = createDefaultSettings();
    expect(() => appSettingsV1Schema.parse({ ...defaults, notifications: { ...defaults.notifications, sound: true } })).toThrow();
  });
});
