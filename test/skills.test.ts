import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { buildSkillPrompt, discoverSkills, skillCatalog } from '../src/core/skills';

describe('skill discovery', () => {
  let projectDir: string | undefined;

  afterEach(async () => {
    if (projectDir) await fs.rm(projectDir, { recursive: true, force: true });
    projectDir = undefined;
  });

  it('discovers repo skills and parses their metadata', async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-skills-'));
    const skillDir = path.join(projectDir, '.agents', 'skills', 'reviewer');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), [
      '---',
      'name: reviewer',
      'description: Review changes for bugs and regressions.',
      '---',
      '',
      '# Reviewer',
      '',
      'Inspect the diff before reporting a finding.',
    ].join('\n'), 'utf8');

    const definitions = await discoverSkills(projectDir);
    const found = definitions.find((skill) => skill.name === 'reviewer');
    expect(found).toBeDefined();
    expect(found?.scope).toBe('repo');
    expect(found?.description).toContain('bugs and regressions');
    const summary = skillCatalog(definitions).find((skill) => skill.name === 'reviewer');
    expect(summary && 'instructions' in summary).toBe(false);
  });

  it('builds the full skill instructions into the agent prompt', () => {
    const prompt = buildSkillPrompt([{
      name: 'reviewer',
      description: 'Review changes',
      path: '/repo/.agents/skills/reviewer/SKILL.md',
      root: '/repo/.agents/skills',
      scope: 'repo',
      instructions: 'Follow the review checklist.',
    }], 'Review this patch');

    expect(prompt).toContain('[SELECTED SKILLS]');
    expect(prompt).toContain('### $reviewer');
    expect(prompt).toContain('Follow the review checklist.');
    expect(prompt).toContain('[USER REQUEST]\nReview this patch');
  });
});
