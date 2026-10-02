import { describe, expect, it } from 'vitest';
import { describeRunOutcome, outstandingLine } from '../apps/desktop/src/main/run-summary';

/**
 * The closing line when the model gave none. It is written from facts KAI holds, so the thing worth testing is that
 * it is accurate about them and readable — this is the only account of the run the reader gets.
 */
describe('saying what a run did', () => {
  it('names what changed and what the checks said', () => {
    const summary = describeRunOutcome({
      status: 'completed',
      files: ['prisma/seed.ts', 'tests/unit/db-singleton.test.ts'],
      checks: [{ command: 'npm test', passed: true }],
    });

    expect(summary).toContain('finished');
    expect(summary).toContain('2 files');
    expect(summary).toContain('prisma/seed.ts');
    expect(summary).toContain('Checks passed: npm test.');
  });

  it('says plainly that nothing changed rather than listing nothing', () => {
    const summary = describeRunOutcome({ status: 'completed', files: [], checks: [] });
    expect(summary).toContain('changed no files');
    expect(summary).toContain('No check was run.');
  });

  it('leads with why it stopped, since that is what the reader is looking for', () => {
    const summary = describeRunOutcome({
      status: 'failed',
      files: ['a.ts'],
      checks: [{ command: 'npm test', passed: false }],
      error: 'The provider returned no output.',
    });

    expect(summary).toContain('stopped before it finished');
    expect(summary).toContain('The provider returned no output.');
    expect(summary).toContain('Checks failed: npm test.');
  });

  it('says what is still outstanding, which is the half a model leaves out', () => {
    const summary = describeRunOutcome({
      status: 'completed',
      files: ['a.ts'],
      checks: [],
      remaining: ['Add the tests', 'Wire it into the page'],
    });

    expect(summary).toContain('Still to do: Add the tests, Wire it into the page.');
    // The line is also offered on its own, so a run where the model did speak still says what it did not reach.
    expect(outstandingLine(['Add the tests'])).toBe('Still to do: Add the tests.');
    expect(outstandingLine([])).toBe('');
    expect(outstandingLine(undefined)).toBe('');
  });

  it('shortens a long file list instead of reciting it', () => {
    const files = Array.from({ length: 9 }, (_unused, index) => `src/file-${index}.ts`);
    const summary = describeRunOutcome({ status: 'completed', files, checks: [] });

    expect(summary).toContain('9 files');
    expect(summary).toContain('and 4 more');
    expect(summary).not.toContain('file-8');
  });
});
