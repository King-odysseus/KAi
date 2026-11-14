import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { MAX_CUSTOM_ROLES, customRoleSchema, type AgentTeam } from '@kai/contracts';

/**
 * Team roles written as files: `.kai/agents/<name>.md` in a project, with a short header and the role's guidance as
 * the body. They sit beside the roles made in Settings, so a project can ship a "database migrator" without anyone
 * touching KAI's code.
 *
 *   ---
 *   name: Database migrator
 *   description: Writes and checks schema migrations.
 *   access: edit
 *   ---
 *   Always write a down migration. Never drop a column in the same release that stops using it.
 *
 * A project's files are not the user's own settings, so a file role is held to the safe side: it reads unless it
 * says `access: edit`, it always lets KAI choose the agent and route, and the plan card still shows every part
 * for approval before anything runs.
 */
const MAX_FILE_BYTES = 20_000;
const MAX_FILES = 24;

export type FileAgentRole = AgentTeam['custom'][number];

/** `Database migrator` or `database_migrator.md` -> `custom-database-migrator`. Undefined when nothing usable is left. */
export function roleIdFor(name: string): string | undefined {
  const slug = name.toLowerCase().replace(/\.md$/i, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/g, '');
  return slug ? `custom-${slug}` : undefined;
}

function headerValue(header: string, key: string): string | undefined {
  const match = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'im').exec(header);
  const value = match?.[1]?.trim().replace(/^["']|["']$/g, '');
  return value || undefined;
}

/** Reads one agent file. Returns undefined for a file that is not usable, so a bad file never blocks the others. */
export function parseAgentFile(fileName: string, text: string): FileAgentRole | undefined {
  const normalized = text.replace(/\r\n/g, '\n').replace(/^﻿/, '');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  const header = match ? match[1] : '';
  const body = (match ? match[2] : normalized).trim();
  const label = headerValue(header, 'name') ?? fileName.replace(/\.md$/i, '').replace(/[-_]+/g, ' ');
  const id = roleIdFor(headerValue(header, 'name') ?? fileName);
  if (!id || !body) return undefined;
  const access = headerValue(header, 'access')?.toLowerCase() === 'edit' ? 'edit' : 'read';
  const parsed = customRoleSchema.safeParse({
    id,
    label: label.slice(0, 60),
    description: (headerValue(header, 'description') ?? '').slice(0, 300),
    access,
    assignee: 'auto',
    route: 'auto',
    instructions: body.slice(0, 2_000),
  });
  return parsed.success ? parsed.data : undefined;
}

/** The roles a project's `.kai/agents` folder defines. A missing folder is not an error, just no roles. */
export async function loadFileAgents(projectPath: string): Promise<FileAgentRole[]> {
  const directory = path.join(projectPath, '.kai', 'agents');
  let names: string[];
  try {
    names = (await fs.readdir(directory)).filter((name) => /\.md$/i.test(name)).sort().slice(0, MAX_FILES);
  } catch {
    return [];
  }
  const roles: FileAgentRole[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    try {
      const file = path.join(directory, name);
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      const role = parseAgentFile(name, await fs.readFile(file, 'utf8'));
      if (!role || seen.has(role.id)) continue;
      seen.add(role.id);
      roles.push(role);
    } catch {
      // An unreadable file is skipped; the rest still load.
    }
  }
  return roles;
}

/** The team with the file roles added after the ones made in Settings. A role made in Settings wins on the same id. */
export function withFileAgents<T extends Pick<AgentTeam, 'custom'>>(team: T, fileRoles: readonly FileAgentRole[]): T {
  if (fileRoles.length === 0) return team;
  const taken = new Set(team.custom.map((role) => role.id));
  const added = fileRoles.filter((role) => !taken.has(role.id));
  const custom = [...team.custom, ...added].slice(0, MAX_CUSTOM_ROLES);
  return { ...team, custom };
}
