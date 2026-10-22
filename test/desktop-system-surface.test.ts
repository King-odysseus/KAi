import { describe, expect, it } from 'vitest';
import { boardCardSchema, boardHousekeeping, isSystemSurface, lacksRoute, needsScreenCheck, type BoardCard } from '../packages/contracts/src';
import { SYSTEM_SURFACE_BRIEF, boardCardPrompt } from '../apps/desktop/src/main/board-brief';
import { unclosableUiCard } from '../apps/desktop/src/main/autopilot';
import { UI_BUILD_RULES } from '../apps/desktop/src/main/ui-rules';

const NOW = '2026-10-22T12:00:00.000Z';

function card(over: Partial<BoardCard> = {}): BoardCard {
  return boardCardSchema.parse({
    id: 'reminder-toast',
    title: 'Reminder notification (OS toasts)',
    kind: 'page',
    story: 'A person is reminded of a task that is due.',
    acceptance: ['A toast appears when a reminder is due.'],
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  });
}

describe('telling a surface Windows draws from a screen in the app', () => {
  it('knows toasts, the notification centre, the tray, the taskbar and native dialogs by their titles', () => {
    for (const title of [
      'Reminder notification (OS toasts)',
      'Windows notification for overdue tasks',
      'System tray menu',
      'Tray icon',
      'Notification Center entry',
      'Notification centre',
      'Taskbar badge',
      'Jump list',
      'Native file picker for attachments',
      'Native dialog: confirm quit',
    ]) expect(isSystemSurface({ title }), title).toBe(true);
  });

  it('leaves in-app screens alone, even ones about notifications', () => {
    for (const title of ['Tasks page', 'Notification settings', 'Notifications list', 'In-app banner', 'Settings menu', 'Toaster component']) {
      expect(isSystemSurface({ title }), title).toBe(false);
    }
  });
});

describe('a system surface on the board', () => {
  it('gets no screenshot check and is not held up for a missing route', () => {
    const toast = card();
    expect(needsScreenCheck(toast)).toBe(false);
    expect(lacksRoute(toast)).toBe(false);
    expect(unclosableUiCard(toast)).toBe(false);
    // An ordinary page with no route still is.
    const page = card({ id: 'tasks', title: 'Tasks page' });
    expect(needsScreenCheck(page)).toBe(true);
    expect(lacksRoute(page)).toBe(true);
    expect(unclosableUiCard(page)).toBe(true);
  });

  it('is not listed as a page with no route when tidying the board', () => {
    const findings = boardHousekeeping([card(), card({ id: 'tasks', title: 'Tasks page' })], '', null);
    const noRoute = findings.find((finding) => finding.code === 'no-route');
    expect(noRoute?.cards.map((item) => item.id)).toEqual(['tasks']);
  });

  it('tells the agent to use Electron\'s own API and never to fake the desktop, in place of the screen rules', () => {
    const prompt = boardCardPrompt(card(), {});
    expect(prompt).toContain(SYSTEM_SURFACE_BRIEF);
    expect(prompt).toContain('Notification');
    expect(prompt).toContain('no fake desktop, taskbar, notification centre');
    expect(prompt).not.toContain(UI_BUILD_RULES[0]);
    // An ordinary screen is not told this.
    expect(boardCardPrompt(card({ title: 'Tasks page' }), {})).not.toContain(SYSTEM_SURFACE_BRIEF);
  });
});
