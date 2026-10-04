import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  boardCardSchema,
  createStudioArtifacts,
  dependentsOf,
  verificationRunSchema,
  type ArtifactEntry,
  type BoardCard,
  type StudioArtifacts,
} from '../packages/contracts/src';
import { StudioArtifacts, applyWrite, ensureBrief, markUserEdited } from '../apps/desktop/src/main/artifacts';
import { StudioBoardStore, applyStaleness, doneBlockedBy, mergeDesign, promoteReady, type BoardPorts } from '../apps/desktop/src/main/board';
import { SpecStore } from '../apps/desktop/src/main/spec-store';
import { hashFile } from '../apps/desktop/src/main/verification';

const NOW = '2026-09-28T12:00:00.000Z';

/** What the board store has announced, in order. Module scope: both describes build stores from the port below. */
const changed: Array<{ projectId: string; revision: number }> = [];
const LATER = '2026-09-28T13:00:00.000Z';
let root = '';

beforeEach(() => {
  changed.length = 0;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-studio-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(relative: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), content, 'utf8');
}

function entry(over: Partial<ArtifactEntry> = {}): ArtifactEntry {
  return { kind: 'prd', path: '.kai/spec/prd.md', version: 0, updatedAt: NOW, generatedBy: 'code', dependsOn: [], stale: false, staleReason: null, ...over };
}

function card(over: Partial<BoardCard> = {}): BoardCard {
  return boardCardSchema.parse({ id: 'c1', title: 'Sign up', kind: 'backend', createdAt: NOW, updatedAt: NOW, ...over });
}

function run(over: Record<string, unknown> = {}) {
  return verificationRunSchema.parse({
    id: 'r1',
    projectId: 'p1',
    command: 'npm test',
    source: 'agent',
    exitCode: 0,
    passed: true,
    startedAt: NOW,
    durationMs: 10,
    head: 'abc',
    files: [],
    testsPassed: 0,
    testsFailed: 0,
    outputTail: '',
    ...over,
  });
}

describe('artifacts', () => {
  it('flags every artifact that reads the one that changed, transitively', () => {
    expect([...dependentsOf('brief')].sort()).toEqual(['acceptance', 'architecture', 'conventions', 'decisions', 'flows', 'glossary', 'pages', 'prd', 'risks', 'setup', 'stack', 'stories', 'style-guide', 'tokens']);
    expect(dependentsOf('tokens')).toEqual([]);
    let entries = applyWrite([], 'prd', { version: 0, at: NOW, generatedBy: 'model' });
    entries = applyWrite(entries, 'stories', { version: 0, at: NOW, generatedBy: 'model' });
    entries = applyWrite(entries, 'brief', { version: 1, at: LATER, generatedBy: 'user' });
    const byKind = new Map(entries.map((item) => [item.kind, item]));
    expect(byKind.get('brief')?.stale).toBe(false);
    expect(byKind.get('prd')?.stale).toBe(true);
    expect(byKind.get('stories')?.staleReason).toBe('brief was regenerated.');
  });

  it('adopts a brief an interview already wrote, and none when there is no file', () => {
    expect(ensureBrief([], false, NOW)).toEqual([]);
    const withBrief = ensureBrief([], true, NOW);
    expect(withBrief.map((item) => item.kind)).toEqual(['brief']);
    expect(withBrief[0]?.generatedBy).toMatch(/interview/);
  });

  it('marks a hand-edited artifact as the user\'s and stales its dependents', () => {
    const entries = markUserEdited(
      [entry({ kind: 'stack' }), entry({ kind: 'tokens', path: '.kai/spec/design/tokens.json' })],
      'stack',
      LATER,
    );
    const byKind = new Map(entries.map((item) => [item.kind, item]));
    expect(byKind.get('stack')?.generatedBy).toBe('user');
    expect(byKind.get('tokens')?.stale).toBe(true);
    expect(byKind.get('tokens')?.staleReason).toBe('stack was edited by hand.');
  });

  it('writes the artifact file, keeps history, and records the catalog', async () => {
    const spec = new SpecStore();
    const store = new StudioArtifacts({ spec, projectRoot: async () => root, now: () => NOW });
    await store.write('p1', 'brief', '# Brief\n', 'model');
    await store.write('p1', 'prd', '# PRD\n', 'model');
    const catalog = await store.read('p1');
    const byKind = new Map(catalog.artifacts.map((item) => [item.kind, item]));
    expect(byKind.get('prd')?.stale).toBe(false);
    // Regenerating the root makes the PRD a stale copy of an older brief.
    await store.write('p1', 'brief', '# Brief v2\n', 'model');
    const after = await store.read('p1');
    expect(after.artifacts.find((item) => item.kind === 'prd')?.stale).toBe(true);
    expect(await store.readText('p1', 'prd')).toBe('# PRD\n');
    expect(await store.files('p1')).toContain('brief.md');
    expect(fs.existsSync(path.join(root, '.kai', 'spec', '.history', 'brief', 'v1', 'brief.md'))).toBe(true);
  });

  it('reads a brief written straight to disk, without a catalog entry', async () => {
    write('.kai/spec/brief.md', '# from the interview\n');
    const store = new StudioArtifacts({ spec: new SpecStore(), projectRoot: async () => root, now: () => NOW });
    const catalog = await store.read('p1');
    expect(catalog.artifacts.map((item) => item.kind)).toEqual(['brief']);
  });
});

describe('board rules', () => {

  it('gives a screen one card, however the two sides spell its name', () => {
    // The board already has a page card from the stories; the design's page is the same screen under a slightly
    // different name. Comparing the raw text gave the board two cards for one screen, each workable, each looking
    // like real work to do.
    const existing = card({ id: 'sign-up', title: 'Sign-up', kind: 'page' });
    const merged = mergeDesign([existing], [{ id: 'p1', name: 'Sign up', page: 'Sign up', screen: true }], NOW);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: 'sign-up', designRef: 'p1' });
  });

  it('still gives a screen its own card when the board has nothing for it', () => {
    const merged = mergeDesign([card({ id: 'other', title: 'Dashboard' })], [{ id: 'p1', name: '/pricing — Pricing page /pricing', page: '', screen: true }], NOW);

    expect(merged.map((item) => item.title)).toEqual(['Dashboard', '/pricing — Pricing page /pricing']);
  });

  it('gives a page from the design the route its name carries', () => {
    // A page card with no route can never pass its screen check, and the board will not close a screen card without
    // one — so a page pulled from the design used to be unclosable, and everything waiting on it waited for good.
    const merged = mergeDesign([card({ id: 'other', title: 'Dashboard' })], [
      { id: 'p1', name: '/ — Marketing home (sharpsite.ng)', page: '', screen: true },
      { id: 'p2', name: '/pricing — Pricing page', page: '', screen: true },
      { id: 'p3', name: 'Page 1', page: '', screen: true },
      { id: 'p4', name: 'Empty sections collapse', page: '', screen: false },
    ], NOW);
    const route = (nodeId: string): string | undefined => merged.find((item) => item.designRef === nodeId)?.route;

    expect(route('p1')).toBe('/');
    expect(route('p2')).toBe('/pricing');
    // Nothing in the name to take, so it is left blank for a person to fill in rather than guessed at.
    expect(route('p3')).toBe('');
    // A component is not a page: it carries no route of its own.
    expect(route('p4')).toBe('');
  });

  it('fills a page card\'s missing route, and leaves the one a person set alone', () => {
    const empty = card({ id: 'home', title: 'Marketing home', kind: 'page', designRef: 'p1' });
    const set = card({ id: 'pricing', title: 'Pricing', kind: 'page', designRef: 'p2', route: '/prices' });
    const merged = mergeDesign([empty, set], [
      { id: 'p1', name: '/ — Marketing home', page: '', screen: true },
      { id: 'p2', name: '/pricing — Pricing page', page: '', screen: true },
    ], NOW);

    expect(merged.find((item) => item.id === 'home')?.route).toBe('/');
    expect(merged.find((item) => item.id === 'pricing')?.route).toBe('/prices');
  });

  it('refuses done for each unmet rule, and names it', () => {
    const backend = card();
    expect(doneBlockedBy(backend, { run: null, recordedNow: null, drifted: false })).toMatch(/no record of a passing check/);
    const check = { runId: 'r1', at: NOW, visual: null, screenshots: [] };
    expect(doneBlockedBy({ ...backend, check }, { run: null, recordedNow: null, drifted: false })).toMatch(/no longer in the verification history/);
    expect(doneBlockedBy({ ...backend, check }, { run: run({ passed: false, exitCode: 1 }), recordedNow: [], drifted: false })).toMatch(/did not pass/);
    expect(doneBlockedBy({ ...backend, check }, { run: run(), recordedNow: [], drifted: true })).toMatch(/changed after the check/);
    expect(doneBlockedBy({ ...backend, check }, { run: run(), recordedNow: null, drifted: false })).toMatch(/could not be read back/);
    expect(doneBlockedBy({ ...backend, check }, { run: run(), recordedNow: [{ path: 'a.ts', hash: null }], drifted: false })).toMatch(/no longer on disk/);
    expect(doneBlockedBy({ ...backend, check }, { run: run({ files: [{ path: 'a.ts', hash: 'h1' }] }), recordedNow: [{ path: 'a.ts', hash: 'h2' }], drifted: false })).toMatch(/a\.ts changed since/);
    expect(doneBlockedBy({ ...backend, check }, { run: run(), recordedNow: [], drifted: false })).toBeNull();
  });

  it('holds a UI card open until its visual check passed', () => {
    const page = card({ kind: 'page', check: { runId: 'r1', at: NOW, visual: 'failed', screenshots: [] } });
    expect(doneBlockedBy(page, { run: run(), recordedNow: [], drifted: false })).toMatch(/visual check/);
    const passed = { ...page, check: { runId: 'r1', at: NOW, visual: 'passed' as const, screenshots: ['shot.png'] } };
    expect(doneBlockedBy(passed, { run: run(), recordedNow: [], drifted: false })).toBeNull();
  });

  it('stales a card whose artifact moved, and promotes a card whose dependencies are done', () => {
    const artifacts = [{ ...entry({ kind: 'tokens', path: '.kai/spec/design/tokens.json' }), stale: true }];
    const [stale] = applyStaleness([card({ needsArtifacts: ['tokens'] })], artifacts);
    expect(stale?.stale).toBe(true);
    expect(stale?.staleReason).toMatch(/tokens changed/);
    const done = card({ id: 'a', status: 'done' });
    const waiting = card({ id: 'b', status: 'backlog', dependsOn: ['a'] });
    const later = card({ id: 'c', status: 'backlog', dependsOn: ['missing'] });
    const promoted = promoteReady([done, waiting, later]);
    expect(promoted.find((item) => item.id === 'b')?.status).toBe('ready');
    expect(promoted.find((item) => item.id === 'c')?.status).toBe('backlog');
  });
});

describe('board store', () => {
  function ports(): BoardPorts & { runs: Map<string, ReturnType<typeof run>> } {
    const runs = new Map<string, ReturnType<typeof run>>();
    return {
      runs,
      spec: new SpecStore(),
      projectRoot: async () => root,
      dirtyFiles: async () => {
        const found: Array<{ path: string; hash: string }> = [];
        const walk = (dir: string, prefix: string): void => {
          for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
            const relative = prefix ? `${prefix}/${item.name}` : item.name;
            if (item.isDirectory()) walk(path.join(dir, item.name), relative);
            else found.push({ path: relative, hash: createHash('sha256').update(fs.readFileSync(path.join(dir, item.name))).digest('hex') });
          }
        };
        walk(root, '');
        return found;
      },
      hashFile: (projectPath, relativePath) => hashFile(projectPath, relativePath),
      run: async (_projectId, runId) => runs.get(runId) ?? null,
      now: () => NOW,
      changed: (projectId, board) => changed.push({ projectId, revision: board.revision }),
    };
  }

  /**
   * Every write tells the windows, wherever it came from.
   *
   * The announcing used to live in the IPC handlers, which only run when a person presses something — so a board
   * Autopilot was working on in the main process sat still on screen while the file on disk moved on.
   */
  it('announces every write, not only the ones a window asked for', async () => {
    const p = ports();
    const store = new StudioBoardStore(p);
    await store.replace('p1', [card({ id: 'a' })], []);
    await store.claim('p1', 'a', 'autopilot');
    await store.move('p1', 'a', 'blocked', 'testing');

    expect(changed.map((entry) => entry.projectId)).toEqual(['p1', 'p1', 'p1']);
    // And once per write, with the revision that write produced.
    expect(changed.map((entry) => entry.revision)).toEqual([1, 2, 3]);
  });

  it('refuses to close a card whose check has drifted, then allows it once the tree matches again', async () => {
    const p = ports();
    const store = new StudioBoardStore(p);
    write('src/a.ts', 'export const a = 1;\n');
    const hash = await hashFile(root, 'src/a.ts');
    p.runs.set('r1', run({ files: [{ path: 'src/a.ts', hash }] }));
    await store.replace('p1', [card({ status: 'ready' })], []);
    await store.setCheck('p1', 'c1', { runId: 'r1', at: NOW, visual: null, screenshots: [] });
    // A file the check never saw appears: the recorded result no longer covers the tree.
    write('src/b.ts', 'export const b = 2;\n');
    await expect(store.move('p1', 'c1', 'done')).rejects.toThrow(/changed after the check passed/);
    // Remove the drift: now the recorded hashes match what is on disk.
    fs.rmSync(path.join(root, 'src', 'b.ts'));
    const done = await store.move('p1', 'c1', 'done');
    expect(done.status).toBe('done');
  });

  it('lets one agent hold a card, and only a ready card be claimed', async () => {
    const store = new StudioBoardStore(ports());
    await store.replace('p1', [card({ id: 'a' }), card({ id: 'b', dependsOn: ['a'] })], []);
    // `a` has no dependencies, so it is promoted to ready; `b` waits on `a` and stays in the backlog.
    await expect(store.claim('p1', 'b', 'claude')).rejects.toThrow(/only a ready card/);
    const claimed = await store.claim('p1', 'a', 'claude');
    expect(claimed.status).toBe('inProgress');
    expect(claimed.claimedBy).toBe('claude');
    await expect(store.claim('p1', 'a', 'codex')).rejects.toThrow(/already held by claude/);
  });

  it('promotes a card whose dependencies are done however it reached the backlog', async () => {
    const store = new StudioBoardStore(ports());
    await store.replace('p1', [card({ id: 'a', status: 'done' }), card({ id: 'b', status: 'backlog', dependsOn: ['a'] })], []);
    // Park it the way "put it back in the queue" does when the card cannot be ready yet.
    await store.move('p1', 'b', 'backlog', 'Put back in the queue after an agent stopped on it.');

    // Its dependency is done, so it is workable. Only `done` moves used to promote, so a card left here stayed here
    // while Autopilot found nothing ready and the board looked stuck with no stated reason.
    expect((await store.read('p1')).cards.find((item) => item.id === 'b')?.status).toBe('ready');
  });

  it('leaves a card a person parked in the backlog where they put it', async () => {
    const store = new StudioBoardStore(ports());
    await store.replace('p1', [card({ id: 'a', status: 'done' }), card({ id: 'b', dependsOn: ['a'] })], []);
    // `replace` promotes `b` to ready; a person drags it back to the backlog on purpose.
    const parked = await store.move('p1', 'b', 'backlog', 'Not yet.', 'user');

    expect(parked.status).toBe('backlog');
    expect((await store.read('p1')).cards.find((item) => item.id === 'b')?.status).toBe('backlog');
  });

  it('sets the route a screen card is checked at, and refuses one on a card with no screen', async () => {
    const store = new StudioBoardStore(ports());
    await store.replace('p1', [card({ id: 'a', kind: 'page', status: 'ready' }), card({ id: 'b', status: 'ready' })], []);

    const routed = await store.setRoute('p1', 'a', '  /pricing  ');
    expect(routed.route).toBe('/pricing');
    // The route is a card field, not a move: the status and the board's rules are untouched.
    expect(routed.status).toBe('ready');
    await expect(store.setRoute('p1', 'b', '/x')).rejects.toThrow(/not a component or page/);
  });

  it('refuses ready while a dependency is not done, and keeps work when the board is regenerated', async () => {
    const store = new StudioBoardStore(ports());
    await store.replace('p1', [card({ id: 'a', status: 'done', check: null }), card({ id: 'b', status: 'backlog', dependsOn: ['a'] })], []);
    expect((await store.next('p1'))?.id).toBe('b');
    await store.recordRun('p1', 'b', { agent: 'claude', model: 'gpt-6-luna', at: NOW, files: ['src/a.ts'] });
    const regenerated = await store.replace('p1', [card({ id: 'a' }), card({ id: 'b', dependsOn: ['a'] })], []);
    const b = regenerated.cards.find((item) => item.id === 'b');
    expect(b?.runs).toHaveLength(1);
    expect(b?.status).toBe('ready');
    await expect(store.move('p1', 'c-missing', 'ready')).rejects.toThrow(/No card/);
  });
});
