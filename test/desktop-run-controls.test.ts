import { describe, expect, it } from 'vitest';
import {
  canPauseRun,
  canResumeRun,
  canStopRun,
  steerWaitingNotice,
  type RunControlState,
} from '../apps/desktop/src/renderer/src/run-controls';

const idle: RunControlState = { running: false, paused: false, autoWaiting: false, awaitingApproval: false };

/**
 * The composer draws Stop and Resume for a run that is paused, waiting on a question, or parked by Auto for the person.
 * The handlers behind them used to ask for a turn in flight, so in each of those states the button was on screen and
 * pressing it did nothing. The two sides now read these same rules.
 */
describe('which run controls have something to act on', () => {
  it('lets Stop end a run in every state it is drawn for, not only one with a turn in flight', () => {
    expect(canStopRun({ ...idle, running: true })).toBe(true);
    expect(canStopRun({ ...idle, paused: true })).toBe(true);
    // Auto parked until the person answers: no turn is running, and Stop is still how they end it.
    expect(canStopRun({ ...idle, autoWaiting: true })).toBe(true);
    expect(canStopRun({ ...idle, awaitingApproval: true })).toBe(true);
    expect(canStopRun(idle)).toBe(false);
  });

  it('lets Resume pick up a run that was paused or parked, with or without a turn in flight', () => {
    expect(canResumeRun({ ...idle, paused: true })).toBe(true);
    expect(canResumeRun({ ...idle, autoWaiting: true })).toBe(true);
    expect(canResumeRun({ ...idle, running: true, paused: true })).toBe(true);
    // Nothing is held, so there is nothing to resume.
    expect(canResumeRun({ ...idle, running: true })).toBe(false);
    expect(canResumeRun(idle)).toBe(false);
  });

  it('only offers Pause for a turn that is going and not already held', () => {
    expect(canPauseRun({ ...idle, running: true })).toBe(true);
    expect(canPauseRun({ ...idle, running: true, paused: true })).toBe(false);
    expect(canPauseRun({ ...idle, running: true, autoWaiting: true })).toBe(false);
    expect(canPauseRun({ ...idle, running: true, awaitingApproval: true })).toBe(false);
    expect(canPauseRun(idle)).toBe(false);
  });
});

describe('what a steered message says while it waits', () => {
  it('says plainly that a paused run takes it on resume, instead of sounding like it is being sent', () => {
    const paused = steerWaitingNotice(true);
    expect(paused).toContain('paused');
    expect(paused).toContain('resume');
    expect(steerWaitingNotice(false)).toBe('Waiting for the active model to take this message.');
  });
});
