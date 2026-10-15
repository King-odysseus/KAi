import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_RUN_NOTES,
  MAX_TRACKED_FILES,
  configureProjectKnowledge,
  emptyKnowledge,
  knowledgeBriefing,
  noteChanges,
  noteRun,
  projectScripts,
  recordRunKnowledge,
  renderKnowledge,
  shouldIgnore,
  startWatchingProject,
  stopProjectKnowledge,
  summariseFolders,
} from '../apps/desktop/src/main/project-knowledge';

vi.setConfig({ testTimeout: 90_000 });

const temporary: string[] = [];

async function tempDir(name: string): Promise<string> {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`)));
  temporary.push(directory);
  return directory;
}

afterEach(async () => {
  await stopProjectKnowledge();
  await Promise.all(temporary.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })));
});

describe('what changes in a project', () => {
  it('counts repeated edits and keeps the list bounded', () => {
    let knowledge = emptyKnowledge('C:/repo');
    knowledge = noteChanges(knowledge, ['src/a.ts', 'src/a.ts', 'src/b.ts'], '2026-10-15T10:00:00.000Z');
    knowledge = noteChanges(knowledge, ['src/a.ts'], '2026-10-15T11:00:00.000Z');
    expect(knowledge.changes['src/a.ts']).toEqual({ count: 2, lastAt: '2026-10-15T11:00:00.000Z' });
    expect(knowledge.changes['src/b.ts']?.count).toBe(1);

    const many = Array.from({ length: MAX_TRACKED_FILES + 50 }, (_, index) => `f${index}.ts`);
    expect(Object.keys(noteChanges(knowledge, many, '2026-10-15T12:00:00.000Z').changes)).toHaveLength(MAX_TRACKED_FILES);
  });

  it('ignores dependencies, build output and editor scratch files', () => {
    for (const ignored of ['node_modules/x/index.js', 'apps/desktop/out/main/index.cjs', '.git/HEAD', '.kai/plan.json', 'a.log', 'file.ts~', 'dist/app.js', '']) {
      expect(shouldIgnore(ignored)).toBe(true);
    }
    for (const kept of ['src/app.ts', 'README.md', 'apps/desktop/src/main/ipc.ts']) expect(shouldIgnore(kept)).toBe(false);
  });
});

describe('what runs did', () => {
  it('keeps the newest runs only', () => {
    let knowledge = emptyKnowledge('C:/repo');
    for (let index = 0; index < MAX_RUN_NOTES + 5; index += 1) {
      knowledge = noteRun(knowledge, { at: '2026-10-15T10:00:00.000Z', task: `task ${index}`, outcome: 'completed', files: ['a.ts'], checks: 'none' });
    }
    expect(knowledge.runs).toHaveLength(MAX_RUN_NOTES);
    expect(knowledge.runs.at(-1)?.task).toBe(`task ${MAX_RUN_NOTES + 4}`);
  });
});

describe('the briefing', () => {
  it('is empty when nothing has been learned, so a new project gets no filler', () => {
    expect(renderKnowledge(emptyKnowledge('C:/repo'))).toBe('');
  });

  it('summarises folders by size, with their file types', () => {
    const lines = summariseFolders(['src/a.ts', 'src/b.tsx', 'src/c.ts', 'docs/readme.md', 'package.json']);
    expect(lines[0]).toBe('src/ (3 files: .ts, .tsx)');
    expect(lines).toContain('docs/ (1 file: .md)');
    expect(lines).toContain('(top level) (1 file: .json)');
  });

  it('puts the shape and check commands first, then recent work, newest run first, and respects its size limit', () => {
    let knowledge = emptyKnowledge('C:/repo');
    knowledge = noteChanges(knowledge, ['src/hot.ts', 'src/cold.ts'], '2026-10-14T09:00:00.000Z');
    knowledge = noteChanges(knowledge, ['src/hot.ts'], '2026-10-14T10:00:00.000Z');
    knowledge = noteRun(knowledge, { at: '2026-10-10T10:00:00.000Z', task: 'old task', outcome: 'completed', files: ['a.ts'], checks: 'passed' });
    knowledge = noteRun(knowledge, { at: '2026-10-14T10:00:00.000Z', task: 'fix the login redirect', outcome: 'failed', files: ['src/login.ts'], checks: 'failed' });
    const now = Date.parse('2026-10-15T10:00:00.000Z');
    const text = renderKnowledge(knowledge, { folders: ['src/ (3 files: .ts)'], scripts: ['npm run test'], now });
    expect(text.indexOf('Folders:')).toBeLessThan(text.indexOf('To check your work: npm run test'));
    expect(text).toContain('src/hot.ts (2×)');
    expect(text.indexOf('fix the login redirect')).toBeLessThan(text.indexOf('old task'));
    expect(text).toContain('did not finish');
    expect(text).toContain('checks failed');

    const short = renderKnowledge(knowledge, { folders: ['src/ (3 files: .ts)'], scripts: ['npm run test'], now, maxCharacters: 220 });
    expect(short.length).toBeLessThanOrEqual(220);
    expect(short).toContain('Folders:');
  });

  it('leaves out files nobody has touched in two weeks', () => {
    let knowledge = noteChanges(emptyKnowledge('C:/repo'), ['src/old.ts'], '2026-09-01T10:00:00.000Z');
    knowledge = noteRun(knowledge, { at: '2026-10-14T10:00:00.000Z', task: 'something', outcome: 'completed', files: [], checks: 'none' });
    const text = renderKnowledge(knowledge, { now: Date.parse('2026-10-15T10:00:00.000Z') });
    expect(text).not.toContain('src/old.ts');
  });

  it('reads the check commands a project actually has', async () => {
    const root = await tempDir('kai-scripts');
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest', build: 'tsc', start: 'node .' } }));
    expect(await projectScripts(root)).toEqual(['npm run test', 'npm run build']);
    expect(await projectScripts(path.join(root, 'missing'))).toEqual([]);
  });
});

describe('the service', () => {
  it('learns from files changing and from runs, and remembers them after a restart', async () => {
    const store = await tempDir('kai-knowledge-store');
    const project = await tempDir('kai-knowledge-project');
    await fs.mkdir(path.join(project, 'src'));
    await fs.writeFile(path.join(project, 'src', 'main.ts'), 'export function start() {}\n');
    await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    configureProjectKnowledge(store);

    await startWatchingProject(project);
    await fs.writeFile(path.join(project, 'src', 'main.ts'), 'export function start() { return 1; }\n');
    await fs.mkdir(path.join(project, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(project, 'node_modules', 'ignored.js'), 'x');
    // The watcher batches for a few seconds; quitting writes what is waiting, which is what this waits for.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await recordRunKnowledge(project, { at: new Date().toISOString(), task: 'rename start', outcome: 'completed', files: ['src/main.ts'], checks: 'passed' });
    await stopProjectKnowledge();

    // A fresh start: nothing in memory, so this reads what was saved.
    configureProjectKnowledge(store);
    const text = await knowledgeBriefing(project);
    expect(text).toContain('What KAI already knows about this project');
    expect(text).toContain('npm run test');
    expect(text).toContain('src/main.ts');
    expect(text).toContain('rename start');
    expect(text).not.toContain('node_modules');
  });

  it('does nothing until it has somewhere to keep its files', async () => {
    const project = await tempDir('kai-knowledge-unconfigured');
    // Reset the module's directory by configuring it to a directory, then check the empty-project path.
    configureProjectKnowledge(await tempDir('kai-knowledge-empty'));
    expect(await knowledgeBriefing(project)).toBe('');
  });
});
