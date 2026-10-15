import { describe, expect, it } from 'vitest';
import { findAnchor, placeSuggestion, responseReferenceTarget, suggestionTarget } from '../apps/desktop/src/renderer/src/learning-placement';

/** Applies an edit to plain lines the way the editor would, so the tests read as before-and-after files. */
function apply(lines: string[], result: ReturnType<typeof placeSuggestion>): string {
  if (!result.ok) throw new Error(result.reason);
  const { range, text } = result.edit;
  const source = lines.join('\n');
  const offset = (line: number, column: number): number => lines.slice(0, line - 1).reduce((sum, item) => sum + item.length + 1, 0) + column - 1;
  return source.slice(0, offset(range.startLineNumber, range.startColumn)) + text + source.slice(offset(range.endLineNumber, range.endColumn));
}

const file = [
  'def main():',
  '    total = 0',
  '    return total',
  '',
  'def other():',
  '    return 1',
];

describe('the file a tutor suggestion is meant for', () => {
  const instructions = 'Type this line inside the MIDDLEWARE list in config/settings.py, directly below the entry ending in django.contrib.auth.middleware.AuthenticationMiddleware. accounts/middleware.py stays as it is.';

  it('opens the file the instructions name, not the first file cited as context', () => {
    const notes = [
      { label: 'The middleware', filePath: 'accounts/middleware.py', startLine: 1, endLine: 20 },
      { label: 'Settings', filePath: 'config/settings.py', startLine: 40, endLine: 52 },
    ];
    expect(suggestionTarget([instructions], notes)).toEqual({ filePath: 'config/settings.py', startLine: 40, endLine: 52 });
  });

  it('opens a named path the tutor did not cite, and falls back to the first citation when none is named', () => {
    expect(suggestionTarget([instructions], [{ filePath: 'accounts/middleware.py' }])).toEqual({ filePath: 'config/settings.py' });
    expect(suggestionTarget(['Add it after the import.'], [{ filePath: 'src/app.ts', startLine: 3 }])).toEqual({ filePath: 'src/app.ts', startLine: 3 });
    expect(suggestionTarget(['Add it after the import.'], [])).toBeNull();
  });
});

describe('the tutor reference for its next action', () => {
  it('opens the file named in the next step instead of an unrelated first citation', () => {
    expect(responseReferenceTarget(
      ['Open accounts/middleware.py and read line 11, then check config/settings.py.'],
      [{ filePath: 'docs/STATUS.md', startLine: 28, endLine: 30 }],
      ['docs/STATUS.md', 'accounts/middleware.py', 'config/settings.py'],
    )).toEqual({ filePath: 'accounts/middleware.py' });
  });

  it('uses line citations only for the chosen file and refuses missing or ambiguous paths', () => {
    const notes = [{ filePath: 'src/app.ts', startLine: 3, endLine: 5 }];
    expect(responseReferenceTarget(['Open src/app.ts.'], notes, ['src/app.ts'])).toEqual({ filePath: 'src/app.ts', startLine: 3, endLine: 5 });
    expect(responseReferenceTarget(['Open src/missing.ts.'], notes, ['src/app.ts'])).toBeNull();
    expect(responseReferenceTarget(['Open app.ts.'], notes, ['src/app.ts', 'test/app.ts'])).toBeNull();
  });
});

describe('placing a tutor suggestion', () => {
  it('finds whole anchor lines even when the tutor got their indentation wrong', () => {
    expect(findAnchor(file, 'total = 0\n  return total')).toEqual([{ start: 2, end: 3 }]);
    expect(findAnchor(file, '\n\n')).toEqual([]);
    expect(findAnchor(file, 'tot')).toEqual([]);
  });

  it('puts flush-left code inside the block it follows', () => {
    const result = placeSuggestion(file, { filePath: 'app.py', anchor: 'def main():', position: 'after' }, 'print("start")');
    expect(apply(file, result).split('\n').slice(0, 3)).toEqual(['def main():', '    print("start")', '    total = 0']);
    expect(result.ok && result.edit.insertedLines).toEqual({ start: 2, end: 2 });
  });

  it('keeps code the tutor already indented, and inserts before or in place of the anchor', () => {
    const before = placeSuggestion(file, { filePath: 'app.py', anchor: 'return total', position: 'before' }, '    total += 1\n');
    expect(apply(file, before).split('\n').slice(1, 4)).toEqual(['    total = 0', '    total += 1', '    return total']);
    const replaced = placeSuggestion(file, { filePath: 'app.py', anchor: 'total = 0', position: 'replace' }, 'total = 10\nif total:\n    total -= 1');
    expect(apply(file, replaced).split('\n').slice(1, 4)).toEqual(['    total = 10', '    if total:', '        total -= 1']);
    expect(replaced.ok && replaced.edit.insertedLines).toEqual({ start: 2, end: 4 });
  });

  it('refuses to guess when the anchor is missing or appears more than once', () => {
    const missing = placeSuggestion(file, { filePath: 'app.py', anchor: 'return total * 2', position: 'after' }, 'x');
    expect(missing).toMatchObject({ ok: false, reason: expect.stringContaining('not in app.py') });
    const twice = placeSuggestion(['a', 'b', 'a'], { filePath: 'x.ts', anchor: 'a', position: 'after' }, 'c');
    expect(twice).toMatchObject({ ok: false, reason: expect.stringContaining('2 times') });
  });
});
