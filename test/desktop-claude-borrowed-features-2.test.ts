import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Schedule, SecurityFindingReportItem } from '@kai/contracts';
import { deferredToolSummary } from '../apps/desktop/src/main/deferred-tools';
import { parseCargoOutput, parseGoOutput, parseMypyOutput, parseRuffOutput } from '../apps/desktop/src/main/type-diagnostics';
import { parseClaimChecks } from '../apps/desktop/src/main/change-review';
import { annotateEvidence, parseLocation, recheckReportItems, snippetAround } from '../apps/desktop/src/main/security-recheck';
import { loadFileAgents, parseAgentFile, roleIdFor, withFileAgents } from '../apps/desktop/src/main/file-agents';
import { nextGapMinutes, parseNextCheck, selfPacedInstruction } from '../apps/desktop/src/main/self-paced';
import { DesktopScheduler, ScheduleStore, isDue, nextRunTime } from '../apps/desktop/src/main/scheduler';
import { cacheSavingsUsd, estimateCostUsd } from '../apps/desktop/src/main/usage-budget';

describe('diagnostics from other languages', () => {
  it('parses ruff, mypy, cargo and go output', () => {
    expect(parseRuffOutput('src/a.py:3:1: F401 `os` imported but unused', '/p')[0]).toMatchObject({ file: 'src/a.py', line: 3, column: 1, code: 'F401' });
    expect(parseMypyOutput('src/a.py:10:5: error: Incompatible types  [assignment]', '/p')[0]).toMatchObject({ line: 10, column: 5, code: 'assignment', severity: 'error' });
    expect(parseMypyOutput('a.py:7: error: Missing return', '/p')[0]).toMatchObject({ line: 7, column: 1, code: 'mypy' });
    expect(parseCargoOutput('src/main.rs:12:5: error[E0425]: cannot find value `x`', '/p')[0]).toMatchObject({ file: 'src/main.rs', code: 'E0425' });
    expect(parseGoOutput('./main.go:9:2: unreachable code', '/p')[0]).toMatchObject({ file: 'main.go', line: 9, column: 2 });
    expect(parseGoOutput('ok  example.com/x 0.1s', '/p')).toEqual([]);
  });
});

describe('deferred tool summary', () => {
  it('says nothing for a run that never searched, and names what a searching run loaded', () => {
    expect(deferredToolSummary([{ type: 'tool.call', name: 'read_file', status: 'completed' }])).toBeUndefined();
    const line = deferredToolSummary([
      { type: 'tool.call', name: 'tool_search', status: 'completed', output: { loaded: [{ name: 'mcp_a' }, { name: 'mcp_b' }] } },
      { type: 'tool.call', name: 'tool_search', status: 'completed', output: { loaded: [{ name: 'mcp_a' }] } },
    ]);
    expect(line).toContain('2 searches');
    expect(line).toContain('mcp_a, mcp_b');
  });
});

describe('security findings get a sceptical second look, never a deletion', () => {
  const item: SecurityFindingReportItem = { severity: 'high', vulnClass: 'sql-injection', title: 'Unsafe query', location: 'src/db.ts:3', evidence: 'User input is concatenated into SQL.', conceptCard: 'Use parameters.' };

  it('reads a location and numbers the lines around it', () => {
    expect(parseLocation('src/db.ts:42')).toEqual({ file: 'src/db.ts', line: 42 });
    expect(parseLocation('src/db.ts (lines 5-9)')).toEqual({ file: 'src/db.ts', line: 5 });
    expect(parseLocation('the login form')).toBeUndefined();
    const text = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join('\n');
    const snippet = snippetAround(text, 50);
    expect(snippet.startsWith('35: line 35')).toBe(true);
    expect(snippet.endsWith('65: line 65')).toBe(true);
  });

  it('writes a doubt into the evidence and leaves a confirmed finding exactly as it was', () => {
    expect(annotateEvidence(item.evidence, { verdict: 'confirmed', reason: 'yes' })).toBe(item.evidence);
    expect(annotateEvidence(item.evidence, undefined)).toBe(item.evidence);
    const rejected = annotateEvidence(item.evidence, { verdict: 'rejected', reason: 'The query is parameterised.' });
    expect(rejected).toContain('disagreed');
    expect(rejected).toContain('The query is parameterised.');
    expect(rejected).toContain(item.evidence);
  });

  it('keeps every finding when the checker fails, and annotates one when it answers', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-recheck-'));
    await fs.mkdir(path.join(dir, 'src'));
    await fs.writeFile(path.join(dir, 'src', 'db.ts'), 'const a = 1;\nconst b = 2;\nquery(`select ${a}`);\n');
    try {
      const failing = { checkClaims: async () => { throw new Error('offline'); } };
      expect(await recheckReportItems([item], dir, failing)).toEqual([item]);
      expect(await recheckReportItems([item], dir, undefined)).toEqual([item]);
      let seenSnippet = '';
      const doubting = { checkClaims: async (claims: readonly { snippet: string }[]) => { seenSnippet = claims[0].snippet; return new Map([[0, { verdict: 'plausible' as const, reason: 'Cannot see the caller.' }]]); } };
      const [checked] = await recheckReportItems([item], dir, doubting);
      expect(seenSnippet).toContain('3: query(');
      expect(checked.evidence).toContain('could not confirm');
      expect(checked.title).toBe(item.title);
    } finally {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  it('never reads a file outside the project', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-recheck-'));
    try {
      let seenSnippet = 'unset';
      const checker = { checkClaims: async (claims: readonly { snippet: string }[]) => { seenSnippet = claims[0].snippet; return new Map(); } };
      await recheckReportItems([{ ...item, location: '../../etc/passwd.txt:1' }], dir, checker);
      expect(seenSnippet).toBe('');
    } finally {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  it('parses claim checks with reasons and ignores out-of-range entries', () => {
    const checks = parseClaimChecks(JSON.stringify({ verdicts: [{ index: 0, verdict: 'rejected', reason: 'Validated.' }, { index: 5, verdict: 'confirmed', reason: '' }] }), 1);
    expect([...checks.keys()]).toEqual([0]);
    expect(checks.get(0)).toEqual({ verdict: 'rejected', reason: 'Validated.' });
  });
});

describe('cache savings', () => {
  it('prices the saving as the difference between full price and the cache-read share', () => {
    const full = estimateCostUsd('claude-sonnet-5-5', 1_000_000, 0, 0);
    const cached = estimateCostUsd('claude-sonnet-5-5', 1_000_000, 0, 1_000_000);
    const saved = cacheSavingsUsd('claude-sonnet-5-5', 1_000_000, 1_000_000);
    expect(full).not.toBeNull();
    expect(saved).not.toBeNull();
    expect(saved!).toBeGreaterThan(0);
    expect(saved!).toBeCloseTo(full! - cached!, 6);
    expect(cacheSavingsUsd('no-such-model-xyz', 1000, 500)).toBeNull();
    expect(cacheSavingsUsd('claude-sonnet-5-5', 100, 5_000)).toBeCloseTo(cacheSavingsUsd('claude-sonnet-5-5', 100, 100) ?? 0, 9);
  });
});

describe('agents written as files', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('turns a file into a read-only role by default and an editing one only when it says so', () => {
    const reader = parseAgentFile('db.md', '---\nname: Database migrator\ndescription: Writes migrations.\n---\nAlways write a down migration.');
    expect(reader).toMatchObject({ id: 'custom-database-migrator', label: 'Database migrator', access: 'read', assignee: 'auto', route: 'auto' });
    expect(reader?.instructions).toBe('Always write a down migration.');
    expect(parseAgentFile('x.md', '---\nname: Fixer\naccess: edit\n---\nFix things.')?.access).toBe('edit');
    // A header cannot choose the agent or route, however it is worded.
    expect(parseAgentFile('x.md', '---\nname: Sneaky\nassignee: codex\nroute: proxy\n---\nDo it.')).toMatchObject({ assignee: 'auto', route: 'auto' });
    expect(parseAgentFile('plain-notes.md', 'Just guidance, no header.')).toMatchObject({ id: 'custom-plain-notes', access: 'read' });
    expect(parseAgentFile('empty.md', '---\nname: Empty\n---\n')).toBeUndefined();
    expect(roleIdFor('!!!')).toBeUndefined();
  });

  it('loads a project folder, skips bad files, and lets a Settings role win on the same id', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-agents-'));
    dirs.push(dir);
    expect(await loadFileAgents(dir)).toEqual([]);
    const folder = path.join(dir, '.kai', 'agents');
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'a.md'), '---\nname: Alpha\n---\nAlpha guidance.');
    await fs.writeFile(path.join(folder, 'b.md'), '---\nname: Beta\n---\n');
    await fs.writeFile(path.join(folder, 'notes.txt'), 'ignored');
    const roles = await loadFileAgents(dir);
    expect(roles.map((role) => role.id)).toEqual(['custom-alpha']);

    const mine = { id: 'custom-alpha', label: 'Mine', description: '', access: 'edit' as const, assignee: 'auto' as const, route: 'auto' as const, instructions: '' };
    const merged = withFileAgents({ custom: [mine] }, roles);
    expect(merged.custom).toEqual([mine]);
    expect(withFileAgents({ custom: [] }, roles).custom).toHaveLength(1);
  });

  it('never grows the team past the custom-role limit', () => {
    const many = Array.from({ length: 12 }, (_, index) => parseAgentFile(`r${index}.md`, `Guidance ${index}`)!);
    expect(withFileAgents({ custom: [] }, many).custom).toHaveLength(8);
  });
});

describe('self-paced schedules', () => {
  it('reads the last NEXT_CHECK line, with markdown noise, and clamps it', () => {
    expect(parseNextCheck('Done.\nNEXT_CHECK: 45')).toEqual({ kind: 'minutes', minutes: 45 });
    expect(parseNextCheck('NEXT_CHECK: 10\nmore\n**NEXT_CHECK: stop**')).toEqual({ kind: 'stop' });
    expect(parseNextCheck('NEXT_CHECK: soon')).toBeUndefined();
    expect(parseNextCheck('no line here')).toBeUndefined();
    expect(nextGapMinutes({ kind: 'minutes', minutes: 1 }, 60, 600)).toBe(15);
    expect(nextGapMinutes({ kind: 'minutes', minutes: 9_999 }, 60, 600)).toBe(600);
    expect(nextGapMinutes(undefined, 90, 600)).toBe(90);
    expect(selfPacedInstruction(240)).toContain('15 to 240');
  });

  const base: Schedule = {
    id: 's1', projectId: 'p', name: 'Watch CI', prompt: 'Check CI', agent: 'claude', execution: 'cli', route: 'direct', autonomy: 'plan', enabled: true,
    frequency: { kind: 'selfPaced', everyMinutes: 30, maxMinutes: 240 }, createdAt: '2026-01-01T00:00:00.000Z',
  };

  it('is due by the run\'s own next moment once it has one', () => {
    const now = new Date('2026-01-01T01:00:00.000Z');
    expect(isDue(base, now)).toBe(true);
    const waiting = { ...base, lastRunAt: '2026-01-01T00:50:00.000Z', nextRunAt: '2026-01-01T03:00:00.000Z' };
    expect(isDue(waiting, now)).toBe(false);
    expect(nextRunTime(waiting, now)?.toISOString()).toBe('2026-01-01T03:00:00.000Z');
    expect(isDue({ ...waiting, nextRunAt: '2026-01-01T00:59:00.000Z' }, now)).toBe(true);
  });

  it('records the gap a run asked for, falls back when it said nothing, and switches off on stop', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-sched-'));
    try {
      const clock = new Date('2026-01-01T12:00:00.000Z');
      const outcomes: Array<Parameters<NonNullable<ConstructorParameters<typeof DesktopScheduler>[1]['run']>>[0] extends never ? never : { status: 'completed'; summary: string; nextCheck?: { kind: 'minutes'; minutes: number } | { kind: 'stop' } }> = [
        { status: 'completed', summary: 'a', nextCheck: { kind: 'minutes', minutes: 60 } },
        { status: 'completed', summary: 'b' },
        { status: 'completed', summary: 'c', nextCheck: { kind: 'stop' } },
      ];
      const store = new ScheduleStore(path.join(dir, 'schedules.json'));
      const scheduler = new DesktopScheduler(store, { now: () => clock, run: async () => outcomes.shift()! });
      const saved = await scheduler.save({ projectId: 'p', name: 'Watch CI', prompt: 'Check CI', agent: 'claude', execution: 'cli', route: 'direct', autonomy: 'plan', enabled: true, frequency: { kind: 'selfPaced', everyMinutes: 30, maxMinutes: 240 } });

      const first = await scheduler.runNow(saved.id);
      expect(first.nextRunAt).toBe('2026-01-01T13:00:00.000Z');
      const second = await scheduler.runNow(saved.id);
      expect(second.nextRunAt).toBe('2026-01-01T12:30:00.000Z');
      const third = await scheduler.runNow(saved.id);
      expect(third.enabled).toBe(false);
      expect(third.nextRunAt).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});
