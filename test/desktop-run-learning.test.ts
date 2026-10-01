import { describe, expect, it } from 'vitest';
import { composeRunLesson, type RunLessonInput } from '../apps/desktop/src/main/run-learning';

const base: RunLessonInput = {
  prompt: 'Add a retry with backoff to the provider client so a 429 does not fail the run',
  output: 'Added retryDelayMs with Retry-After support and a typed RateLimitError; the run now rests instead of failing.',
  status: 'completed',
  files: ['src/main/rate-limit.ts', 'src/main/direct-provider-runtime.ts'],
  checks: [{ command: 'npm test', passed: true }],
};

describe('composeRunLesson', () => {
  it('describes a run that changed files, with the task as the first line for the draft title', () => {
    const lesson = composeRunLesson(base);
    const [title, blank, ...account] = lesson!.summary.split('\n');
    expect(title).toBe(base.prompt.slice(0, 100).trimEnd());
    expect(blank).toBe('');
    expect(account).toHaveLength(1);
    expect(lesson?.summary).toContain('Task: Add a retry with backoff');
    expect(lesson?.summary).toContain('Result: Added retryDelayMs');
    expect(lesson?.summary).toContain('Changed 2 files: src/main/rate-limit.ts, src/main/direct-provider-runtime.ts');
    expect(lesson?.summary).toContain('Checks passed: npm test.');
    expect(lesson?.files).toEqual(base.files);
  });

  it('says so when a check failed, or when none ran', () => {
    expect(composeRunLesson({ ...base, checks: [{ command: 'npm test', passed: false }] })?.summary).toContain('Checks failed: npm test.');
    expect(composeRunLesson({ ...base, checks: [] })?.summary).toContain('No check was run.');
  });

  it('files nothing for a failed or cancelled run', () => {
    expect(composeRunLesson({ ...base, status: 'failed' })).toBeNull();
  });

  it('files nothing when no file changed, so a plain question and answer stays out of the queue', () => {
    expect(composeRunLesson({ ...base, files: [] })).toBeNull();
  });

  it('files nothing for a one-word prompt or a one-line reply', () => {
    expect(composeRunLesson({ ...base, prompt: 'fix it' })).toBeNull();
    expect(composeRunLesson({ ...base, output: 'Done.' })).toBeNull();
  });

  it('keeps a long file list and a long reply short', () => {
    const files = Array.from({ length: 30 }, (_, index) => `src/file-${index}.ts`);
    const lesson = composeRunLesson({ ...base, files, output: 'x'.repeat(5_000) });
    expect(lesson?.summary).toContain('Changed 30 files');
    expect(lesson?.summary).toContain('and 22 more');
    expect(lesson!.summary.length).toBeLessThanOrEqual(1_500);
    expect(lesson?.files).toHaveLength(30);
  });
});
