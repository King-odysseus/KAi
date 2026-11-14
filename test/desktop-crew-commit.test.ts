import { describe, expect, it } from 'vitest';
import { draftCommitMessage } from '../apps/desktop/src/renderer/src/crew-commit';

describe('drafting the commit message for a finished crew', () => {
  it('names the first task, counts the rest, and lists every task below', () => {
    const message = draftCommitMessage(['Log schema', 'Ingestion endpoint', 'Search']);
    expect(message.split('\n')[0]).toBe('Log schema, and 2 more');
    expect(message).toContain('- Ingestion endpoint');
    expect(message).toContain('- Search');
  });

  it('uses the single task as the subject, and a plain line when nothing was accepted', () => {
    expect(draftCommitMessage(['Log schema']).split('\n')[0]).toBe('Log schema');
    expect(draftCommitMessage([])).toBe('Crew changes');
  });

  it('keeps the first line short enough to read in a log', () => {
    const subject = draftCommitMessage(['A'.repeat(120), 'B']).split('\n')[0] ?? '';
    expect(subject.length).toBeLessThanOrEqual(72);
    expect(subject.endsWith('…')).toBe(true);
  });
});
