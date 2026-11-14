import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type { SkillSummary } from '@kai/contracts';
import { redactText } from '@kai/runtime';

export interface DesktopSkill extends SkillSummary {
  instructions: string;
}

interface SkillRoot {
  path: string;
  scope: 'repo' | 'user';
}

/**
 * The skills that ship with KAI. They live in KAI's own repository, so without this a project opened from anywhere
 * else would find none of them and the composer's roles and recipes would load nothing.
 */
let bundledSkillsRoot: string | undefined;

export function setBundledSkillsRoot(root: string | undefined): void {
  bundledSkillsRoot = root;
}

export async function discoverDesktopSkills(projectPath?: string): Promise<DesktopSkill[]> {
  const found: DesktopSkill[] = [];
  const seen = new Set<string>();
  const seenNames = new Set<string>();
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
      // The nearest copy of a skill wins; a farther or bundled one of the same name would only repeat it.
      if (!skill || seenNames.has(skill.name.toLowerCase())) continue;
      seen.add(key);
      seenNames.add(skill.name.toLowerCase());
      found.push(skill);
    }
  }
  return found.sort((left, right) => left.name.localeCompare(right.name));
}

export function skillSummaries(skills: readonly DesktopSkill[]): SkillSummary[] {
  return skills.map(({ instructions: _instructions, ...summary }) => summary);
}

/** Read portable text files from selected skills; hidden folders and binary assets are excluded deliberately. */
export async function readCapabilityBundleSkills(projectPath: string, names: readonly string[]): Promise<Array<{ name: string; files: Array<{ path: string; content: string }> }>> {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const available = await discoverDesktopSkills(projectPath);
  const selected = available.filter((skill) => wanted.has(skill.name.toLowerCase()));
  if (selected.length !== wanted.size) throw new Error('One or more selected skills could not be found for this project.');
  let totalBytes = 0;
  let fileCount = 0;
  const result: Array<{ name: string; files: Array<{ path: string; content: string }> }> = [];
  for (const skill of selected) {
    const base = path.dirname(skill.path);
    const files: Array<{ path: string; content: string }> = [];
    const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) { await visit(absolute, relative); continue; }
        if (!entry.isFile()) continue;
        const bytes = await fs.readFile(absolute);
        const content = bytes.toString('utf8');
        // Binary assets do not round-trip through a text skill bundle. Fail instead of silently producing a broken skill.
        if (content.includes('\u0000') || !Buffer.from(content, 'utf8').equals(bytes)) {
          throw new Error(`Skill "${skill.name}" contains a binary resource (${relative}) and cannot be bundled yet.`);
        }
        if (bytes.length > 256_000 || (totalBytes += bytes.length) > 2_000_000 || ++fileCount > 500 || files.length >= 100) {
          throw new Error('The selected skills exceed the portable bundle size limit (2 MB, 500 files total, 100 per skill, or 256 KB per file).');
        }
        const portablePath = relative.replace(/\\/g, '/');
        files.push({ path: portablePath.toLowerCase() === 'skill.md' ? 'SKILL.md' : portablePath, content: redactPortableText(content) });
      }
    };
    await visit(base, '');
    if (!files.some((file) => file.path.toLowerCase() === 'skill.md')) throw new Error(`Skill "${skill.name}" has no SKILL.md file.`);
    result.push({ name: skill.name, files });
  }
  return result;
}

function redactPortableText(value: string): string {
  return redactText(value)
    .replace(/(--(?:api[-_]?key|token|secret|password)\s+)(?:"[^"]+"|'[^']+'|[^\s]+)/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/[^:/\s]+:)[^@/\s]+@/gi, '$1[REDACTED]@');
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
  // Codex keeps its bundled skills (imagegen, skill-creator, ...) one level down, in `.system`.
  const relativeRoots = ['.agents/skills', '.codex/skills', '.codex/skills/.system', '.claude/skills', '.kai/skills'];
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
  // Last, so a project's or the person's own skill of the same name still wins (the first one found is kept).
  if (bundledSkillsRoot) roots.push({ path: bundledSkillsRoot, scope: 'user' });
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
