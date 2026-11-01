import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

/**
 * A choice that is remembered across closing KAI: which screen was open, which tab was showing inside a screen, whether
 * the terminal was open. It is a drop-in for `useState`. Only a value that is still one of the allowed choices is read
 * back, so a tab that was renamed or removed in an update falls back to the default and never leaves a blank screen.
 */

interface ReadStore { getItem(key: string): string | null }
interface WriteStore { setItem(key: string, value: string): void }

export function readChoice<T extends string>(store: ReadStore | null | undefined, key: string, allowed: readonly T[], fallback: T): T {
  try {
    const saved = store?.getItem(key);
    return saved !== null && saved !== undefined && (allowed as readonly string[]).includes(saved) ? (saved as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeChoice(store: WriteStore | null | undefined, key: string, value: string): void {
  try {
    store?.setItem(key, value);
  } catch {
    // A full or blocked store only means the choice is forgotten next time.
  }
}

const storage = (): Storage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};

export function usePersistentChoice<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => readChoice(storage(), key, allowed, fallback));
  useEffect(() => { writeChoice(storage(), key, value); }, [key, value]);
  return [value, setValue];
}

export function usePersistentFlag(key: string, fallback: boolean): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [value, setValue] = useState<boolean>(() => readChoice(storage(), key, ['true', 'false'] as const, fallback ? 'true' : 'false') === 'true');
  useEffect(() => { writeChoice(storage(), key, value ? 'true' : 'false'); }, [key, value]);
  return [value, setValue];
}

/** The files open in the code editor for one project, in tab order, and which one was showing. */
export interface SavedCodeTabs { openPaths: string[]; activePath: string | null }

export const codeTabsKey = (projectId: string): string => `kai.codeTabs.${projectId}`;

export function readCodeTabs(store: ReadStore | null | undefined, projectId: string): SavedCodeTabs {
  try {
    const parsed = JSON.parse(store?.getItem(codeTabsKey(projectId)) ?? 'null') as { openPaths?: unknown; activePath?: unknown } | null;
    const openPaths = Array.isArray(parsed?.openPaths)
      ? [...new Set(parsed.openPaths.filter((path): path is string => typeof path === 'string' && path.length > 0))].slice(0, 40)
      : [];
    const activePath = typeof parsed?.activePath === 'string' && openPaths.includes(parsed.activePath) ? parsed.activePath : null;
    return { openPaths, activePath };
  } catch {
    return { openPaths: [], activePath: null };
  }
}

export function writeCodeTabs(store: WriteStore | null | undefined, projectId: string, tabs: SavedCodeTabs): void {
  writeChoice(store, codeTabsKey(projectId), JSON.stringify({ openPaths: tabs.openPaths.slice(0, 40), activePath: tabs.activePath }));
}

/** The saved tabs that still exist in the project, in order, with the active one only if it survived. */
export function existingCodeTabs(saved: SavedCodeTabs, projectPaths: ReadonlySet<string>): SavedCodeTabs {
  const openPaths = saved.openPaths.filter((path) => projectPaths.has(path));
  return { openPaths, activePath: saved.activePath && openPaths.includes(saved.activePath) ? saved.activePath : openPaths.at(-1) ?? null };
}
