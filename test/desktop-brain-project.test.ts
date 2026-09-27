import { describe, expect, it } from 'vitest';
import { brainProjectNote, resolveBrainProject } from '../apps/desktop/src/main/brain-project';

const known = [
  { name: 'KAi', path: null },
  { name: 'MoneyMattersApp', path: 'C:\\Users\\dev\\MoneyMattersApp' },
  { name: 'ClaudeCode-Proxy', path: null },
];

describe('brain project resolution', () => {
  it('prefers the folder name over a manifest title the brain has never seen', () => {
    // The bug this exists for: package.json said "KAI Agent Workbench" while every memory was filed under "KAi".
    const resolved = resolveBrainProject({
      projectPath: 'C:\\Users\\dev\\KAi',
      projectName: 'KAi',
      packageName: 'kai-agent-workbench',
      packageDisplayName: 'KAI Agent Workbench',
    }, known);
    expect(resolved).toEqual({ name: 'KAi', source: 'name', matched: true });
  });

  it('matches on the recorded path before any name, and returns the brain spelling', () => {
    const resolved = resolveBrainProject({
      projectPath: 'c:/users/dev/moneymattersapp/',
      projectName: 'Renamed Locally',
    }, known);
    expect(resolved).toEqual({ name: 'MoneyMattersApp', source: 'path', matched: true });
  });

  it('ignores case, dashes and spaces when comparing names', () => {
    const resolved = resolveBrainProject({
      projectPath: 'C:\\code\\claudecode proxy',
      projectName: 'claudecode proxy',
    }, known);
    expect(resolved).toEqual({ name: 'ClaudeCode-Proxy', source: 'name', matched: true });
  });

  it('honours an explicit override without consulting the brain', () => {
    const resolved = resolveBrainProject(
      { projectPath: 'C:\\code\\anything', projectName: 'Anything' },
      known,
      '  Zuriloft ',
    );
    expect(resolved).toEqual({ name: 'Zuriloft', source: 'override', matched: true });
  });

  it('reports a miss instead of inventing a match, falling back to the project name', () => {
    const resolved = resolveBrainProject({
      projectPath: 'C:\\code\\brand-new',
      projectName: 'brand-new',
    }, known);
    expect(resolved).toEqual({ name: 'brand-new', source: 'fallback', matched: false });
  });

  it('falls back to the folder name when the project has no name of its own', () => {
    const resolved = resolveBrainProject({ projectPath: 'C:\\code\\loose-folder', projectName: '   ' }, []);
    expect(resolved).toEqual({ name: 'loose-folder', source: 'fallback', matched: false });
  });

  it('explains an empty recall differently when the project is simply unknown', () => {
    const missing = resolveBrainProject({ projectPath: 'C:\\code\\new', projectName: 'new' }, known);
    const found = resolveBrainProject({ projectPath: 'C:\\code\\KAi', projectName: 'KAi' }, known);
    expect(brainProjectNote(missing, 0)).toContain('nothing filed under "new"');
    expect(brainProjectNote(found, 0)).toContain('No memories matched');
    expect(brainProjectNote(found, 1)).toBe('1 memory recalled from "KAi".');
    expect(brainProjectNote(found, 4)).toBe('4 memories recalled from "KAi".');
  });
});
