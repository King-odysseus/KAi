import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeFileSystem } from '../packages/runtime/src';
import { ProjectStore, pathKey } from '../apps/desktop/src/main/project-store';

const NOW = '2026-10-02T12:00:00.000Z';
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function rm(directory: string): Promise<void> {
  await fs.rm(directory, { recursive: true, force: true });
}

async function store(): Promise<ProjectStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-projects-'));
  directories.push(directory);
  return new ProjectStore(path.join(directory, 'projects.json'), new NodeFileSystem());
}

function record(id: string, name: string, projectPath: string) {
  return { schemaVersion: 1 as const, id, name, path: projectPath, createdAt: NOW, lastOpenedAt: NOW };
}

/**
 * What makes two projects the same one. Getting this wrong is not cosmetic: opening a folder again minted a second
 * entry for it, so the same folder appeared three times, and anything keyed to a project id — preferences, a Studio
 * plan's link — pointed at whichever entry was not the one in front of the person.
 */
describe('recognising a project you already have', () => {
  it('keeps one entry per folder, however many times it is opened', async () => {
    const projects = await store();
    await projects.upsert(record('project_first', 'ZuriIAI', 'C:\\work\\ZuriIAI'));
    await projects.upsert(record('project_second', 'ZuriIAI', 'C:\\work\\ZuriIAI'));
    await projects.upsert(record('project_third', 'ZuriIAI', 'C:\\work\\ZuriIAI'));

    const listed = await projects.list();
    expect(listed).toHaveLength(1);
    // The first id survives: conversations, preferences and Studio links are keyed to it, and a new id would orphan
    // every one of them.
    expect(listed[0]?.id).toBe('project_first');
  });

  it('normalises a path for comparison', () => {
    // Answered directly, because the equality below depends on it and a silent miss here looks like a store bug.
    expect(pathKey('C:\\work\\ZuriIAI')).toBe(pathKey('c:/work/zuriiai/'));
  });

  it('treats the same folder in different case or slashes as one, which is what Windows does', async () => {
    const projects = await store();
    await projects.upsert(record('project_first', 'ZuriIAI', 'C:\\work\\ZuriIAI'));
    // The same folder, written the other way round: lower case, forward slashes, a trailing one.
    await projects.upsert(record('project_again', 'zuriiai', 'c:/work/zuriiai/'));

    expect(await projects.list()).toHaveLength(1);
  });

  it('still adds a different folder as its own project', async () => {
    const projects = await store();
    await projects.upsert(record('project_one', 'One', 'C:\\work\\One'));
    await projects.upsert(record('project_two', 'Two', 'C:\\work\\Two'));

    const listed = await projects.list();
    expect(listed).toHaveLength(2);
    expect(listed.map((project) => project.id).sort()).toEqual(['project_one', 'project_two']);
  });

  it('updates the record it already has, so a rename or a reopen is not a second project', async () => {
    const projects = await store();
    await projects.upsert(record('project_one', 'One', 'C:\\work\\One'));
    await projects.upsert({ ...record('project_one', 'One renamed', 'C:\\work\\One'), lastOpenedAt: '2026-10-03T09:00:00.000Z' });

    const listed = await projects.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: 'project_one', name: 'One renamed' });
  });
});
