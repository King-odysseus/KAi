import { describe, expect, it } from 'vitest';
import { githubRepositoryRefSchema } from '../packages/contracts/src/git';
import { parseTeamInvite, shareableCodePath, shareableRepository } from '../apps/desktop/src/renderer/src/components/studio-team-share';

describe('connected Project Studio sharing boundary', () => {
  it('accepts only a complete random room invitation', () => {
    const code = `kai-team:${'a'.repeat(32)}:${'b'.repeat(32)}`;
    expect(parseTeamInvite(code)).toEqual({ roomId: 'a'.repeat(32), password: 'b'.repeat(32) });
    expect(parseTeamInvite('kai-team:short:secret')).toBeNull();
  });

  it('keeps credentials and private project data out of the shared code list', () => {
    expect(shareableCodePath('src/components/App.tsx')).toBe(true);
    for (const path of ['.env', '.env.production', '.kai/spec/brief.md', 'src/private-key.pem', '../other/file.ts', 'node_modules/a.js', 'keys/credentials.json']) {
      expect(shareableCodePath(path)).toBe(false);
    }
  });

  it('rejects credential-bearing and traversal repository names', () => {
    expect(shareableRepository('owner/repo')).toBe('owner/repo');
    expect(shareableRepository('https://user:token@github.com/owner/repo')).toBeNull();
    expect(githubRepositoryRefSchema.safeParse('owner/..').success).toBe(false);
    expect(githubRepositoryRefSchema.safeParse('owner/repo').success).toBe(true);
  });
});
