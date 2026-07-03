import { describe, expect, it } from 'vitest';

/**
 * Diff parsing pattern tests.
 *
 * The VSCodeDiffApplier requires VS Code APIs, so we test the regex patterns
 * and diff format parsing logic that the applier uses internally.
 * Full integration testing of applyDiff requires the VS Code extension host.
 */

describe('Diff parsing patterns', () => {
  it('recognizes hunk header pattern with counts', () => {
    const hunkHeader = '@@ -1,3 +1,5 @@';
    const match = hunkHeader.match(
      /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/,
    );
    expect(match).toBeTruthy();
    expect(match![1]).toBe('1');
    expect(match![2]).toBe('3');
    expect(match![3]).toBe('1');
    expect(match![4]).toBe('5');
  });

  it('recognizes hunk header without counts (defaults to 1)', () => {
    const hunkHeader = '@@ -1 +1 @@';
    const match = hunkHeader.match(
      /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/,
    );
    expect(match).toBeTruthy();
    expect(match![2]).toBeUndefined();
    expect(match![4]).toBeUndefined();
  });

  it('recognizes hunk header with trailing text', () => {
    const hunkHeader = '@@ -10,20 +10,25 @@ function foo() {';
    const match = hunkHeader.match(
      /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/,
    );
    expect(match).toBeTruthy();
    expect(match![1]).toBe('10');
    expect(match![2]).toBe('20');
    expect(match![3]).toBe('10');
    expect(match![4]).toBe('25');
  });

  it('recognizes diff file headers', () => {
    const headers = [
      { line: '--- a/src/app.ts', pattern: /^---/ },
      { line: '+++ b/src/app.ts', pattern: /^\+\+\+/ },
      { line: 'diff --git a/src/app.ts b/src/app.ts', pattern: /^diff / },
      { line: 'index 1234567..abcdefg 100644', pattern: /^index / },
      { line: 'new file mode 100644', pattern: /^new file / },
      { line: 'deleted file mode 100644', pattern: /^deleted file / },
      { line: 'rename from old.ts', pattern: /^rename / },
    ];

    for (const { line, pattern } of headers) {
      expect(pattern.test(line)).toBe(true);
    }
  });

  it('identifies added lines', () => {
    expect('+new line'.startsWith('+')).toBe(true);
    expect('+'.startsWith('+')).toBe(true);
    expect('+++ b/file.ts'.startsWith('+')).toBe(true);
  });

  it('identifies removed lines', () => {
    expect('-old line'.startsWith('-')).toBe(true);
    expect('--- a/file.ts'.startsWith('-')).toBe(true);
  });

  it('identifies context lines', () => {
    expect(' unchanged context'.startsWith(' ')).toBe(true);
    expect(''.startsWith(' ')).toBe(false);
  });

  it('identifies no-newline markers', () => {
    // \ No newline at end of file
    const noNewline = '\\ No newline at end of file';
    expect(noNewline.startsWith('\\')).toBe(true);
  });
});
