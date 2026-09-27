import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type { SkillSummary } from '@kai/contracts';

export interface DesktopSkill extends SkillSummary {
  instructions: string;
}

interface SkillRoot {
  path: string;
  scope: 'repo' | 'user';
}

export async function discoverDesktopSkills(projectPath?: string): Promise<DesktopSkill[]> {
  const found: DesktopSkill[] = [];
  const seen = new Set<string>();
  for (const root of skillRoots(projectPath)) {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(root.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillPath = path.join(root.path, entry.name, 'SKILL.md');
      const key = path.resolve(skillPath).toLowerCase();
      if (seen.has(key)) continue;
      const skill = await readSkill(skillPath, root);
      if (!skill) continue;
      seen.add(key);
      found.push(skill);
    }
  }
  return found.sort((left, right) => left.name.localeCompare(right.name));
}

export function skillSummaries(skills: readonly DesktopSkill[]): SkillSummary[] {
  return skills.map(({ instructions: _instructions, ...summary }) => summary);
}

export function buildSkillPrompt(skills: readonly DesktopSkill[], prompt: string): string {
  if (skills.length === 0) return prompt;
  // Skills routinely reference bundled files by relative path ("run scripts/recalc.py", "read references/api.md").
  // Those files sit next to SKILL.md on disk, but the instructions arrive here as plain text with no indication of
  // where they came from, so the agent cannot resolve them. Naming the folder is what makes those references work.
  const blocks = skills.map((skill) => [
    `### $${skill.name}`,
    'Follow the instructions in this skill for the current task.',
    `Skill folder: ${path.dirname(skill.path)}`,
    'Resolve any relative path in this skill against that folder.',
    skill.instructions,
  ].join('\n'));
  return `[SELECTED SKILLS]\n${blocks.join('\n\n')}\n\n[USER REQUEST]\n${prompt}`;
}

function skillRoots(projectPath?: string): SkillRoot[] {
  const roots: SkillRoot[] = [];
  const relativeRoots = ['.agents/skills', '.codex/skills', '.claude/skills', '.kai/skills'];
  if (projectPath) {
    let current = path.resolve(projectPath);
    const visited = new Set<string>();
    while (!visited.has(current)) {
      visited.add(current);
      for (const relative of relativeRoots) roots.push({ path: path.join(current, relative), scope: 'repo' });
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  for (const relative of relativeRoots) roots.push({ path: path.join(homedir(), relative), scope: 'user' });
  return roots.filter((root, index) => roots.findIndex((candidate) => candidate.path === root.path) === index);
}

async function readSkill(skillPath: string, root: SkillRoot): Promise<DesktopSkill | undefined> {
  try {
    const raw = await fs.readFile(skillPath, 'utf8');
    const frontmatter = parseFrontmatter(raw);
    const folderName = path.basename(path.dirname(skillPath));
    const name = (frontmatter.name || folderName).trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) return undefined;
    return {
      name,
      description: (frontmatter.description || fallbackDescription(raw)).trim(),
      path: skillPath,
      root: root.path,
      scope: root.scope,
      instructions: raw.trim(),
    };
  } catch {
    return undefined;
  }
}

function parseFrontmatter(raw: string): { name?: string; description?: string } {
  if (!raw.startsWith('---')) return {};
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return {};
  const values: Record<string, string> = {};
  let activeKey: string | undefined;
  let blockMode = false;
  for (const line of raw.slice(3, end).split(/\r?\n/)) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (match) {
      activeKey = match[1];
      blockMode = match[2] === '>' || match[2] === '|';
      values[activeKey] = blockMode ? '' : unquote(match[2]);
      continue;
    }
    if (activeKey && blockMode && /^\s+/.test(line)) {
      values[activeKey] = `${values[activeKey]}${values[activeKey] ? ' ' : ''}${line.trim()}`;
    }
  }
  return { name: values.name, description: values.description };
}

function fallbackDescription(raw: string): string {
  const body = raw.replace(/^---[\s\S]*?\n---\s*/, '');
  const paragraph = body
    .split(/\r?\n\s*\r?\n/)
    .map((part) => part.replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim())
    .find(Boolean);
  return paragraph?.slice(0, 180) ?? 'No description provided.';
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).replace(/\\n/g, '\n');
  }
  return trimmed;
}
