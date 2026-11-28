import { writtenPaths, type ConversationRecord } from '@kai/contracts';

export function workspaceEdits(conversation: ConversationRecord | null) {
  const changes: Array<{ path: string; key: string }> = [];
  const ranges: Record<string, { start: number; end: number }> = {};
  let latestLive: { path: string; key: string } | null = null;
  const events = conversation?.events ?? [];
  for (const [index, event] of events.entries()) {
    const previous = events[index - 1];
    const legacyAppliedDiff = event.type === 'diff.proposal' && previous && (previous.type === 'file.edit.applied' && previous.filePath === event.filePath || previous.type === 'file.change' && previous.path === event.filePath);
    if (event.type === 'diff.proposal' && (event.applied || legacyAppliedDiff)) {
      changes.push({ path: event.filePath, key: event.id });
      latestLive = changes.at(-1)!;
      const range = diffChangedRange(event.diff ?? '');
      if (range) ranges[event.filePath] = range;
    } else if (event.type === 'turn.changes') {
      for (const file of event.files) {
        const discovered = !changes.some((item) => item.path === file.path);
        changes.push({ path: file.path, key: event.id });
        if (discovered) latestLive = changes.at(-1)!;
      }
    } else {
      for (const path of writtenPaths(event, true)) { changes.push({ path, key: `${event.id}:${event.type === 'tool.call' ? event.status : event.type}` }); latestLive = changes.at(-1)!; }
    }
  }
  const paths = [...new Set(changes.map((item) => item.path))];
  return { paths, ranges, latest: latestLive ?? changes.at(-1) ?? null, revision: changes.map((item) => item.key).join('|') };
}

/** Actual added/deleted hunk lines, excluding unchanged context around them. */
export function diffChangedRange(diff: string): { start: number; end: number } | null {
  const changed: number[] = [];
  let cursor: number | null = null;
  for (const line of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { cursor = Math.max(1, Number(hunk[1])); continue; }
    if (cursor === null || line.startsWith('\\')) continue;
    if (line.startsWith('+')) { changed.push(cursor); cursor++; }
    else if (line.startsWith('-')) changed.push(cursor);
    else if (line.startsWith(' ')) cursor++;
  }
  return changed.length ? { start: Math.min(...changed), end: Math.max(...changed) } : null;
}

export function changedLineRange(before: string, after: string): { start: number; end: number } | null {
  if (before === after) return null;
  const a = before.split('\n'), b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = b.length;
  let oldEnd = a.length;
  while (end > start && oldEnd > start && b[end - 1] === a[oldEnd - 1]) { end--; oldEnd--; }
  const first = Math.max(1, Math.min(start + 1, b.length));
  return { start: first, end: Math.max(first, Math.min(end, b.length)) };
}
