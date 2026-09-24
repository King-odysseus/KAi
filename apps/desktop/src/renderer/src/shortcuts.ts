import { DEFAULT_DESKTOP_SHORTCUTS, type AppSettings } from '@kai/contracts';

export interface ShortcutDefinition {
  id: string;
  label: string;
  description: string;
}

export const SHORTCUT_DEFINITIONS: readonly ShortcutDefinition[] = [
  { id: 'workbench', label: 'Agent Workbench', description: 'Return to the active conversation and composer' },
  { id: 'code', label: 'Code editor', description: 'Open the persistent project editor' },
  { id: 'new-window', label: 'New window', description: 'Open another independent KAI project window' },
  { id: 'terminal', label: 'Terminal panel', description: 'Show or hide the interactive terminal' },
  { id: 'command-palette', label: 'Command palette', description: 'Search commands, conversations, and the brain' },
  { id: 'threads', label: 'Threads panel', description: 'Show or hide the conversation list on the left' },
  { id: 'context-panel', label: 'Context panel', description: 'Show or hide project context on the right' },
  { id: 'shortcuts', label: 'Shortcut sheet', description: 'Open this keyboard shortcut reference' },
] as const;

export function shortcutsWithDefaults(shortcuts: AppSettings['shortcuts']): AppSettings['shortcuts'] {
  return { ...DEFAULT_DESKTOP_SHORTCUTS, ...shortcuts };
}

export function shortcutLabel(shortcuts: AppSettings['shortcuts'], id: string): string {
  return shortcutsWithDefaults(shortcuts)[id] ?? '';
}

export function matchingShortcutAction(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>,
  shortcuts: AppSettings['shortcuts'],
): string | null {
  for (const definition of SHORTCUT_DEFINITIONS) {
    const shortcut = shortcutsWithDefaults(shortcuts)[definition.id];
    if (shortcut && shortcutMatches(event, shortcut)) return definition.id;
  }
  return null;
}

export function shortcutMatches(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>,
  shortcut: string,
): boolean {
  const parsed = parseShortcut(shortcut);
  if (!parsed) return false;
  return event.ctrlKey === parsed.ctrl
    && event.shiftKey === parsed.shift
    && event.altKey === parsed.alt
    && event.metaKey === parsed.meta
    && normalizeEventKey(event.key) === parsed.key;
}

export function shortcutFromEvent(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>,
): string | null {
  const key = normalizeEventKey(event.key);
  if (!key || isModifierKey(key)) return null;
  if (!event.ctrlKey && !event.altKey && !event.metaKey && !/^f([1-9]|1\d|2[0-4])$/.test(key)) return null;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Meta');
  parts.push(displayKey(key));
  return parts.join('+');
}

export function shortcutConflicts(shortcuts: AppSettings['shortcuts']): string[] {
  const seen = new Map<string, string>();
  const conflicts: string[] = [];
  for (const definition of SHORTCUT_DEFINITIONS) {
    const value = shortcuts[definition.id].trim();
    if (!value) continue;
    const normalized = canonicalShortcut(value);
    if (!normalized) continue;
    const existing = seen.get(normalized);
    if (existing) conflicts.push(`${existing} and ${definition.label} use ${value}.`);
    else seen.set(normalized, definition.label);
  }
  return conflicts;
}

function parseShortcut(shortcut: string): { ctrl: boolean; shift: boolean; alt: boolean; meta: boolean; key: string } | null {
  const parts = shortcut.trim().split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const rawKey = parts.at(-1);
  if (!rawKey) return null;
  const key = normalizeEventKey(rawKey === 'Esc' ? 'Escape' : rawKey);
  if (!key) return null;
  const modifiers = new Set(parts.slice(0, -1).map((part) => part.toLowerCase()));
  const ctrl = modifiers.has('ctrl') || modifiers.has('control');
  const shift = modifiers.has('shift');
  const alt = modifiers.has('alt') || modifiers.has('option');
  const meta = modifiers.has('meta') || modifiers.has('cmd') || modifiers.has('command');
  if (!ctrl && !shift && !alt && !meta && !/^f([1-9]|1\d|2[0-4])$/.test(key)) return null;
  if (modifiers.size > Number(ctrl) + Number(shift) + Number(alt) + Number(meta)) return null;
  return { ctrl, shift, alt, meta, key };
}

function canonicalShortcut(shortcut: string): string | null {
  const parsed = parseShortcut(shortcut);
  if (!parsed) return null;
  return `${Number(parsed.ctrl)}:${Number(parsed.alt)}:${Number(parsed.shift)}:${Number(parsed.meta)}:${parsed.key}`;
}

function normalizeEventKey(value: string): string {
  if (value === ' ') return 'space';
  const lower = value.toLowerCase();
  if (lower === 'esc') return 'escape';
  return lower;
}

function isModifierKey(value: string): boolean {
  return value === 'control' || value === 'shift' || value === 'alt' || value === 'meta';
}

function displayKey(value: string): string {
  if (value === 'space') return 'Space';
  if (value === 'escape') return 'Esc';
  if (value.length === 1) return value.toUpperCase();
  return value.charAt(0).toUpperCase() + value.slice(1);
}
