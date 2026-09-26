export interface ReloadShortcutInput {
  type: string;
  key: string;
  control: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

export type ReloadKind = 'reload' | 'force';

/** Match the browser-style reload shortcuts: Ctrl/Cmd+R, Ctrl/Cmd+Shift+R (skip cache) and F5. */
export function reloadShortcut(input: ReloadShortcutInput): ReloadKind | null {
  if (input.type !== 'keyDown' || input.alt) return null;
  const key = input.key.toLowerCase();
  if (key === 'f5') return input.control || input.meta || input.shift ? 'force' : 'reload';
  if (key === 'r' && (input.control || input.meta)) return input.shift ? 'force' : 'reload';
  return null;
}
