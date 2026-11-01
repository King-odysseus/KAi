import { describe, expect, it } from 'vitest';
import { existingCodeTabs, readChoice, readCodeTabs, writeChoice, writeCodeTabs } from '../apps/desktop/src/renderer/src/persistent-choice';

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}

describe('remembered choices', () => {
  const screens = ['workspace', 'crew', 'brain'] as const;

  it('brings back the screen or tab that was open', () => {
    const store = memory();
    writeChoice(store, 'kai.view', 'crew');
    expect(readChoice(store, 'kai.view', screens, 'workspace')).toBe('crew');
  });

  it('falls back to the default for nothing saved, a choice that no longer exists, or a store that fails', () => {
    expect(readChoice(memory(), 'kai.view', screens, 'workspace')).toBe('workspace');
    expect(readChoice(memory({ 'kai.view': 'removed-in-an-update' }), 'kai.view', screens, 'workspace')).toBe('workspace');
    expect(readChoice({ getItem: () => { throw new Error('blocked'); } }, 'kai.view', screens, 'workspace')).toBe('workspace');
    expect(readChoice(null, 'kai.view', screens, 'workspace')).toBe('workspace');
    expect(() => writeChoice({ setItem: () => { throw new Error('full'); } }, 'k', 'v')).not.toThrow();
  });

  it('remembers whether the terminal was open', () => {
    const store = memory();
    writeChoice(store, 'kai.terminalOpen', 'true');
    expect(readChoice(store, 'kai.terminalOpen', ['true', 'false'] as const, 'false')).toBe('true');
  });
});

describe('remembered code tabs', () => {
  it('brings back every open file, in order, with the one that was showing', () => {
    const store = memory();
    writeCodeTabs(store, 'p1', { openPaths: ['src/a.ts', 'src/b.ts', 'README.md'], activePath: 'src/b.ts' });
    expect(readCodeTabs(store, 'p1')).toEqual({ openPaths: ['src/a.ts', 'src/b.ts', 'README.md'], activePath: 'src/b.ts' });
  });

  it('keeps each project\'s tabs apart', () => {
    const store = memory();
    writeCodeTabs(store, 'p1', { openPaths: ['a.ts'], activePath: 'a.ts' });
    expect(readCodeTabs(store, 'p2')).toEqual({ openPaths: [], activePath: null });
  });

  it('reads nothing from corrupt or wrongly shaped data, and ignores an active file that is not open', () => {
    expect(readCodeTabs(memory({ 'kai.codeTabs.p1': 'garbage' }), 'p1')).toEqual({ openPaths: [], activePath: null });
    expect(readCodeTabs(memory({ 'kai.codeTabs.p1': '{"openPaths":"x"}' }), 'p1')).toEqual({ openPaths: [], activePath: null });
    expect(readCodeTabs(memory({ 'kai.codeTabs.p1': '{"openPaths":["a",1,"a",""],"activePath":"zzz"}' }), 'p1')).toEqual({ openPaths: ['a'], activePath: null });
  });

  it('drops tabs for files that were deleted or renamed, and falls back to the last tab that is left', () => {
    const saved = { openPaths: ['a.ts', 'gone.ts', 'c.ts'], activePath: 'gone.ts' };
    const exists = new Set(['a.ts', 'c.ts']);
    expect(existingCodeTabs(saved, exists)).toEqual({ openPaths: ['a.ts', 'c.ts'], activePath: 'c.ts' });
    expect(existingCodeTabs({ openPaths: ['a.ts'], activePath: 'a.ts' }, exists)).toEqual({ openPaths: ['a.ts'], activePath: 'a.ts' });
    expect(existingCodeTabs({ openPaths: ['x'], activePath: null }, exists)).toEqual({ openPaths: [], activePath: null });
  });
});
