import { describe, expect, it } from 'vitest';
import { excerptSection, pathsMentioned } from '../apps/desktop/src/main/crew-excerpts';

describe('files a card names', () => {
  it('finds the paths in the order they are named, without repeats', () => {
    expect(pathsMentioned('Edit src/main/store.js, then add a test in test/store.test.ts and re-check src/main/store.js.')).toEqual(['src/main/store.js', 'test/store.test.ts']);
  });

  it('finds a bare file name and a path with a dot directory', () => {
    expect(pathsMentioned('Update package.json and ./web/src/App.jsx.')).toEqual(['package.json', 'web/src/App.jsx']);
  });

  it('stops at the limit', () => {
    expect(pathsMentioned('a.ts b.ts c.ts d.ts e.ts', 3)).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('ignores URLs, parent directories, absolute paths and words that only look like files', () => {
    expect(pathsMentioned('See https://example.com/docs/page.html and ../secrets/key.json and /etc/hosts.txt.')).toEqual([]);
    expect(pathsMentioned('This is version 1.2 of the thing, e.g. the end.')).toEqual([]);
  });

  it('does not take part of a longer extension for a file', () => {
    expect(pathsMentioned('Change src/App.tsx')).toEqual(['src/App.tsx']);
  });
});

describe('the section attached to a card', () => {
  it('is empty when there is nothing to attach', () => {
    expect(excerptSection([])).toBe('');
  });

  it('names each file and says when only the start is shown', () => {
    const text = excerptSection([{ path: 'src/a.ts', text: 'export const a = 1;', cut: false }, { path: 'src/b.ts', text: 'export const b = 2;', cut: true }]);
    expect(text).toContain('--- src/a.ts\nexport const a = 1;');
    expect(text).toContain('--- src/b.ts (the start of the file; read on if you need more)');
    expect(text).toContain('so you do not have to search for it');
  });
});
