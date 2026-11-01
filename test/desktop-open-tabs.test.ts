import { describe, expect, it } from 'vitest';
import { OPEN_TABS_KEY, liveOpenTabs, readOpenTabs, writeOpenTabs } from '../apps/desktop/src/renderer/src/open-tabs';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, data };
}

describe('open conversation tabs', () => {
  it('brings back three tabs, in the order they were opened, after a close', () => {
    const storage = memoryStorage();
    writeOpenTabs(storage, ['conv_a', 'conv_b', 'conv_c']);
    expect(readOpenTabs(storage)).toEqual(['conv_a', 'conv_b', 'conv_c']);
  });

  it('reads nothing back from an empty, corrupt or wrongly shaped store, and never throws', () => {
    expect(readOpenTabs(memoryStorage())).toEqual([]);
    expect(readOpenTabs(memoryStorage({ [OPEN_TABS_KEY]: 'not json' }))).toEqual([]);
    expect(readOpenTabs(memoryStorage({ [OPEN_TABS_KEY]: '{"a":1}' }))).toEqual([]);
    expect(readOpenTabs(memoryStorage({ [OPEN_TABS_KEY]: '[1,"ok",null,"",{"x":1},"ok"]' }))).toEqual(['ok']);
    expect(readOpenTabs(null)).toEqual([]);
    expect(readOpenTabs({ getItem: () => { throw new Error('blocked'); } })).toEqual([]);
  });

  it('survives a store that refuses to be written', () => {
    expect(() => writeOpenTabs({ setItem: () => { throw new Error('full'); } }, ['a'])).not.toThrow();
    expect(() => writeOpenTabs(null, ['a'])).not.toThrow();
  });

  it('does not save the same tab twice, and caps a runaway list', () => {
    const storage = memoryStorage();
    writeOpenTabs(storage, ['a', 'b', 'a']);
    expect(readOpenTabs(storage)).toEqual(['a', 'b']);
    writeOpenTabs(storage, Array.from({ length: 80 }, (_, index) => `c${index}`));
    expect(readOpenTabs(storage)).toHaveLength(30);
  });

  it('drops tabs whose conversation was deleted or archived, but never the one being looked at', () => {
    const conversations = [{ id: 'a' }, { id: 'b', archived: true }, { id: 'c' }];
    expect(liveOpenTabs(['a', 'b', 'gone', 'c'], conversations, null)).toEqual(['a', 'c']);
    expect(liveOpenTabs(['a', 'b', 'c'], conversations, 'b')).toEqual(['a', 'b', 'c']);
    expect(liveOpenTabs(['a', 'a', 'c'], conversations, null)).toEqual(['a', 'c']);
  });
});
