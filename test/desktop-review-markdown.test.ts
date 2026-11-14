import { describe, expect, it } from 'vitest';
import type { ChangeReviewResult } from '@kai/contracts';
import { reviewToMarkdown } from '../apps/desktop/src/renderer/src/review-markdown';

const base: ChangeReviewResult = { ok: false, summary: 'Two problems.', findings: [], reviewedFiles: ['a.ts'], skippedFiles: [] };

describe('review as Markdown for a pull request', () => {
  it('lists the worst findings first, with file and line, and marks unconfirmed ones', () => {
    const text = reviewToMarkdown({
      ...base,
      dismissed: 2,
      skippedFiles: [{ file: 'logo.png', reason: 'Binary file' }],
      findings: [
        { file: 'b.ts', severity: 'low', note: 'Naming\nis odd.' },
        { file: 'a.ts', line: 12, severity: 'high', note: 'Null is not handled.', verdict: 'confirmed' },
        { file: 'c.ts', severity: 'medium', note: 'Maybe racy.', verdict: 'plausible' },
      ],
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe('## Review notes');
    expect(text.indexOf('**High**')).toBeLessThan(text.indexOf('**Medium**'));
    expect(text.indexOf('**Medium**')).toBeLessThan(text.indexOf('**Low**'));
    expect(text).toContain('`a.ts:12`');
    expect(text).toContain('_(unconfirmed)_');
    expect(text).toContain('Naming is odd.');
    expect(text).toContain('2 findings were dismissed by a second check.');
    expect(text).toContain('Not reviewed: logo.png (binary file).');
  });

  it('says so plainly when there is nothing to report', () => {
    expect(reviewToMarkdown({ ...base, ok: true, summary: '' })).toBe('## Review notes\n\nNo problems found.\n');
  });
});
