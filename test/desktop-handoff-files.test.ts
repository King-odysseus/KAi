import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boardCardSchema, type BoardCard, type StudioArtifacts, type StudioBoard } from '../packages/contracts/src';
import { AGENTS_MARKER, agentsMarkdown, statusMarkdown, writeHandoffFiles } from '../apps/desktop/src/main/handoff-files';

const AT = '2026-10-01T10:00:00.000Z';
const LATER = '2026-10-01T11:30:00.000Z';

function card(id: string, overrides: Partial<BoardCard> = {}): BoardCard {
  return boardCardSchema.parse({ id, title: `Card ${id}`, kind: 'backend', createdAt: AT, updatedAt: AT, ...overrides });
}

const board: StudioBoard = {
  schemaVersion: 1,
  cards: [
    card('a', { status: 'done' }),
    card('b', { status: 'inProgress', claimedBy: 'claude', movedBy: 'agent', movedAt: AT }),
    card('c', { status: 'ready' }),
    card('d', { status: 'blocked', notes: 'Waiting on the payment keys.', movedBy: 'user', movedAt: AT }),
  ],
};
const catalog: StudioArtifacts = {
  schemaVersion: 1,
  artifacts: [
    { kind: 'brief', path: '.kai/spec/brief.md', version: 0, updatedAt: AT, generatedBy: 'interview', dependsOn: [], stale: false, staleReason: null },
    { kind: 'prd', path: '.kai/spec/prd.md', version: 1, updatedAt: AT, generatedBy: 'model', dependsOn: ['brief'], stale: true, staleReason: 'brief was regenerated.' },
  ],
};

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-handoff-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });

describe('handoff files', () => {
  it('writes a status snapshot that says what is done, who moved what and what is next', () => {
    const text = statusMarkdown(board, catalog, AT);
    expect(text).toContain('**1 of 4 cards done.**');
    expect(text).toContain('Start with **Card c**');
    expect(text).toContain('## In progress (1)');
    expect(text).toContain('moved by agent claude');
    expect(text).toContain('moved by you');
    expect(text).toContain('note: Waiting on the payment keys.');
    expect(text).toContain('- prd: brief was regenerated.');
  });

  it('points the agent instructions only at artifacts that exist', () => {
    const text = agentsMarkdown(catalog);
    expect(text.startsWith(AGENTS_MARKER)).toBe(true);
    expect(text).toContain('.kai/spec/prd.md');
    expect(text).not.toContain('.kai/spec/risks.md\n');
    // An agent working in the project directly is told how to build a screen and to keep to one browser tab.
    expect(text).toContain('## Building screens');
    expect(text).toContain('bottom tab bar');
    expect(text).toContain('## Using the browser');
    expect(text).toContain('your own');
    expect(text).toContain('browser_tabs');
    // The headings stand in for the first line of each rule block, so it is not said twice.
    expect(text).not.toContain('BUILDING THE SCREEN');
    expect(text).not.toContain('USING THE BROWSER TOOLS');
  });

  it('writes both files, keeps the timestamp while nothing changed, and rewrites when the board moves', async () => {
    const first = await writeHandoffFiles(root, board, catalog, AT);
    expect(first.agents).toBe('AGENTS.md');
    const statusPath = path.join(root, '.kai', 'spec', 'status.md');
    expect(fs.readFileSync(statusPath, 'utf8')).toContain('2026-10-01 10:00');

    await writeHandoffFiles(root, board, catalog, LATER);
    expect(fs.readFileSync(statusPath, 'utf8')).toContain('2026-10-01 10:00');

    const moved: StudioBoard = { ...board, cards: board.cards.map((item) => (item.id === 'c' ? { ...item, status: 'inProgress' as const } : item)) };
    await writeHandoffFiles(root, moved, catalog, LATER);
    expect(fs.readFileSync(statusPath, 'utf8')).toContain('2026-10-01 11:30');
  });

  it('never overwrites an AGENTS.md the user wrote', async () => {
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# My own rules\n');
    const written = await writeHandoffFiles(root, board, catalog, AT);
    expect(written.agents).toBeNull();
    expect(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')).toBe('# My own rules\n');
  });

  it('writes no agent instructions before any artifact exists', async () => {
    const written = await writeHandoffFiles(root, { schemaVersion: 1, cards: [] }, { schemaVersion: 1, artifacts: [] }, AT);
    expect(written.agents).toBeNull();
    expect(fs.existsSync(path.join(root, 'AGENTS.md'))).toBe(false);
  });
});
