import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export type SkillScope = 'repo' | 'user';

export interface SkillSummary {
  name: string;
  description: string;
  path: string;
  root: string;
  scope: SkillScope;
}

export interface SkillDefinition extends SkillSummary {
  instructions: string;
}

interface SkillRoot {
  path: string;
  scope: SkillScope;
}

function skillRoots(projectPath?: string): SkillRoot[] {
  const roots: SkillRoot[] = [];
  if (projectPath) {
    let current = path.resolve(projectPath);
    const visited = new Set<string>();
    while (!visited.has(current)) {
      visited.add(current);
      roots.push({ path: path.join(current, '.agents', 'skills'), scope: 'repo' });
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  roots.push({ path: path.join(os.homedir(), '.agents', 'skills'), scope: 'user' });
  return roots.filter((root, index) => roots.findIndex((candidate) => candidate.path === root.path) === index);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).replace(/\\n/g, '\n');
  }
  return trimmed;
}

function parseFrontmatter(raw: string): { name?: string; description?: string } {
  if (!raw.startsWith('---')) return {};
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return {};
  const lines = raw.slice(3, end).split(/\r?\n/);
  const values: Record<string, string> = {};
  let activeKey: string | undefined;
  let blockMode = false;

  for (const line of lines) {
    const keyMatch = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (keyMatch) {
      activeKey = keyMatch[1];
      const value = keyMatch[2];
      blockMode = value === '>' || value === '|';
      values[activeKey] = blockMode ? '' : unquote(value);
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

async function readSkill(skillPath: string, root: SkillRoot): Promise<SkillDefinition | undefined> {
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

/** Discovers one-level skill folders from repo ancestors and the user scope. */
export async function discoverSkills(projectPath?: string): Promise<SkillDefinition[]> {
  const found: SkillDefinition[] = [];
  const seen = new Set<string>();
  for (const root of skillRoots(projectPath)) {
    let entries: import('fs').Dirent[];
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
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

export function skillCatalog(definitions: SkillDefinition[]): SkillSummary[] {
  return definitions.map(({ instructions: _instructions, ...summary }) => summary);
}

export function buildSkillPrompt(skills: SkillDefinition[], userPrompt: string): string {
  if (skills.length === 0) return userPrompt;
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
  return `[SELECTED SKILLS]\n${blocks.join('\n\n')}\n\n[USER REQUEST]\n${userPrompt}`;
}
