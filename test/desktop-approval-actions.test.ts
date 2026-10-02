import { describe, expect, it } from 'vitest';
import { approvalActions } from '../apps/desktop/src/renderer/src/approval-actions';

describe('approval prompt actions', () => {
  it('names a permission prompt after allowing and denying', () => {
    const allow = { confirmLabel: 'Allow once', cancelLabel: 'Deny', offersFullAccess: true };
    expect(approvalActions({})).toEqual(allow);
    // A tool call carries no question, and an event that predates this field must read the same way.
    expect(approvalActions({ runQuestion: null })).toEqual(allow);
  });

  it("uses the run's own two answers when the run is asking about itself", () => {
    expect(approvalActions({ runQuestion: { continueLabel: 'Continue', finishLabel: 'Finish' } })).toEqual({
      confirmLabel: 'Continue',
      cancelLabel: 'Finish',
      offersFullAccess: false,
    });
  });

  it('never offers full access on a question about the run', () => {
    // The defect this guards against: the prompt asking whether to keep spending past a per-run cost limit offered
    // "Allow & use full access", whose handler also set the conversation to full autonomy for every later run. The
    // most inviting button on the prompt that exists to stop runaway spending removed the limit permanently.
    for (const question of [
      { continueLabel: 'Continue', finishLabel: 'Finish' },
      { continueLabel: 'Keep going', finishLabel: 'Stop here' },
    ]) {
      expect(approvalActions({ runQuestion: question }).offersFullAccess).toBe(false);
    }
  });

  it('does not let a run borrow the tool wording by omitting its labels', () => {
    // An empty question is still a question: it must not fall back to the permission prompt.
    expect(approvalActions({ runQuestion: { continueLabel: '', finishLabel: '' } }).offersFullAccess).toBe(false);
  });
});
