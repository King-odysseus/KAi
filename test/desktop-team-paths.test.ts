import { describe, expect, it } from 'vitest';
import { conflictDetail, teamPaths } from '../apps/desktop/src/renderer/src/team-paths';

describe('team file conflicts', () => {
  it('asks about each editing part\'s files once, and never about a read-only review', () => {
    const paths = teamPaths([
      { role: 'frontend', paths: ['src/ui', ' src/shared '] },
      { role: 'backend', paths: ['src/api', 'src/shared'] },
      { role: 'securityReviewer', paths: ['src/secret'] },
      { role: 'codeReviewer', paths: [] },
      { role: 'docs', paths: ['', 'README.md'] },
    ]);

    expect(paths).toEqual(['src/ui', 'src/shared', 'src/api', 'README.md']);
    expect(teamPaths([{ role: 'frontend', paths: [] }])).toEqual([]);
  });

  it('describes who holds what', () => {
    expect(conflictDetail([
      { agent: 'codex', project: 'App', overlap: ['src/api', 'db/schema.sql'] },
      { agent: 'gemini', project: 'Docs', overlap: ['README.md'] },
    ])).toBe('codex (App): src/api, db/schema.sql\ngemini (Docs): README.md');
  });
});
