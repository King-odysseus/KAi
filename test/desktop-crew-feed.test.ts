import { describe, expect, it } from 'vitest';
import type { CrewFeedEntry } from '@kai/contracts';
import { collapseFeed } from '../apps/desktop/src/renderer/src/crew-feed';

const entry = (id: string, text: string, patch: Partial<CrewFeedEntry> = {}): CrewFeedEntry =>
  ({ id, at: `2026-11-14T10:0${id}:00.000Z`, who: 'builder', kind: 'info', text, ...patch });

describe('collapsing the live feed', () => {
  it('folds identical entries that follow one another into one line with a count', () => {
    const groups = collapseFeed([entry('1', 'Started it.'), entry('2', 'Failed.'), entry('3', 'Failed.'), entry('4', 'Failed.')]);
    expect(groups.map((group) => [group.entry.text, group.count])).toEqual([['Failed.', 3], ['Started it.', 1]]);
    expect(groups[0]?.entry.id).toBe('4');
  });

  it('keeps entries apart when something else happened between them, or who or what differs', () => {
    const groups = collapseFeed([entry('1', 'Failed.'), entry('2', 'Accepted.', { kind: 'accepted' }), entry('3', 'Failed.'), entry('4', 'Failed.', { who: 'lead' })]);
    expect(groups.map((group) => group.count)).toEqual([1, 1, 1, 1]);
  });

  it('shows the newest first and handles an empty feed', () => {
    expect(collapseFeed([entry('1', 'a'), entry('2', 'b')]).map((group) => group.entry.text)).toEqual(['b', 'a']);
    expect(collapseFeed([])).toEqual([]);
  });
});
