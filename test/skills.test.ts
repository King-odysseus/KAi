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

  // Most real skills tell the agent to run scripts/x.py or read references/y.md. Those files ship next to SKILL.md,
  // so the prompt has to say where that folder is or every relative path in the skill is a dead end.
  it('names the skill folder so bundled scripts and references resolve', () => {
    const skillPath = path.join('/repo', '.agents', 'skills', 'xlsx', 'SKILL.md');
    const prompt = buildSkillPrompt([{
      name: 'xlsx',
      description: 'Edit spreadsheets',
      path: skillPath,
      root: path.join('/repo', '.agents', 'skills'),
      scope: 'repo',
      instructions: 'Recalculate with scripts/recalc.py.',
    }], 'Fix the totals');

    expect(prompt).toContain(`Skill folder: ${path.dirname(skillPath)}`);
    expect(prompt).toContain('Resolve any relative path in this skill against that folder.');
    // The folder has to come before the instructions, or the agent reads "scripts/recalc.py" with nowhere to put it.
    expect(prompt.indexOf('Skill folder:')).toBeLessThan(prompt.indexOf('scripts/recalc.py'));
  });
});
