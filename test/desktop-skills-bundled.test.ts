import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverDesktopSkills, setBundledSkillsRoot } from '../apps/desktop/src/main/skills';
import { PERSONAS } from '../apps/desktop/src/renderer/src/components/personas';

const directories: string[] = [];
afterEach(async () => {
  setBundledSkillsRoot(undefined);
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function folder(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'kai-skills-'));
  directories.push(directory);
  return directory;
}

async function skill(root: string, name: string, description: string): Promise<void> {
  await mkdir(path.join(root, name), { recursive: true });
  await writeFile(path.join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`, 'utf8');
}

describe('bundled skills', () => {
  it('are found in a project that has no skills of its own', async () => {
    const bundled = await folder();
    const project = await folder();
    await skill(bundled, 'license-attribution-checker', 'Checks licences.');
    setBundledSkillsRoot(bundled);
    const names = (await discoverDesktopSkills(project)).map((item) => item.name);
    expect(names).toContain('license-attribution-checker');
  });

  it('lose to a project skill of the same name, which is listed once', async () => {
    const bundled = await folder();
    const project = await folder();
    await skill(bundled, 'refactorer', 'Bundled copy.');
    await skill(path.join(project, '.agents', 'skills'), 'refactorer', 'Project copy.');
    setBundledSkillsRoot(bundled);
    const matches = (await discoverDesktopSkills(project)).filter((item) => item.name === 'refactorer');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.description).toBe('Project copy.');
  });

  it('cover every skill a composer recipe names, from KAI\'s own folder', async () => {
    setBundledSkillsRoot(path.resolve('.agents/skills'));
    const found = new Set((await discoverDesktopSkills(await folder())).map((item) => item.name));
    const named = PERSONAS.flatMap((persona) => persona.recipes?.flatMap((recipe) => recipe.skills) ?? []);
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) expect(found.has(name), `not found: ${name}`).toBe(true);
  });
});
