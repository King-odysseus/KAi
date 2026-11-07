// The files opened most recently in a project, newest first, remembered per project across restarts.
const MAX_RECENT = 25;
const keyFor = (projectId: string): string => `kai.recentFiles.${projectId}`;

/** `path` moved to the front, without a duplicate, capped at `max`. */
export function pushRecent(list: readonly string[], path: string, max = MAX_RECENT): string[] {
  return [path, ...list.filter((item) => item !== path)].slice(0, max);
}

export function readRecent(projectId: string, store: Pick<Storage, 'getItem'> | null = safeStorage()): string[] {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(keyFor(projectId)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

export function writeRecent(projectId: string, list: readonly string[], store: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    store?.setItem(keyFor(projectId), JSON.stringify(list.slice(0, MAX_RECENT)));
  } catch {
    // A full or blocked store only means the list is forgotten next time.
  }
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
