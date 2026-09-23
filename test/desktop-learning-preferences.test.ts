import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeFileSystem } from '../packages/runtime/src';
import { LearningProgressStore } from '../apps/desktop/src/main/learning-progress';

const directories: string[] = [];

async function store(existing?: string): Promise<{ dir: string; store: LearningProgressStore }> {
  const dir = existing ?? await fs.mkdtemp(path.join(os.tmpdir(), 'kai-learning-'));
  if (!existing) directories.push(dir);
  return { dir, store: new LearningProgressStore(dir, new NodeFileSystem()) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })));
});

describe('learning mode preference', () => {
  it('starts as Guided with inline suggestions off', async () => {
    const { store: learning } = await store();
    expect((await learning.get('p1')).preferences).toEqual({ assistance: 'guided', inlineSuggestions: false });
  });

  it('follows the user to every project instead of resetting per project', async () => {
    const { store: learning } = await store();
    await learning.updatePreferences({ projectId: 'p1', assistance: 'copilot', inlineSuggestions: true });
    expect((await learning.get('p2')).preferences).toEqual({ assistance: 'copilot', inlineSuggestions: true });
    expect((await learning.get('p1')).preferences).toEqual({ assistance: 'copilot', inlineSuggestions: true });
  });

  it('survives a restart', async () => {
    const first = await store();
    await first.store.updatePreferences({ projectId: 'p1', assistance: 'learn', inlineSuggestions: false });
    const second = await store(first.dir);
    expect((await second.store.get('p1')).preferences.assistance).toBe('learn');
    expect((await second.store.get('brand-new-project')).preferences.assistance).toBe('learn');
  });

  it('changes cleanly from one mode to another, and switching away from Copilot turns inline suggestions off', async () => {
    const { store: learning } = await store();
    await learning.updatePreferences({ projectId: 'p1', assistance: 'copilot', inlineSuggestions: true });
    await learning.updatePreferences({ projectId: 'p1', assistance: 'pair', inlineSuggestions: false });
    expect((await learning.get('p2')).preferences).toEqual({ assistance: 'pair', inlineSuggestions: false });
  });

  it('keeps what a project had saved before preferences were shared, until one is chosen', async () => {
    const { dir } = await store();
    await fs.writeFile(path.join(dir, 'legacy.json'), JSON.stringify({
      schemaVersion: 1, projectId: 'legacy', preferences: { assistance: 'pair', inlineSuggestions: false },
      concepts: [], recentEvidence: [], updatedAt: '2026-09-20T10:00:00.000Z',
    }));
    const { store: learning } = await store(dir);
    expect((await learning.get('legacy')).preferences.assistance).toBe('pair');
    await learning.updatePreferences({ projectId: 'other', assistance: 'learn', inlineSuggestions: false });
    expect((await learning.get('legacy')).preferences.assistance).toBe('learn');
  });

  it('ignores an unreadable preferences file and still returns the project', async () => {
    const { dir, store: learning } = await store();
    await fs.writeFile(path.join(dir, '.preferences.json'), '{not json');
    expect((await learning.get('p1')).preferences).toEqual({ assistance: 'guided', inlineSuggestions: false });
  });
});
