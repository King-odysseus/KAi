import { describe, expect, it } from 'vitest';
import { reloadShortcut, type ReloadShortcutInput } from '../apps/desktop/src/main/reload-shortcut';

const press = (key: string, modifiers: Partial<ReloadShortcutInput> = {}): ReloadShortcutInput => ({
  type: 'keyDown', key, control: false, meta: false, alt: false, shift: false, ...modifiers,
});

describe('reload shortcut', () => {
  it('reloads on Ctrl/Cmd+R and F5, and skips the cache with Shift', () => {
    expect(reloadShortcut(press('r', { control: true }))).toBe('reload');
    expect(reloadShortcut(press('R', { meta: true }))).toBe('reload');
    expect(reloadShortcut(press('R', { control: true, shift: true }))).toBe('force');
    expect(reloadShortcut(press('F5'))).toBe('reload');
    expect(reloadShortcut(press('F5', { control: true }))).toBe('force');
  });

  it('ignores plain typing, other chords, key releases, and Alt combinations', () => {
    expect(reloadShortcut(press('r'))).toBeNull();
    expect(reloadShortcut(press('s', { control: true }))).toBeNull();
    expect(reloadShortcut(press('r', { control: true, alt: true }))).toBeNull();
    expect(reloadShortcut({ ...press('r', { control: true }), type: 'keyUp' })).toBeNull();
  });
});
