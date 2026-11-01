import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProfile, conventionNote, detect, projectFoldersIn, scanChildren } from '../src/cognitive1/conventions';
import type { ProjectSnapshot } from '../src/cognitive1/conventions';

const AT = '2026-11-01T10:00:00.000Z';

function project(name: string, patch: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return { name, files: [], dependencies: [], manifestText: '', sourceText: '', ...patch };
}

async function withParent<T>(layout: Record<string, Record<string, string>>, run: (parent: string) => Promise<T>): Promise<T> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-ext-conv-'));
  try {
    for (const [name, files] of Object.entries(layout)) {
      for (const [file, text] of Object.entries(files)) {
        await fs.mkdir(path.dirname(path.join(parent, name, file)), { recursive: true });
        await fs.writeFile(path.join(parent, name, file), text);
      }
    }
    return await run(parent);
  } finally {
    await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

describe('extension conventions', () => {
  it('reads the stack from dependencies, manifests and file names', () => {
    expect(detect(project('a', { dependencies: ['react', 'tailwindcss'] }))).toEqual(['react', 'tailwind']);
    expect(detect(project('b', { files: ['manage.py'], manifestText: 'django' }))).toContain('django');
    expect(detect(project('empty'))).toEqual([]);
  });

  it('keeps a habit only when two or more projects show it', () => {
    const profile = buildProfile([
      project('a', { dependencies: ['react', 'stripe'] }),
      project('b', { dependencies: ['react'] }),
    ], AT);
    expect(profile.conventions.map((item) => item.key)).toEqual(['react']);
  });

  it('treats each folder under a parent as a project, skipping hidden and tooling folders', async () => {
    const layout = {
      alpha: { 'package.json': '{}' },
      beta: { 'package.json': '{}' },
      '.hidden': { 'x.txt': '1' },
      node_modules: { 'y.txt': '1' },
    };
    await withParent(layout, async (parent) => {
      const folders = (await projectFoldersIn(parent)).map((folder) => path.basename(folder)).sort();
      expect(folders).toEqual(['alpha', 'beta']);
      expect(await projectFoldersIn(path.join(parent, 'missing'))).toEqual([]);
    });
  });

  it('finds a new habit when the scan is run again after a new project uses it', async () => {
    const pkg = (deps: Record<string, string>): string => JSON.stringify({ dependencies: deps });
    await withParent({ one: { 'package.json': pkg({ react: '1' }) }, two: { 'package.json': pkg({ react: '1' }) } }, async (parent) => {
      const before = await scanChildren(parent, AT);
      expect(before.conventions.map((item) => item.key)).toEqual(['react']);
      // Two new projects start using Vue: a habit needs more than one project, so one alone changes nothing.
      await fs.mkdir(path.join(parent, 'three'), { recursive: true });
      await fs.writeFile(path.join(parent, 'three', 'package.json'), pkg({ vue: '1' }));
      expect((await scanChildren(parent, AT)).conventions.map((item) => item.key)).toEqual(['react']);
      await fs.mkdir(path.join(parent, 'four'), { recursive: true });
      await fs.writeFile(path.join(parent, 'four', 'package.json'), pkg({ vue: '1' }));
      const after = await scanChildren(parent, AT);
      expect(after.total).toBe(4);
      expect(after.conventions.map((item) => item.key)).toContain('vue');
    });
  });

  it('writes a short note full of the words a task would use, marked for review', () => {
    const profile = buildProfile([
      project('a', { dependencies: ['tailwindcss'] }),
      project('b', { dependencies: ['tailwindcss'] }),
    ], AT);
    const note = conventionNote(profile.conventions[0]!, AT);
    expect(note.title).toBe('Convention: Tailwind CSS for styling');
    expect(note.description).toContain('2 of 2 projects');
    expect(note.description).toContain('Follow it in new work');
    expect(note.tags).toEqual(expect.arrayContaining(['convention', 'styling', 'tailwind', 'needs-review']));
  });
});
