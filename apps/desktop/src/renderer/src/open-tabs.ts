/**
 * Which conversation tabs were open, so KAI can bring them back after it is closed. The list is only the order and the
 * ids; the conversations themselves are already saved. An id that no longer names a live conversation (deleted or
 * archived since) is dropped when the list is read back, so a stale tab never shows.
 */

export const OPEN_TABS_KEY = 'kai.openConversationTabs';
const MAX_TABS = 30;

interface TabStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The saved tab ids, or an empty list when nothing usable was saved. Never throws: storage can be blocked or corrupt. */
export function readOpenTabs(storage: Pick<TabStorage, 'getItem'> | null | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(OPEN_TABS_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((id): id is string => typeof id === 'string' && id.length > 0))].slice(0, MAX_TABS);
  } catch {
    return [];
  }
}

export function writeOpenTabs(storage: Pick<TabStorage, 'setItem'> | null | undefined, ids: readonly string[]): void {
  try {
    storage?.setItem(OPEN_TABS_KEY, JSON.stringify([...new Set(ids)].slice(0, MAX_TABS)));
  } catch {
    // Remembering tabs is a convenience; a full or blocked store must not break the app.
  }
}

/**
 * Keeps the open tabs that still name a live conversation, in the order they were opened. An archived conversation is
 * not a tab. The active one is always kept, so the tab you are looking at never disappears.
 */
export function liveOpenTabs(
  ids: readonly string[],
  conversations: ReadonlyArray<{ id: string; archived?: boolean }>,
  activeId: string | null,
): string[] {
  const live = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  const kept = ids.filter((id) => {
    const conversation = live.get(id);
    return conversation !== undefined && (!conversation.archived || id === activeId);
  });
  return [...new Set(kept)];
}
