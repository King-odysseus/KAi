import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { AgentRunRequest, PersistedEvent } from '@kai/contracts';
import { configureProjectKnowledge, startWatchingProject, stopProjectKnowledge } from '../apps/desktop/src/main/project-knowledge';
import { followRunFiles } from '../apps/desktop/src/main/run-file-follow';

afterEach(async () => { await stopProjectKnowledge(); });
it('follows actual shell-made disk changes, deduplicates them and unsubscribes at completion', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'kai-file-follow-'));
  const project = path.join(profile, 'project'); await mkdir(project);
  configureProjectKnowledge(path.join(profile, 'knowledge'));
  await startWatchingProject(project);
  const events: PersistedEvent[] = [];
  const request = { conversationId: 'builder-a', agent: 'codex' } as AgentRunRequest;
  const observer = await followRunFiles(project, request, (event) => events.push(event));
  await writeFile(path.join(project, 'first.ts'), 'export const first = 1;\n');
  await expect.poll(() => events.some((event) => event.type === 'file.edit.applied' && event.filePath === 'first.ts')).toBe(true);
  await writeFile(path.join(project, 'first.ts'), 'export const first = 1;\n');
  await writeFile(path.join(project, 'second.ts'), 'export const second = 2;\n');
  await expect.poll(() => events.some((event) => event.type === 'file.edit.applied' && event.filePath === 'second.ts')).toBe(true);
  const saved = await observer.stop();
  expect(saved).toEqual(events);
  expect(events.filter((event) => event.type === 'file.edit.applied' && event.filePath === 'first.ts')).toHaveLength(1);
  await writeFile(path.join(project, 'after.ts'), 'must not follow after completion');
  await observer.stop();
  expect(events.some((event) => event.type === 'file.edit.applied' && event.filePath === 'after.ts')).toBe(false);
}, 15_000);
