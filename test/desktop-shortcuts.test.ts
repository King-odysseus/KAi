import { describe, expect, it } from 'vitest';
import { DEFAULT_DESKTOP_SHORTCUTS } from '../packages/contracts/src';
import {
  matchingShortcutAction,
  shortcutConflicts,
  shortcutFromEvent,
  shortcutsWithDefaults,
} from '../apps/desktop/src/renderer/src/shortcuts';

function keyEvent(
  key: string,
  modifiers: Partial<Pick<KeyboardEvent, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>> = {},
): Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'> {
  return {
    key,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...modifiers,
  };
}

describe('desktop shortcut customization', () => {
  it('resolves configured shortcuts and leaves unrelated keys alone', () => {
    const shortcuts = { ...DEFAULT_DESKTOP_SHORTCUTS };

    expect(matchingShortcutAction(keyEvent('k', { ctrlKey: true }), shortcuts)).toBe('command-palette');
    expect(matchingShortcutAction(keyEvent('`', { ctrlKey: true }), shortcuts)).toBe('terminal');
    expect(matchingShortcutAction(keyEvent('j', { ctrlKey: true }), shortcuts)).toBeNull();
  });

  it('uses a customized binding and releases the old binding', () => {
    const shortcuts = { ...DEFAULT_DESKTOP_SHORTCUTS, 'command-palette': 'Ctrl+Shift+P' };

    expect(matchingShortcutAction(keyEvent('p', { ctrlKey: true, shiftKey: true }), shortcuts)).toBe('command-palette');
    expect(matchingShortcutAction(keyEvent('k', { ctrlKey: true }), shortcuts)).toBeNull();
  });

  it('captures key combinations and reports duplicate assignments', () => {
    expect(shortcutFromEvent(keyEvent('p', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+P');
    expect(shortcutFromEvent(keyEvent('p'))).toBeNull();

    const shortcuts = shortcutsWithDefaults({
      'command-palette': 'Ctrl+Shift+P',
      shortcuts: 'Ctrl+Shift+P',
    });
    expect(shortcutConflicts(shortcuts)).toEqual([
      'Command palette and Shortcut sheet use Ctrl+Shift+P.',
    ]);
  });
});
