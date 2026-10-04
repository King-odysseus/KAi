import { describe, expect, it, vi } from 'vitest';
import { DesktopRunControl } from '../apps/desktop/src/main/run-control';

describe('desktop run control', () => {
  it('suspends a paused run and resumes its waiter once', async () => {
    const suspendRun = vi.fn();
    const resumeRun = vi.fn();
    const control = new DesktopRunControl({ suspendRun, resumeRun });
    const controller = new AbortController();

    await expect(control.pause('conversation-1')).resolves.toBe(true);
    expect(control.isPaused('conversation-1')).toBe(true);
    const waiting = control.waitIfPaused('conversation-1', controller.signal);
    let settled = false;
    void waiting.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    expect(control.resume('conversation-1')).toBe(true);
    await waiting;
    expect(control.isPaused('conversation-1')).toBe(false);
    expect(suspendRun).toHaveBeenCalledTimes(1);
    expect(resumeRun).toHaveBeenCalledTimes(1);

    expect(control.resume('conversation-1')).toBe(true);
    expect(resumeRun).toHaveBeenCalledTimes(1);
  });

  it('releases paused waiters when a run is cancelled or forgotten', async () => {
    const control = new DesktopRunControl();
    const cancelled = new AbortController();
    await control.pause('cancelled-run');
    const cancelledWait = control.waitIfPaused('cancelled-run', cancelled.signal);
    cancelled.abort(new Error('stop requested'));
    await expect(cancelledWait).rejects.toThrow('stop requested');

    await control.pause('forgotten-run');
    let resolved = false;
    const forgottenWait = control.waitIfPaused('forgotten-run', new AbortController().signal);
    void forgottenWait.then(() => { resolved = true; });
    control.forget('forgotten-run');
    await forgottenWait;
    expect(resolved).toBe(true);
    expect(control.isPaused('forgotten-run')).toBe(false);
  });

  it('answers false, and does not claim to be paused, when the run could not actually be suspended', async () => {
    // A run with no process to hold yet cannot be paused. Saying "paused" anyway is what the button used to do, and
    // it left the composer showing a paused run that was still working.
    const control = new DesktopRunControl({ suspendRun: () => { throw new Error('no process to suspend'); } });

    await expect(control.pause('conversation-1')).resolves.toBe(false);
    expect(control.isPaused('conversation-1')).toBe(false);

    // And with no suspend hook at all, a pause is a plain cooperative flag, which is real.
    const plain = new DesktopRunControl();
    await expect(plain.pause('conversation-2')).resolves.toBe(true);
    expect(plain.isPaused('conversation-2')).toBe(true);
  });
});
