import { describe, expect, it } from 'vitest';
import { baselineReason, idlePlacesNote, isCostOutlier } from '../apps/desktop/src/main/autopilot';
import { estimateCostUsd } from '../apps/desktop/src/main/usage-budget';

describe('pricing the part of a prompt the provider served from its cache', () => {
  it('charges cache reads at a tenth, and leaves a run with no cache priced as before', () => {
    expect(estimateCostUsd('deepseek-chat', 1_000_000, 0)).toBeCloseTo(0.27);
    expect(estimateCostUsd('deepseek-chat', 1_000_000, 0, 1_000_000)).toBeCloseTo(0.027);
    expect(estimateCostUsd('deepseek-chat', 1_000_000, 0, 900_000)).toBeCloseTo(0.0513);
  });

  it('cannot discount more tokens than the prompt had, or a negative number', () => {
    expect(estimateCostUsd('deepseek-chat', 1_000_000, 0, 5_000_000)).toBeCloseTo(0.027);
    expect(estimateCostUsd('deepseek-chat', 1_000_000, 0, -5)).toBeCloseTo(0.27);
  });

  it('is still null for a model with no known price', () => {
    expect(estimateCostUsd('some-local-model', 1000, 1000, 500)).toBeNull();
  });
});

describe('telling a card that has cost far more than the others from one that is merely dear', () => {
  const closed = [0.1, 0.12, 0.09, 0.15];

  it('stops a card that has cost many times the typical closed card', () => {
    expect(isCostOutlier(1.2, closed)).toBe(true);
  });

  it('leaves a card within the usual range alone', () => {
    expect(isCostOutlier(0.3, closed)).toBe(false);
  });

  it('never stops a card that is cheap in absolute terms, however much dearer than its neighbours', () => {
    expect(isCostOutlier(0.2, [0.01, 0.01, 0.01])).toBe(false);
  });

  it('has nothing to judge by until three cards have closed', () => {
    expect(isCostOutlier(50, [])).toBe(false);
    expect(isCostOutlier(50, [0.1, 0.1])).toBe(false);
    expect(isCostOutlier(50, [0.1, 0.1, 0.1])).toBe(true);
  });

  it('leaves a run of dear cards alone', () => {
    expect(isCostOutlier(3, [2, 2.5, 3])).toBe(false);
  });
});

describe('saying why fewer agents are working than were asked for', () => {
  const clash = (title: string) => ({ title }) as never;

  it('says nothing when every place is in use', () => {
    expect(idlePlacesNote({ lanes: 4, running: 4, clashing: [clash('A')], waitingOnOthers: 3 })).toBe('');
  });

  it('names the cards held back for touching the same files', () => {
    const note = idlePlacesNote({ lanes: 8, running: 3, clashing: [clash('Login'), clash('Signup'), clash('Reset')], waitingOnOthers: 0 });
    expect(note).toContain('5 places are free');
    expect(note).toContain('"Login", "Signup" and others');
  });

  it('says cards are waiting on others when nothing is held back', () => {
    expect(idlePlacesNote({ lanes: 8, running: 7, clashing: [], waitingOnOthers: 1 })).toBe('1 place is free: 1 card waits for cards that are not done yet.');
  });

  it('has nothing to say when nothing is left to run', () => {
    expect(idlePlacesNote({ lanes: 8, running: 2, clashing: [], waitingOnOthers: 0 })).toBe('');
  });
});

describe('naming what a failed project check is about', () => {
  it('picks the failing assertion, not the summary and the clean-up note after it', () => {
    const output = [
      'PASS the Button / Icon matches node 0:18',
      'FAIL the Attach file dialog matches node 0:3779: dark: the dialog width is 1185, the node uses 480',
      'PASS no console errors during load',
      'FAIL smoke: 1 assertion(s) failed',
      'note: could not remove C:\Temp\zuri-profile-J2gvop: EPERM, Permission denied',
    ].join('\n');
    expect(baselineReason(output)).toBe('FAIL the Attach file dialog matches node 0:3779: dark: the dialog width is 1185, the node uses 480');
  });

  it('falls back to the last lines when nothing says FAIL', () => {
    expect(baselineReason('one\ntwo\nthree\nfour')).toBe('two | three | four');
  });
});
