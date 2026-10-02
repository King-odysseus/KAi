import { describe, expect, it } from 'vitest';
import type { Plan, PlanItem } from '@kai/contracts';
import {
  DesktopPlanReviewer,
  buildPlanReviewPrompt,
  mergePlanItems,
  parsePlanReview,
  type PlanReviewPorts,
} from '../apps/desktop/src/main/plan-review';

/**
 * The plan is what closes an unattended run, so a thin plan is a way to look finished. A second model reads it
 * against the task and names what it never mentioned; KAI adds those steps and follows the plan as extended.
 *
 * The rule that matters most here is that it only ever adds.
 */

const plan = (items: Array<[string, PlanItem['state']]>): Plan => ({
  schemaVersion: 1,
  items: items.map(([text, state]) => ({ text, state })),
  updatedAt: '2026-10-02T00:00:00.000Z',
});

function ports(reply: string | null): PlanReviewPorts & { sent: Array<{ system: string; user: string }> } {
  const sent: Array<{ system: string; user: string }> = [];
  return {
    sent,
    pickConnection: async () => (reply === null
      ? { reason: 'No model is configured.' }
      : { connection: {} as never }),
    requester: {
      structuredRequest: async (_connection, _names, prompt, _schemaName, _schema, parse) => {
        sent.push(prompt);
        return parse(reply!);
      },
    },
  };
}

describe('the plan read against the task', () => {
  it('adds what the plan never mentioned, and touches nothing else', () => {
    const kept = plan([['Wire the parser', 'done'], ['Run the checks', 'active']]);
    const merged = mergePlanItems(kept.items, [
      { text: 'Go through every page', state: 'pending' },
      { text: '  Wire the parser ', state: 'pending' },
    ]);
    expect(merged).toEqual([
      { text: 'Wire the parser', state: 'done' },
      { text: 'Run the checks', state: 'active' },
      { text: 'Go through every page', state: 'pending' },
    ]);
    // The agent's own items keep their order and their states: this reader adds, it does not rewrite.
    expect(merged.slice(0, 2)).toEqual(kept.items);
  });

  it('reads a reply into steps, and refuses one that is not shaped like an answer', () => {
    const review = parsePlanReview(JSON.stringify({
      missing: [{ text: '  Check the dashboard  ' }, { text: '' }, { text: 'x'.repeat(400) }],
      note: '  The plan covers the backend only.  ',
    }));
    expect(review.missing).toHaveLength(2);
    expect(review.missing[0]).toEqual({ text: 'Check the dashboard', state: 'pending' });
    expect(review.missing[1]!.text.length).toBe(300);
    expect(review.note).toBe('The plan covers the backend only.');

    expect(() => parsePlanReview('{"note":"no missing key"}')).toThrow(/expected shape/);
  });

  it('never asks for more than a handful of steps, however many come back', () => {
    const missing = Array.from({ length: 12 }, (_, index) => ({ text: `Step ${index}` }));
    expect(parsePlanReview(JSON.stringify({ missing, note: 'several' })).missing).toHaveLength(5);
  });

  it('puts the task and the plan as it stands in front of the model', () => {
    const prompt = buildPlanReviewPrompt('Go through every page and check it.', plan([['Wire the parser', 'done'], ['Run the checks', 'pending']]));
    expect(prompt.user).toContain('Go through every page and check it.');
    expect(prompt.user).toContain('[done] Wire the parser');
    expect(prompt.user).toContain('[pending] Run the checks');
    // The instruction that keeps this from becoming a second opinion on everything: only what the request asks for.
    expect(prompt.system).toContain('do not remove or reword anything');
  });

  it('says nothing at all when there is no model to ask', async () => {
    const reviewer = new DesktopPlanReviewer(ports(null));
    await expect(reviewer.review('Do the thing', plan([['A step', 'pending']]))).resolves.toBeNull();
  });

  it('does not spend a request on a plan that does not exist', async () => {
    const fake = ports(JSON.stringify({ missing: [], note: 'nothing' }));
    const reviewer = new DesktopPlanReviewer(fake);
    await expect(reviewer.review('Do the thing', plan([]))).resolves.toBeNull();
    expect(fake.sent).toHaveLength(0);
  });

  it('passes the model the request it is judging against', async () => {
    const fake = ports(JSON.stringify({ missing: [{ text: 'Check the pages' }], note: 'half of it' }));
    const reviewer = new DesktopPlanReviewer(fake);
    const review = await reviewer.review('Go through every page', plan([['Wire the parser', 'done']]));
    expect(review?.missing).toEqual([{ text: 'Check the pages', state: 'pending' }]);
    expect(fake.sent[0]!.user).toContain('Go through every page');
  });
});
