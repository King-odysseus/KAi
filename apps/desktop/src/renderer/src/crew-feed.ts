import type { CrewFeedEntry } from '@kai/contracts';

/** One line of the live feed: the newest entry of a run of identical ones, and how many there were. */
export interface FeedGroup {
  entry: CrewFeedEntry;
  count: number;
}

const sameLine = (a: CrewFeedEntry, b: CrewFeedEntry): boolean =>
  a.kind === b.kind && a.who === b.who && a.text === b.text && (a.taskId ?? null) === (b.taskId ?? null);

/**
 * The feed as a person reads it, newest first. Entries that repeat one after another (a task failing the same way
 * five times) fold into one line with a count, so one noisy task cannot push everything else off the screen.
 */
export function collapseFeed(feed: readonly CrewFeedEntry[]): FeedGroup[] {
  const groups: FeedGroup[] = [];
  for (const entry of feed) {
    const last = groups[groups.length - 1];
    if (last && sameLine(last.entry, entry)) {
      last.entry = entry;
      last.count += 1;
    } else {
      groups.push({ entry, count: 1 });
    }
  }
  return groups.reverse();
}
