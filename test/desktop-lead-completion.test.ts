import { describe, expect, it, vi } from 'vitest';
import { conversationRecordV1Schema, type CheckpointReview, type ConversationRecord, type LeadCompletion, type PersistedEvent, type RoleTarget } from '@kai/contracts';
import { applyCompletionVerdict, completionFacts, continuationBlock, deliverySettings, nextCycle, parseCompletionVerdict, taskRequirements } from '../apps/desktop/src/renderer/src/components/lead-completion';
import { processLeadCompletion, type CompletionPort } from '../apps/desktop/src/renderer/src/components/lead-completion-workflow';
import type { LeadHandoff } from '../apps/desktop/src/renderer/src/components/lead-delivery';
import { LEAD_RECOVERY_PREFIX } from '../apps/desktop/src/renderer/src/components/lead-recovery';

const time = '2026-11-28T00:00:00.000Z';
const task = '### Goal\nAdd a form.\n### Files\n- src/form.ts\n### Done checks\n- Invalid input shows an error.\n### Check command\n```sh\nnpm test\n```';
const local: RoleTarget = { execution: 'api', api: { provider: 'lmstudio', model: 'local-test' } };
const cloud: RoleTarget = { execution: 'api', api: { provider: 'openai', model: 'cloud-test' } };
const handoff: LeadHandoff = { id: 'handoff-a', leadConversationId: 'lead-a', task, createdAt: time, userTurnCount: 0, delivery: 'run' };
const checkpoint: CheckpointReview = { conversationId: 'builder-a', turnId: 'reply-a', gitAvailable: true, files: [{ path: 'src/form.ts', before: 'before', after: 'after', added: 1, removed: 1, binary: false }] };
const reviewText = (verdict = 'pass', evidence = 'file:src/form.ts — input validation added') => `## Review\nReviewed the change.\nLEAD_RESULT_REVIEW\n${JSON.stringify({ verdict, criteria: [{ criterion: 'Invalid input shows an error.', passed: verdict === 'pass', evidence }], summary: 'Acceptance checked.' })}\nEND_LEAD_RESULT_REVIEW`;
function record(id: string): ConversationRecord {
  return { schemaVersion: 1, id, projectId: 'project-a', title: id, createdAt: time, updatedAt: time, archived: false, unread: false, activeAgent: null, route: null, autonomy: 'ask', turns: [], events: [] };
}
function check(command = 'npm test', exitCode = 0, output = '1 test passed'): PersistedEvent {
  return { schemaVersion: 1, id: `check-${command}`, taskId: 'builder-a', type: 'tool.call', name: 'run_command', timestamp: time, status: exitCode ? 'failed' : 'completed', input: { command }, output: { exitCode, output } };
}
function builder(): ConversationRecord {
  return { ...record('builder-a'), leadHandoffs: [handoff], turns: [{ id: 'request-a', role: 'user', text: task, createdAt: time, fileSnapshot: [{ path: 'src/form.ts', hash: 'hash-a' }] }, { id: 'reply-a', role: 'assistant', text: 'Phase complete', createdAt: time }], events: [check()] };
}
function fixture(mode: 'discuss' | 'ask' | 'auto' = 'auto') {
  const records = new Map<string, ConversationRecord>([['builder-a', builder()], ['lead-a', { ...record('lead-a'), origin: { kind: 'lead', projectId: 'project-a' }, leadHandoffMode: mode }]]);
  const port: CompletionPort = {
    load: async (id) => records.get(id)!,
    save: vi.fn(async (item) => { const saved = conversationRecordV1Schema.parse(JSON.parse(JSON.stringify(item))); records.set(item.id, saved); return saved; }),
    checkpoint: async () => checkpoint,
    read: async () => ({ hash: 'hash-a', content: 'after' }),
    assertSession: vi.fn(), leadTarget: () => local, unavailable: () => null,
    ask: vi.fn(async (prompt, target, role) => {
      const lead = records.get('lead-a')!;
      const text = prompt.includes('LEAD_RESULT_REVIEW') ? reviewText() : `BUILDER TASK:\n### Goal\nAdd the next planned check.\nEND BUILDER TASK`;
      const next = { ...lead, turns: [...lead.turns, { id: `review-${lead.turns.length}`, role: 'assistant' as const, text, createdAt: time }], events: [...lead.events, ...(target.api?.provider === 'openai' ? [{ schemaVersion: 1 as const, id: `cost-${lead.turns.length}`, taskId: 'lead-a', type: 'cost.update' as const, timestamp: time, amountUsd: 0.01 }] : [])] };
      records.set('lead-a', next); return next;
    }),
    dispatch: vi.fn(async () => undefined), notice: vi.fn(),
  };
  return { port, records, get facts() { return records.get('builder-a')!.leadHandoffs![0]!.completion!; } };
}

describe('evidence-based Lead completion', () => {
  it('extracts complete commands and acceptance criteria', () => {
    expect(taskRequirements(task)).toEqual({ commands: ['npm test'], criteria: ['Invalid input shows an error.'] });
    expect(taskRequirements(task.replace('npm test', 'cd desktop && npm test && node scripts/verify.mjs')).commands).toEqual(['npm test', 'node scripts/verify.mjs']);
  });
  it('never accepts Builder claims or a later successful command over a failed check', () => {
    const data = builder(); data.events = [check('npm test', 1, '1 test failed'), check('npx tsc', 0)];
    expect(completionFacts(data, handoff, checkpoint, []).state).toBe('needs-repair');
    data.events = [];
    expect(completionFacts(data, handoff, checkpoint, []).state).toBe('not-checked');
  });
  it('allows a real successful rerun of the same check while preserving other failed gates', () => {
    const data = builder(); data.events = [check('npm test', 1), { ...check('npm test', 0), id: 'retry' }];
    expect(completionFacts(data, handoff, checkpoint, []).state).toBe('review-needed');
  });
  it('keeps missing, mock, stale and uninspected checks open', () => {
    const missingTask = { ...handoff, task: task.replace('npm test', 'npm test\nnode scripts/verify.mjs') };
    const incomplete = builder(); incomplete.turns[0]!.text = missingTask.task;
    expect(completionFacts(incomplete, missingTask, checkpoint, []).missingChecks).toContain('node scripts/verify.mjs');
    const fake = builder(); fake.events = [check('npm test', 0, 'This is a mock compiler')];
    expect(completionFacts(fake, handoff, checkpoint, []).state).toBe('not-checked');
    expect(completionFacts(builder(), handoff, null, []).state).toBe('not-checked');
    expect(completionFacts(builder(), handoff, checkpoint, [], true).state).toBe('needs-you');
  });
  it('marks a check without an exit code unverified instead of starting repair work', () => {
    const data = builder(); data.events = [{ ...check(), output: { output: 'No process result available' } } as PersistedEvent];
    expect(completionFacts(data, handoff, checkpoint, []).state).toBe('not-checked');
  });
  it('requires readable review evidence for every exact acceptance criterion', () => {
    const facts = completionFacts(builder(), handoff, checkpoint, [{ path: 'src/form.ts', hash: 'hash-a' }]);
    expect(facts.state).toBe('review-needed');
    expect(applyCompletionVerdict(facts, 'Looks fine').state).toBe('not-checked');
    expect(applyCompletionVerdict(facts, reviewText('pass', 'I think so')).state).toBe('not-checked');
    expect(applyCompletionVerdict(facts, reviewText()).state).toBe('passed');
    expect(applyCompletionVerdict({ ...facts, state: 'needs-repair' }, reviewText()).state).toBe('needs-repair');
    expect(parseCompletionVerdict('LEAD_RESULT_REVIEW\n{}\nEND_LEAD_RESULT_REVIEW')).toBeNull();
  });
  it('persists evidence and settings while older chats remain loadable', () => {
    const lead = record('lead-a'); expect(deliverySettings(lead)).toMatchObject({ autoReview: false, reviewer: null, maxTasks: 3, maxRepairs: 2, maxUsd: 1 });
    const saved = conversationRecordV1Schema.parse(JSON.parse(JSON.stringify({ ...lead, leadDeliverySettings: { ...deliverySettings(lead), reviewer: cloud, autoReview: true } })));
    expect(saved.leadDeliverySettings?.reviewer).toEqual(cloud);
    expect(saved.autonomy).toBe('ask');
  });
  it('stops at task, repair, repeated-cause and spending limits', () => {
    const settings = deliverySettings(record('lead-a'));
    const facts = { ...completionFacts(builder(), handoff, checkpoint, []), state: 'passed' } as LeadCompletion;
    const base = { rootId: 'root', depth: 1, repairs: 0, spentUsd: 0, failures: [] };
    expect(continuationBlock({ ...base, depth: 3 }, facts, settings, true)).toMatch(/task limit/);
    expect(continuationBlock({ ...base, repairs: 3 }, facts, settings, true)).toMatch(/repair/);
    expect(continuationBlock({ ...base, failures: ['same', 'same'] }, facts, settings, true)).toMatch(/repeated twice/);
    expect(continuationBlock({ ...base, spentUsd: 1 }, facts, settings, true)).toMatch(/spending/);
    expect(continuationBlock(base, facts, settings, false)).toMatch(/could not be measured/);
    expect(nextCycle(handoff, facts, 0.2)).toMatchObject({ rootId: handoff.id, depth: 1, spentUsd: 0.2 });
  });
});

describe('Builder to Lead completion workflow', () => {
  it('prepares one bounded recovery proposal when evidence is missing, without accepting or dispatching it', async () => {
    const f = fixture(); f.records.get('builder-a')!.events = [];
    await processLeadCompletion('builder-a', handoff.id, f.port);
    expect(f.facts.state).toBe('not-checked'); expect(f.facts.missingChecks).toContain('npm test');
    expect(f.port.ask).toHaveBeenCalledTimes(2);
    expect(f.port.ask).toHaveBeenLastCalledWith(expect.stringContaining(LEAD_RECOVERY_PREFIX), local, 'lead', 1);
    const lead = f.records.get('lead-a')!;
    expect(lead.leadRecoveryTurnIds).toContain(lead.turns.at(-1)!.id);
    expect(f.port.dispatch).not.toHaveBeenCalled(); expect(f.facts.continuationNote).toContain('ways forward');
    await processLeadCompletion('builder-a', handoff.id, f.port); expect(f.port.ask).toHaveBeenCalledTimes(2);
  });
  it('does not use recovery planning to bypass an automatic task limit', async () => {
    const f = fixture(); f.records.get('builder-a')!.events = [];
    const lead = f.records.get('lead-a')!;
    f.records.set(lead.id, { ...lead, leadDeliverySettings: { ...deliverySettings(lead), maxTasks: 1 } });
    await processLeadCompletion('builder-a', handoff.id, f.port);
    expect(f.port.ask).toHaveBeenCalledTimes(1); expect(f.port.dispatch).not.toHaveBeenCalled();
  });
  it('does not make another automatic paid call to plan recovery when review pricing is unknown', async () => {
    const f = fixture(); f.port.leadTarget = () => cloud;
    vi.mocked(f.port.ask).mockImplementationOnce(async () => {
      const lead = f.records.get('lead-a')!;
      const next = { ...lead, turns: [{ id: 'bad-review', role: 'assistant' as const, text: 'Unclear review.', createdAt: time }], events: [{ schemaVersion: 1 as const, id: 'unpriced-review', type: 'cost.update' as const, taskId: lead.id, timestamp: time, provider: 'openai', model: 'unknown-alias', inputTokens: 100 }] };
      f.records.set(lead.id, next); return next;
    });
    await processLeadCompletion('builder-a', handoff.id, f.port);
    expect(f.port.ask).toHaveBeenCalledTimes(1); expect(f.port.dispatch).not.toHaveBeenCalled();
    expect(f.facts.state).toBe('not-checked'); expect(f.facts.continuationNote).toContain('paid usage could not be measured');
  });
  it('returns evidence to the local Lead and dispatches the next bounded task in Auto', async () => {
    const f = fixture(); await processLeadCompletion('builder-a', handoff.id, f.port);
    expect(f.facts.state).toBe('passed'); expect(f.facts.notified).toBe(true);
    expect(f.port.ask).toHaveBeenCalledTimes(2);
    expect(f.port.ask).toHaveBeenNthCalledWith(1, expect.stringContaining('LEAD_RESULT_REVIEW'), local, 'lead', 1);
    expect(f.port.dispatch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ depth: 1, rootId: handoff.id }));
    await processLeadCompletion('builder-a', handoff.id, f.port);
    expect(f.port.ask).toHaveBeenCalledTimes(2);
  });
  it.each(['discuss', 'ask'] as const)('prepares but never dispatches in %s mode', async (mode) => {
    const f = fixture(mode); await processLeadCompletion('builder-a', handoff.id, f.port);
    expect(f.port.ask).toHaveBeenCalledTimes(2); expect(f.port.dispatch).not.toHaveBeenCalled();
  });
  it('uses the explicitly enabled cloud reviewer without replacing the local Lead', async () => {
    const f = fixture(); const lead = f.records.get('lead-a')!;
    f.records.set(lead.id, { ...lead, leadDeliverySettings: { ...deliverySettings(lead), reviewer: cloud, autoReview: true } });
    await processLeadCompletion('builder-a', handoff.id, f.port);
    expect(f.port.ask).toHaveBeenCalledTimes(3);
    expect(f.port.ask).toHaveBeenNthCalledWith(2, expect.any(String), cloud, 'reviewer', 1);
    expect(f.port.ask).toHaveBeenNthCalledWith(3, expect.any(String), local, 'lead', 0.99);
    expect(f.facts.reviewedBy).toEqual(cloud);
  });
  it('does not call a configured cloud reviewer without opt-in', async () => {
    const f = fixture(); const lead = f.records.get('lead-a')!;
    f.records.set(lead.id, { ...lead, leadDeliverySettings: { ...deliverySettings(lead), reviewer: cloud } });
    await processLeadCompletion('builder-a', handoff.id, f.port);
    expect(vi.mocked(f.port.ask).mock.calls.every((call) => call[1] === local)).toBe(true);
  });
  it('lets the chosen reviewer supply a missing local verdict without treating the local reply as a pass', async () => {
    const f = fixture(); const lead = f.records.get('lead-a')!;
    f.records.set(lead.id, { ...lead, leadDeliverySettings: { ...deliverySettings(lead), reviewer: cloud, autoReview: true } });
    vi.mocked(f.port.ask).mockImplementationOnce(async () => ({ ...lead, turns: [{ id: 'summary', role: 'assistant', text: 'The result needs a formal review.', createdAt: time }] }));
    await processLeadCompletion('builder-a', handoff.id, f.port);
    expect(f.facts.state).toBe('passed'); expect(f.facts.reviewedBy).toEqual(cloud);
    expect(f.port.ask).toHaveBeenCalledTimes(3);
  });
  it('keeps stopped work and unreadable reviews open without starting another Builder', async () => {
    const stopped = fixture(); await processLeadCompletion('builder-a', handoff.id, stopped.port, { succeeded: false });
    expect(stopped.facts.state).toBe('needs-you'); expect(stopped.port.ask).not.toHaveBeenCalled();
    const bad = fixture(); vi.mocked(bad.port.ask).mockImplementationOnce(async () => ({ ...bad.records.get('lead-a')!, turns: [{ id: 'bad', role: 'assistant', text: 'Fine', createdAt: time }] }));
    await processLeadCompletion('builder-a', handoff.id, bad.port);
    expect(bad.facts.state).toBe('not-checked'); expect(bad.port.dispatch).not.toHaveBeenCalled();
  });
  it('records stale file evidence and stops on session changes or unavailable models', async () => {
    const stale = fixture(); stale.port.read = async () => ({ hash: 'edited', content: 'my edit' });
    await processLeadCompletion('builder-a', handoff.id, stale.port);
    expect(stale.facts.state).toBe('needs-you'); expect(stale.port.dispatch).not.toHaveBeenCalled();
    const session = fixture(); session.port.assertSession = () => { throw new Error('Changed project'); };
    await expect(processLeadCompletion('builder-a', handoff.id, session.port)).rejects.toThrow('Changed project');
    expect(session.facts.notified).toBe(true);
    const missing = fixture(); missing.port.unavailable = () => 'Local server offline';
    await expect(processLeadCompletion('builder-a', handoff.id, missing.port)).rejects.toThrow('Local server offline');
    expect(missing.port.ask).not.toHaveBeenCalled();
  });
  it('uses frozen file hashes and requires fresh evidence for older tasks', async () => {
    const edited = fixture(); edited.port.read = async () => ({ hash: 'user-edited', content: 'after' });
    await processLeadCompletion('builder-a', handoff.id, edited.port);
    expect(edited.facts.state).toBe('needs-you'); expect(edited.port.dispatch).not.toHaveBeenCalled();
    const old = fixture(); delete old.records.get('builder-a')!.turns[0]!.fileSnapshot;
    await processLeadCompletion('builder-a', handoff.id, old.port);
    expect(old.facts.state).toBe('not-checked'); expect(old.port.dispatch).not.toHaveBeenCalled();
  });
  it('reviews a complete large file when its frozen hash matches a capped checkpoint preview', async () => {
    const f = fixture(); const large = 'export const content = 1;\n'.repeat(10_000);
    f.port.checkpoint = async () => ({ ...checkpoint, files: [{ ...checkpoint.files[0]!, after: large.slice(0, 200_000) }] });
    f.port.read = async () => ({ hash: 'hash-a', content: large });
    await processLeadCompletion('builder-a', handoff.id, f.port);
    expect(f.facts.state).toBe('passed');
    expect(f.port.ask).toHaveBeenCalledWith(expect.stringContaining('Evidence omitted due to size'), local, 'lead', 1);
  });
  it('never starts further work if a reviewed file changes while waiting', async () => {
    const f = fixture();
    const ask = f.port.ask;
    f.port.ask = vi.fn(async (...args) => { const response = await ask(...args); f.port.read = async () => ({ hash: 'later-edit', content: 'after' }); return response; });
    await expect(processLeadCompletion('builder-a', handoff.id, f.port)).rejects.toThrow('reviewed file changed');
    expect(f.facts.state).toBe('needs-you'); expect(f.port.dispatch).not.toHaveBeenCalled();
  });
  it('stops paid continuation when actual usage is unknown and never silently substitutes a reviewer', async () => {
    const f = fixture(); const data = f.records.get('builder-a')!;
    data.leadHandoffs![0] = { ...handoff, builderTarget: cloud };
    await processLeadCompletion('builder-a', handoff.id, f.port);
    expect(f.port.dispatch).not.toHaveBeenCalled();
    expect(f.facts.continuationNote).toMatch(/could not be measured/);
    const unavailable = fixture(); const lead = unavailable.records.get('lead-a')!;
    unavailable.records.set(lead.id, { ...lead, leadDeliverySettings: { ...deliverySettings(lead), reviewer: cloud, autoReview: true } });
    unavailable.port.unavailable = (target) => target.api?.provider === 'openai' ? 'Reviewer offline' : null;
    await expect(processLeadCompletion('builder-a', handoff.id, unavailable.port)).rejects.toThrow('Reviewer offline');
    expect(unavailable.port.ask).toHaveBeenCalledTimes(1);
  });
  it('pauses an unpriced paid review as a saved task notice, not a failed Lead chat', async () => {
    const f = fixture();
    f.port.leadTarget = () => cloud;
    const data = f.records.get('builder-a')!;
    data.leadHandoffs![0] = { ...handoff, builderTarget: { execution: 'api', api: { provider: 'openai-compatible', model: 'gateway/coding' } } };
    data.events.push({ schemaVersion: 1, id: 'unpriced-usage', type: 'cost.update', taskId: data.id, timestamp: time, provider: 'openai-compatible', model: 'gateway/coding', inputTokens: 500, outputTokens: 100 });
    await expect(processLeadCompletion('builder-a', handoff.id, f.port)).resolves.toBeUndefined();
    expect(f.port.ask).not.toHaveBeenCalled(); expect(f.port.dispatch).not.toHaveBeenCalled();
    expect(f.facts.continuationNote).toContain('gateway/coding');
    expect(f.facts.continuationNote).toContain('Review once');
    expect(f.port.notice).not.toHaveBeenCalled();
    await processLeadCompletion('builder-a', handoff.id, f.port, { manualTarget: cloud });
    expect(f.port.ask).toHaveBeenCalledTimes(1);
    expect(f.facts.state).toBe('passed'); expect(f.port.dispatch).not.toHaveBeenCalled();
  });
  it('does not assume a CLI proxy run is free when its paid usage is unknown', async () => {
    const f = fixture(); f.records.get('builder-a')!.route = 'proxy';
    await processLeadCompletion('builder-a', handoff.id, f.port);
    expect(f.port.dispatch).not.toHaveBeenCalled();
    expect(f.facts.continuationNote).toMatch(/could not be measured/);
  });
});
