import { describe, expect, it } from 'vitest';
import { WindowControl, windowBriefing, type ControlledWindow } from '../apps/desktop/src/main/window-control';

function fakeWindow(options: { approvalOpen?: boolean; center?: { x: number; y: number; insideApproval: boolean } | null } = {}): { window: ControlledWindow; events: Array<Record<string, unknown>>; typed: string[] } {
  const events: Array<Record<string, unknown>> = [];
  const typed: string[] = [];
  const window: ControlledWindow = {
    id: 7,
    title: 'Zuri - KAI',
    projectId: 'zuri',
    focused: true,
    webContents: {
      capturePage: async () => ({
        toPNG: () => Buffer.from('png'),
        getSize: () => ({ width: 2560, height: 1440 }),
        resize: () => ({ toPNG: () => Buffer.from('small') }),
      }),
      executeJavaScript: async (code: string) => {
        if (code.includes('.approval-dialog') && code.startsWith('Boolean')) return options.approvalOpen === true;
        if (code.includes('data-kai-ref="')) return options.center === undefined ? { x: 40, y: 20, insideApproval: false } : options.center;
        return { title: 'Zuri - KAI', view: 'Studio', width: 1200, height: 800, approvalOpen: false, elements: [{ ref: 'e1', role: 'button', name: 'Run', x: 1, y: 2, width: 3, height: 4 }] };
      },
      sendInputEvent: (event) => { events.push(event); },
      insertText: async (text: string) => { typed.push(text); },
    },
  };
  return { window, events, typed };
}

describe('window control', () => {
  it('lists windows by title and scales a large screenshot down', async () => {
    const { window } = fakeWindow();
    const control = new WindowControl(() => [window]);
    expect(control.list()).toEqual([{ window_id: 7, title: 'Zuri - KAI', project_id: 'zuri', focused: true }]);
    const shot = await control.screenshot();
    expect(shot.png.toString()).toBe('small');
    expect(shot.width).toBe(1280);
    expect(shot.height).toBe(720);
    expect((await control.snapshot()).elements[0]!.name).toBe('Run');
  });

  it('clicks a ref at the element centre and types into it', async () => {
    const { window, events, typed } = fakeWindow();
    const control = new WindowControl(() => [window]);
    await control.click({ ref: 'e1' });
    expect(events.map((event) => event.type)).toEqual(['mouseMove', 'mouseDown', 'mouseUp']);
    expect(events[1]).toMatchObject({ x: 40, y: 20, button: 'left', clickCount: 1 });
    await control.type({ ref: 'e1', text: 'hello' });
    expect(typed).toEqual(['hello']);
    await control.pressKey({ key: 'Enter' });
    expect(events.at(-1)).toMatchObject({ type: 'keyUp', keyCode: 'Enter' });
    await expect(control.pressKey({ key: 'Power' })).rejects.toThrow(/Unknown key/);
  });

  it('refuses all input while an approval is on screen, and any control inside one', async () => {
    const blocked = fakeWindow({ approvalOpen: true });
    const control = new WindowControl(() => [blocked.window]);
    await expect(control.click({ x: 1, y: 1 })).rejects.toThrow(/approval/);
    await expect(control.type({ text: 'x' })).rejects.toThrow(/approval/);
    await expect(control.pressKey({ key: 'Enter' })).rejects.toThrow(/approval/);
    expect(blocked.events).toEqual([]);
    // Reading is still allowed.
    await expect(control.snapshot()).resolves.toBeTruthy();

    const inside = fakeWindow({ center: { x: 5, y: 5, insideApproval: true } });
    await expect(new WindowControl(() => [inside.window]).click({ ref: 'e9' })).rejects.toThrow(/approval prompt/);
    expect(inside.events).toEqual([]);
  });

  it('says so when a window or ref does not exist', async () => {
    const missing = fakeWindow({ center: null });
    const control = new WindowControl(() => [missing.window]);
    await expect(control.click({ ref: 'e9' })).rejects.toThrow(/No element e9/);
    await expect(control.screenshot(99)).rejects.toThrow(/no KAI window 99/);
    await expect(new WindowControl(() => []).screenshot()).rejects.toThrow(/No KAI window is open/);
    expect(windowBriefing('cli')).toContain('kai-window');
  });
});
