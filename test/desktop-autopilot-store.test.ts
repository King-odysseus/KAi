import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AutopilotRunStore } from '../apps/desktop/src/main/autopilot-store';

describe('AutopilotRunStore audit history', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('keeps audit entries after the live recovery record is removed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kai-autopilot-'));
    roots.push(root);
    const store = new AutopilotRunStore(root);
    await store.audit({ id: 'audit-1', projectId: 'project-1', at: '2026-10-16T00:00:00.000Z', kind: 'warn', text: 'Card blocked; continue with independent work.', cardId: 'card-1' });
    await store.end('project-1');

    const history = await readFile(path.join(root, 'history', 'project-1.jsonl'), 'utf8');
    expect(JSON.parse(history.trim())).toMatchObject({ id: 'audit-1', projectId: 'project-1', kind: 'warn', cardId: 'card-1' });
  });
});
