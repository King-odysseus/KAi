import { describe, expect, it } from 'vitest';
import { learningProgressSchema } from '../packages/contracts/src';
import { projectLessons } from '../apps/desktop/src/renderer/src/components/learning-path';

describe('project learning path', () => {
  it('uses real files and handles an empty project without fabricated suggestions', () => {
    expect(projectLessons([], null)).toEqual([]);
    const lessons = projectLessons(['README.md', 'src/main.ts', 'test/main.test.ts'], null);
    expect(lessons.map((lesson) => lesson.filePath)).toEqual(['README.md', 'src/main.ts', 'test/main.test.ts']);
    expect(lessons[2]?.prompt).toContain('test/main.test.ts');
  });
  it('prioritises practice and advances independently demonstrated project areas', () => {
    const now = new Date().toISOString();
    const progress = learningProgressSchema.parse({ schemaVersion: 1, projectId: 'p1', preferences: { assistance: 'guided', inlineSuggestions: false }, updatedAt: now,
      concepts: [{ id: 'loops', name: 'Loops', category: 'Code', mastery: 'needs-practice', score: 20, evidenceCount: 1, evidence: [], strengths: [], nextStep: 'Trace one loop.', firstSeenAt: now, lastSeenAt: now }],
      recentEvidence: [{ id: 'readme', conceptName: 'Setup', mastery: 'independent', summary: 'Explained independently.', filePath: 'README.md', action: 'check-code', assistance: 'learn', createdAt: now }],
    });
    const lessons = projectLessons(['README.md', 'src/main.ts'], progress);
    expect(lessons[0]?.title).toBe('Practise Loops');
    expect(lessons.some((lesson) => lesson.filePath === 'README.md')).toBe(false);
    expect(lessons[1]?.filePath).toBe('src/main.ts');
  });
});
