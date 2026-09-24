import { describe, expect, it } from 'vitest';
import {
  applyClassifications,
  countOverrules,
  draftCounts,
  draftRows,
  isOverrule,
  learnedCorrections,
  markFor,
  marksForAll,
  parseDraftVerdict,
  planDecisions,
  planTypeChanges,
  reviewRecap,
} from '../apps/desktop/src/renderer/src/components/cognitive1-drafts';

function draft(index: number, title: string, raw: string, extra: Record<string, unknown> = {}) {
  return { index, title, type: 'gotchas', project: 'git-hook', raw, ...extra };
}

describe('reading the verdict Overwatch already wrote', () => {
  it('reads a keep with its confidence and reason', () => {
    expect(parseDraftVerdict('## [2026-09-23 10:00] Port is busy -- git-hook\n#overwatch: keep (85% confidence)')).toEqual({
      verdict: 'keep',
      confidence: 0.85,
      reason: null,
    });
  });

  it('reads a borderline and strips the noise prefix from its reason', () => {
    const parsed = parseDraftVerdict('#overwatch: borderline (noise@70%: restates a known gotcha)');
    expect(parsed?.verdict).toBe('borderline');
    expect(parsed?.confidence).toBe(0.7);
    expect(parsed?.reason).toBe('restates a known gotcha');
  });

  it('treats an annotation without a percentage the way the daemon does', () => {
    expect(parseDraftVerdict('#overwatch: keep')?.confidence).toBe(1);
    expect(parseDraftVerdict('#overwatch: borderline (needs a human)')?.confidence).toBe(0.5);
  });

  it('reports no verdict for an unannotated block', () => {
    expect(parseDraftVerdict('## [2026-09-23 10:00] Something -- auto')).toBeNull();
  });
});

describe('draft rows', () => {
  it('keeps the daemon index, reads the type from the block, and labels the agent separately from the project', () => {
    const rows = draftRows([
      draft(2, 'Port is busy', '#type: gotchas\n#tags: proxy, ports\n**Project:** KAI\n#overwatch: keep (90% confidence)'),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      index: 2,
      title: 'Port is busy',
      type: 'gotchas',
      agent: 'git-hook',
      project: 'KAI',
      tags: ['proxy', 'ports'],
      verdict: 'keep',
      confidence: 0.9,
      verdictSource: 'annotation',
    });
  });

  it('falls back to a brain type named in the block, then to unknown', () => {
    expect(draftRows([draft(0, 'a', 'mentions patterns in prose', { type: 'unknown' })])[0].type).toBe('patterns');
    expect(draftRows([draft(0, 'a', 'no type anywhere', { type: 'unknown' })])[0].type).toBe('unknown');
  });

  it('falls back to the position when the daemon sends no index', () => {
    expect(draftRows([{ title: 'first' }, { title: 'second' }]).map((row) => row.index)).toEqual([0, 1]);
  });

  it('reads the queue out of the { drafts, count } body the daemon returns', () => {
    // Getting this wrong is silent: the wrapper object has no drafts, so the panel looks like an empty queue.
    const body = { drafts: [draft(0, 'a', '#overwatch: keep'), draft(1, 'b', '')], count: 2 };
    expect(draftRows(body).map((row) => row.title)).toEqual(['a', 'b']);
    expect(draftRows({ drafts: [], count: 0 })).toEqual([]);
    expect(draftRows({ count: 2 })).toEqual([]);
    expect(draftRows(null)).toEqual([]);
  });
});

describe('folding Overwatch classifications onto rows', () => {
  const rows = draftRows([draft(0, 'noisy', 'no annotation'), draft(1, 'clean', '#overwatch: keep')]);

  it('fills in the verdict, reason and suggested type the queue could not carry', () => {
    const merged = applyClassifications(rows, {
      classifications: [
        { index: 0, verdict: 'noise', confidence: 0.91, reason: 'co-authored-by trailer' },
        { index: 1, verdict: 'keep', confidence: 0.8, suggestedType: 'patterns', reason: 'reusable', suggestedTags: ['x'] },
      ],
    });
    expect(merged[0]).toMatchObject({ verdict: 'noise', confidence: 0.91, reason: 'co-authored-by trailer', verdictSource: 'overwatch' });
    expect(merged[1]).toMatchObject({ verdict: 'keep', suggestedType: 'patterns' });
  });

  it('ignores a suggested type the brain files cannot hold', () => {
    const merged = applyClassifications(rows, { classifications: [{ index: 0, verdict: 'keep', suggestedType: 'unknown' }] });
    expect(merged[0].suggestedType).toBeNull();
  });

  it('leaves rows alone when a classification is missing for them, and when there are none at all', () => {
    const partial = applyClassifications(rows, { classifications: [{ index: 0, verdict: 'noise' }] });
    expect(partial[1]).toMatchObject({ verdict: 'keep', verdictSource: 'annotation' });
    expect(applyClassifications(rows, { classifications: [] })).toEqual(rows);
  });
});

describe('marks', () => {
  const rows = draftRows([
    draft(0, 'keep me', '#overwatch: keep (95% confidence)'),
    draft(1, 'noise', '#overwatch: noise (90% confidence)'),
    draft(2, 'unsure', '#overwatch: borderline (needs a human)'),
    draft(3, 'unknown', 'no annotation'),
  ]);

  it('starts from Overwatch: keep approves, noise rejects, and everything else waits for a human', () => {
    const marks = {};
    expect(rows.map((row) => markFor(row, marks))).toEqual(['approve', 'reject', null, null]);
    expect(draftCounts(rows)).toEqual({ total: 4, keep: 1, noise: 1, borderline: 1, unclassified: 1, needsHuman: 2 });
  });

  it('lets the reviewer override a verdict, including overriding it back to nothing', () => {
    const marks = { 0: { title: 'keep me', mark: 'reject' as const }, 1: { title: 'noise', mark: null } };
    expect(markFor(rows[0], marks)).toBe('reject');
    expect(markFor(rows[1], marks)).toBeNull();
  });

  it('drops a mark whose index now holds a different draft', () => {
    // The queue was reordered or a draft was removed; index 0 is no longer the draft that was marked.
    const marks = { 0: { title: 'keep me', mark: 'reject' as const } };
    const renumbered = draftRows([draft(0, 'entirely different', '#overwatch: keep')]);
    expect(markFor(renumbered[0], marks)).toBe('approve');
  });

  it('marks every row at once', () => {
    expect(markFor(rows[2], marksForAll(rows, 'approve'))).toBe('approve');
  });
});

describe('applying marks to the queue', () => {
  const rows = draftRows([
    draft(0, 'a', '#overwatch: keep'),
    draft(1, 'b', '#overwatch: noise'),
    draft(2, 'c', '#overwatch: keep'),
  ]);

  it('acts on the highest index first so the remaining indices stay valid', () => {
    const decisions = planDecisions(rows, {});
    expect(decisions.map((decision) => decision.index)).toEqual([2, 1, 0]);
    expect(decisions.map((decision) => decision.action)).toEqual(['approve', 'reject', 'approve']);
  });

  it('leaves unmarked drafts out of the plan entirely', () => {
    expect(planDecisions(rows, marksForAll(rows, null))).toEqual([]);
    expect(planDecisions([rows[2]], marksForAll([rows[2]], null))).toEqual([]);
  });

  it('overrides one row without disturbing the verdicts standing on the others', () => {
    const decisions = planDecisions(rows, { 0: { title: 'a', mark: 'reject' } });
    expect(decisions).toEqual([
      { index: 2, action: 'approve' },
      { index: 1, action: 'reject' },
      { index: 0, action: 'reject' },
    ]);
  });

  it('retypes only approvals Overwatch wants filed somewhere else, and only when asked', () => {
    const withSuggestion = applyClassifications(rows, {
      classifications: [
        { index: 0, verdict: 'keep', suggestedType: 'patterns' },
        { index: 2, verdict: 'keep', suggestedType: 'gotchas' },
      ],
    }).map((row) => ({ ...row, type: row.suggestedType === 'patterns' ? 'decisions' : row.type }));
    const decisions = planDecisions(withSuggestion, {});
    expect(planTypeChanges(withSuggestion, decisions, true).map((change) => change.index)).toEqual([0]);
    expect(planTypeChanges(withSuggestion, decisions, false)).toEqual([]);
  });
});

describe('teaching Overwatch', () => {
  it('matches the daemon: only a decision against the verdict is a correction', () => {
    // Every (action, verdict) pair, with the answer C1's overwatch-precedents.isOverrule gives. The panel promises
    // "this will teach Overwatch" from this rule, so it must never disagree with what the daemon records.
    const table: Array<['approve' | 'reject', 'keep' | 'noise' | 'borderline' | null, boolean]> = [
      ['reject', 'keep', true],
      ['reject', 'borderline', true],
      ['reject', 'noise', false],
      ['reject', null, false],
      ['approve', 'noise', true],
      ['approve', 'keep', false],
      ['approve', 'borderline', false],
      ['approve', null, false],
    ];
    for (const [action, verdict, expected] of table) {
      expect(isOverrule(action, verdict), `${action} after ${String(verdict)}`).toBe(expected);
    }
  });

  it('counts the planned decisions that will be recorded as corrections', () => {
    const rows = draftRows([
      draft(0, 'kept', '#overwatch: keep'),
      draft(1, 'noisy', '#overwatch: noise'),
      draft(2, 'unjudged', ''),
    ]);
    // Overwatch's own defaults teach nothing.
    expect(countOverrules(rows, planDecisions(rows, {}))).toBe(0);
    // Rejecting its keep and approving its noise are both corrections; deciding an unjudged draft is not.
    const flipped = planDecisions(rows, {
      0: { title: 'kept', mark: 'reject' },
      1: { title: 'noisy', mark: 'approve' },
      2: { title: 'unjudged', mark: 'reject' },
    });
    expect(countOverrules(rows, flipped)).toBe(2);
  });

  it('reports no learned count at all when the engine predates learning', () => {
    expect(learnedCorrections(3)).toBe(3);
    expect(learnedCorrections(0)).toBe(0);
    // An older C1 sends no field; that must not read as "taught nothing".
    expect(learnedCorrections(undefined)).toBeNull();
    expect(learnedCorrections(-1)).toBeNull();
    expect(learnedCorrections('4')).toBeNull();
  });
});

describe('the review recap', () => {
  const base = { counts: draftCounts([]), overwatch: { enabled: true, ready: true }, urgentCount: 0, insights: [] };

  it('says so plainly when nothing is waiting', () => {
    expect(reviewRecap(base)).toEqual([{ tone: 'good', text: 'No drafts are waiting for review.' }]);
  });

  it('counts what Overwatch decided and what it left for a human', () => {
    const counts = { total: 9, keep: 4, noise: 2, borderline: 1, unclassified: 2, needsHuman: 3 };
    const lines = reviewRecap({ ...base, counts, urgentCount: 2, insights: ['Rejected 4 noise drafts'] });
    expect(lines.map((line) => line.text)).toEqual([
      'Overwatch has a verdict on 6 of 9 drafts: 4 worth keeping, 2 that look like noise.',
      '1 draft(s) came back borderline. Overwatch leaves those to you.',
      '2 draft(s) have no verdict yet. Asking Overwatch costs one model call each.',
      '2 urgent note(s) are pinned for every agent working in this brain.',
      'Most recent Overwatch activity: Rejected 4 noise drafts',
    ]);
  });

  it('explains why drafts have no verdict when Overwatch is off or has no key', () => {
    const counts = { total: 2, keep: 0, noise: 0, borderline: 0, unclassified: 2, needsHuman: 2 };
    expect(reviewRecap({ ...base, counts, overwatch: { enabled: false, ready: false } })[1]).toMatchObject({ tone: 'warn' });
    expect(reviewRecap({ ...base, counts, overwatch: { enabled: true, ready: false } })[1].text).toContain('no API key');
  });
});
