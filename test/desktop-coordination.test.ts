import { describe, expect, it } from 'vitest';
import { globalSearchResultSchema, preflightResultSchema, coordinationOverviewSchema } from '../packages/contracts/src';
import { mcpText, parseActiveClaims, parseConflictText, parseRecallText, parseUrgentNotes } from '../apps/desktop/src/main/coordination';

// Output copied from the Cognitive1 tools (conflict-check.ts and recall.ts).
const CONFLICT_TEXT = [
  'CONFLICT DETECTED — another agent is editing overlapping files.',
  '',
  'Agent: claude (KAI)',
  'Overlapping files: src/auth.ts, src/login.ts',
  'All their claimed files: src/auth.ts, src/login.ts, src/session.ts',
  '',
  'Agent: qwen (KAI)',
  'Overlapping files: src/auth.ts',
  'All their claimed files: src/auth.ts',
  '',
  'Coordinate via brain_handoff or urgent_set before proceeding.',
].join('\n');

const RECALL_TEXT = [
  '=== Recall: "login" ===',
  '',
  '### Brain Entries (2)',
  '- [2026-09-01] [bugs] Login redirect loop — claude',
  '- [2026-08-20] [patterns] Session refresh pattern — codex',
  '',
  '### Handoffs (1)',
  '- [2026-09-02] claude -> codex: pending',
  '',
  '### Daily Logs (1)',
  '- 2026-09-03: 4 matches',
  '',
  '### Knowledge Base (1)',
  '- auth-notes.md: 2 matches',
].join('\n');

describe('conflict check parsing', () => {
  it('returns every conflicting agent with its overlapping files', () => {
    const conflicts = parseConflictText(CONFLICT_TEXT);
    expect(conflicts).toEqual([
      { agent: 'claude', project: 'KAI', overlap: ['src/auth.ts', 'src/login.ts'] },
      { agent: 'qwen', project: 'KAI', overlap: ['src/auth.ts'] },
    ]);
    expect(preflightResultSchema.parse({ checked: true, conflicts })).toBeTruthy();
  });

  it('returns nothing when the files are free', () => {
    expect(parseConflictText('No conflicts. All 2 file(s) are free to edit.\nFiles checked: a.ts, b.ts')).toEqual([]);
    expect(parseConflictText('')).toEqual([]);
  });
});

describe('recall parsing', () => {
  it('groups brain entries, handoffs, daily logs and knowledge files', () => {
    const hits = parseRecallText(RECALL_TEXT);
    expect(hits.map((hit) => hit.source)).toEqual(['entry', 'entry', 'handoff', 'daily', 'knowledge']);
    expect(hits[0]).toEqual({ source: 'entry', label: 'Login redirect loop', detail: 'bugs · 2026-09-01 · claude' });
    expect(hits[2]?.label).toBe('[2026-09-02] claude -> codex: pending');
    expect(hits[4]?.label).toBe('auth-notes.md: 2 matches');
    expect(globalSearchResultSchema.parse({ query: 'login', brainSearched: true, hits })).toBeTruthy();
  });

  it('ignores the no-results message and stray lines', () => {
    expect(parseRecallText('=== Recall: "zzz" ===\n\nNo results found.')).toEqual([]);
    expect(parseRecallText('- a bullet with no heading above it')).toEqual([]);
  });
});

describe('coordination payloads', () => {
  it('reads claims from the status payload and splits their file lists', () => {
    const claims = parseActiveClaims({
      activeClaims: [
        { agent: 'claude', project: 'KAI', what: 'Fix login', files: 'src/a.ts, src/b.ts', date: '2026-09-23', time: '10:00' },
        { agent: 'codex', project: 'KAI', what: 'Docs', date: '2026-09-23', time: '10:05' },
        { nonsense: true },
      ],
    });
    expect(claims).toHaveLength(2);
    expect(claims[0]?.files).toEqual(['src/a.ts', 'src/b.ts']);
    expect(claims[1]?.files).toEqual([]);
    expect(parseActiveClaims(null)).toEqual([]);
    expect(parseActiveClaims({ activeClaims: 'oops' })).toEqual([]);
  });

  it('reads urgent warnings, defaulting the project to global and skipping empty ones', () => {
    const notes = parseUrgentNotes({
      urgentNotes: [
        { what: 'Migration locked', do: 'Wait', doNot: 'Run migrate', until: 'manually cleared' },
        { project: 'KAI', what: '' },
      ],
    });
    expect(notes).toEqual([{ project: 'global', what: 'Migration locked', do: 'Wait', doNot: 'Run migrate', until: 'manually cleared' }]);
    expect(coordinationOverviewSchema.parse({ available: true, claims: [], urgent: notes })).toBeTruthy();
    expect(parseUrgentNotes(undefined)).toEqual([]);
  });

  it('joins only the text blocks of an MCP tool result', () => {
    expect(mcpText({ content: [{ type: 'text', text: 'one' }, { type: 'image', data: 'x' }, { type: 'text', text: 'two' }] })).toBe('one\ntwo');
    expect(mcpText({})).toBe('');
    expect(mcpText(null)).toBe('');
  });
});
