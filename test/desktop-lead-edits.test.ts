import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { conversationRecordV1Schema, boardCardSchema, studioBoardSchema, parseLeadEditSuggestion, type ConversationRecord } from '@kai/contracts';
import { prepareLeadEdit, decideLeadEdit, type LeadEditStore } from '../apps/desktop/src/main/lead-edits';
import { readProjectFile } from '../apps/desktop/src/main/project-files';
import { leadDevelopmentPrompt, stripLeadEdit } from '../apps/desktop/src/renderer/src/components/lead-edit-prompt';
import { runnableLeadTask } from '../apps/desktop/src/renderer/src/components/lead-handoff';

const suggestion = (before = 'return true;', after = 'return false;', file = 'src/form.ts') => `## Correction\nA small agreed fix.\nLEAD EDIT:\n${JSON.stringify({ path: file, before, after, reason: 'Correct the existing implementation.' })}\nEND LEAD EDIT\nBUILDER TASK:\nNone`;
async function fixture(text = suggestion()) {
  const root = await mkdtemp(path.join(tmpdir(), 'kai-lead-edits-'));
  await mkdir(path.join(root, 'src')); await mkdir(path.join(root, '.kai/spec'), { recursive: true });
  await writeFile(path.join(root, 'src/form.ts'), 'export function valid() { return true; }\n');
  let lead = conversationRecordV1Schema.parse({ schemaVersion: 1, id: 'lead-a', projectId: 'project-a', title: 'Lead', createdAt: '2026-11-28T00:00:00Z', updatedAt: '2026-11-28T00:00:00Z', archived: false, unread: false, activeAgent: null, route: null, autonomy: 'plan', origin: { kind: 'lead', projectId: 'project-a' }, leadAccess: 'ask', turns: [{ id: 'reply-a', role: 'assistant', text, createdAt: '2026-11-28T00:00:00Z' }], events: [] });
  const records: ConversationRecord[] = [];
  const store: LeadEditStore = { get: async () => structuredClone(lead), save: async (record) => { lead = conversationRecordV1Schema.parse(record); }, list: async () => [lead, ...records], root: async () => root };
  const prepare = () => prepareLeadEdit(store, lead.id, 'reply-a');
  const decide = (action: 'approve' | 'automatic' | 'reject' | 'refresh') => decideLeadEdit(store, lead.id, lead.leadEditProposals![0]!.id, action);
  return { root, store, records, get lead() { return lead; }, setLead: (patch: Partial<ConversationRecord>) => { lead = { ...lead, ...patch }; }, prepare, decide };
}
async function evidence(data: Awaited<ReturnType<typeof fixture>>, goal = 'Validate form input.') {
  const file = await readProjectFile(data.root, 'src/form.ts');
  data.records.push({ ...data.lead, id: 'builder-a', origin: undefined, leadHandoffs: [{ id: 'task-a', leadConversationId: 'lead-a', task: `### Goal\n${goal}\n### Done checks\n- Validates input.`, createdAt: '2026-11-28T00:00:00Z', userTurnCount: 0, completion: { resultTurnId: 'answer-a', state: 'passed', reason: 'Checks and acceptance passed.', recordedAt: '2026-11-28T00:00:00Z', checks: [{ command: 'npm test', exitCode: 0, output: 'passed', timestamp: '' }], missingChecks: [], criteria: ['Validates input.'], files: [{ path: file.path, hash: file.hash }] } }] });
}

describe('Lead edit access and proposals', () => {
  it('keeps legacy conversations read-only without changing saved handoff settings', async () => {
    const data = await fixture(); data.setLead({ leadAccess: undefined, leadHandoffMode: 'auto' });
    expect(conversationRecordV1Schema.parse(data.lead).leadAccess).toBeUndefined();
    await expect(data.prepare()).rejects.toThrow('Read-only');
    expect(data.lead.leadHandoffMode).toBe('auto');
  });
  it('previews without writing, applies only the exact approved correction, persists and never starts Builder', async () => {
    const data = await fixture(); await data.prepare();
    expect(await readFile(path.join(data.root, 'src/form.ts'), 'utf8')).toContain('return true;');
    expect(data.lead.leadEditProposals![0]!.original).toContain('export function');
    await data.decide('automatic'); expect(data.lead.leadEditProposals![0]!.state).toBe('pending');
    await data.decide('approve');
    expect(await readFile(path.join(data.root, 'src/form.ts'), 'utf8')).toContain('return false;');
    expect(data.lead.leadEditProposals![0]!.state).toBe('applied');
    expect(conversationRecordV1Schema.parse(JSON.parse(JSON.stringify(data.lead))).leadEditProposals![0]!.state).toBe('applied');
    await data.prepare(); await data.decide('approve'); expect(data.lead.leadEditProposals).toHaveLength(1);
    expect(data.lead.leadDispatchedTurnIds).toBeUndefined();
  });
  it('declines without writing and respects a later change to read-only', async () => {
    const data = await fixture(); await data.prepare(); await data.decide('reject');
    expect(data.lead.leadEditProposals![0]!.state).toBe('rejected');
    const other = await fixture(); await other.prepare(); other.setLead({ leadAccess: 'read-only' });
    await expect(other.decide('approve')).rejects.toThrow('Read-only');
    expect(await readFile(path.join(other.root, 'src/form.ts'), 'utf8')).toContain('return true;');
    await other.decide('reject'); expect(other.lead.leadEditProposals![0]!.state).toBe('rejected');
  });
  it('shows changed-file evidence, refreshes without overwriting manual changes and requires approval again', async () => {
    const data = await fixture(); await data.prepare();
    await writeFile(path.join(data.root, 'src/form.ts'), '// my edit\nexport function valid() { return true; }\n');
    await data.decide('approve'); expect(data.lead.leadEditProposals![0]!.state).toBe('conflict');
    expect(data.lead.leadEditProposals![0]!.conflictContent).toContain('// my edit');
    await data.decide('refresh'); expect(data.lead.leadEditProposals![0]!.state).toBe('pending');
    await data.decide('automatic'); expect(data.lead.leadEditProposals![0]!.state).toBe('pending');
    await data.decide('approve'); expect(await readFile(path.join(data.root, 'src/form.ts'), 'utf8')).toBe('// my edit\nexport function valid() { return false; }\n');
  });
  it('refuses refresh if the proposed original was edited, instead of guessing', async () => {
    const data = await fixture(); await data.prepare(); await writeFile(path.join(data.root, 'src/form.ts'), 'export function valid() { return 42; }');
    await data.decide('approve'); await expect(data.decide('refresh')).rejects.toThrow('match exactly once');
    expect(await readFile(path.join(data.root, 'src/form.ts'), 'utf8')).toContain('return 42;');
  });
  it.each(['../outside.ts', 'C:/outside.ts', '.env.json', '.git/config.json', 'src/credentials.json', '.kai/spec/status.md'])('refuses protected or external path %s', async (file) => {
    const data = await fixture(suggestion('a', 'b', file)); await expect(data.prepare()).rejects.toThrow();
  });
  it('rejects missing files, ambiguous text, large corrections and malformed or duplicate proposals', async () => {
    const data = await fixture(suggestion('', 'new file', 'src/new.ts')); await expect(data.prepare()).rejects.toThrow('existing files');
    const ambiguous = await fixture(suggestion('true', 'false')); await writeFile(path.join(ambiguous.root, 'src/form.ts'), 'true true'); await expect(ambiguous.prepare()).rejects.toThrow('exactly once');
    const large = await fixture(suggestion('return true;', Array(201).fill('line').join('\n'))); await expect(large.prepare()).rejects.toThrow('too large');
    expect(() => parseLeadEditSuggestion(suggestion() + '\n' + suggestion())).toThrow('one small');
    expect(() => parseLeadEditSuggestion('LEAD EDIT:\nwrong\nEND LEAD EDIT')).toThrow('unreadable');
  });
  it('does not accept edit proposals from reviewer replies or another conversation role', async () => {
    const data = await fixture(); data.setLead({ leadReviewTurnIds: ['reply-a'] }); await expect(data.prepare()).rejects.toThrow('saved Lead');
    data.setLead({ leadReviewTurnIds: [], origin: undefined }); await expect(data.prepare()).rejects.toThrow('owning project');
  });
  it('rechecks access and project ownership after waiting before a write', async () => {
    const data = await fixture(); await data.prepare();
    let reads = 0;
    const originalGet = data.store.get;
    data.store.get = async (id) => { if (++reads === 2) data.setLead({ leadAccess: 'read-only' }); return originalGet(id); };
    await expect(data.decide('approve')).rejects.toThrow('Read-only');
    expect(await readFile(path.join(data.root, 'src/form.ts'), 'utf8')).toContain('return true;');
    const other = await fixture(); await other.prepare();
    let roots = 0; other.store.root = async () => { if (++roots === 2) throw new Error('The open project changed.'); return other.root; };
    await expect(other.decide('approve')).rejects.toThrow('project changed');
    expect(await readFile(path.join(other.root, 'src/form.ts'), 'utf8')).toContain('return true;');
  });
  it('gives the development Lead the selected edit workflow without changing tutor identity', () => {
    const prompt = leadDevelopmentPrompt('Correct this.', 'senior-dev', 'brief', 'decisions', 'ask');
    expect(prompt).toContain('LEAD EDIT:'); expect(prompt).not.toContain('Lead is always read-only');
    expect(prompt).toContain('verification baselines'); expect(prompt).toContain('unreachable endpoint');
    expect(stripLeadEdit(suggestion())).not.toContain('"before"');
    expect(leadDevelopmentPrompt('Hi', 'senior-dev', 'brief', 'decisions')).toContain('Read-only');
  });
  it('never sends an edit proposal and a duplicate Builder task together', async () => {
    const data = await fixture(suggestion().replace('BUILDER TASK:\nNone', 'BUILDER TASK:\n### Goal\nChange\nEND BUILDER TASK'));
    expect(runnableLeadTask(data.lead, 'reply-a')).toBeNull();
  });
});

describe('authoritative plan maintenance', () => {
  it('automatically checks only an existing step with matching Passed evidence that is still current', async () => {
    const before = '- [ ] Validate form input.', after = '- [x] Validate form input.';
    const data = await fixture(suggestion(before, after, '.kai/spec/plan.md')); data.setLead({ leadAccess: 'plan' });
    await writeFile(path.join(data.root, '.kai/spec/plan.md'), '# Plan\n' + before + '\n- [x] Earlier finished task.\n'); await evidence(data);
    await data.prepare(); await data.decide('automatic');
    expect(data.lead.leadEditProposals![0]!.automatic).toBe(true);
    expect(await readFile(path.join(data.root, '.kai/spec/plan.md'), 'utf8')).toContain('- [x] Earlier finished task.');
  });
  it.each(['missing', 'stale', 'failed', 'other-project'])('requires approval when completion evidence is %s', async (kind) => {
    const data = await fixture(suggestion('- [ ] Validate form input.', '- [x] Validate form input.', '.kai/spec/plan.md')); data.setLead({ leadAccess: 'plan' });
    await writeFile(path.join(data.root, '.kai/spec/plan.md'), '- [ ] Validate form input.');
    if (kind !== 'missing') await evidence(data);
    if (kind === 'stale') await writeFile(path.join(data.root, 'src/form.ts'), 'changed');
    if (kind === 'failed') data.records[0]!.leadHandoffs![0]!.completion!.state = 'needs-repair';
    if (kind === 'other-project') data.records[0]!.projectId = 'project-b';
    await data.prepare(); await data.decide('automatic'); expect(data.lead.leadEditProposals![0]!.state).toBe('pending');
  });
  it.each([
    ['- [x] Validate form input.', '- [ ] Validate form input.'],
    ['- [ ] Validate form input.', '- [ ] Add a new goal.'],
  ])('keeps reopening finished steps and scope changes behind exact approval', async (before, after) => {
    const data = await fixture(suggestion(before, after, '.kai/spec/plan.md')); data.setLead({ leadAccess: 'plan' });
    await writeFile(path.join(data.root, '.kai/spec/plan.md'), before); await evidence(data); await data.prepare(); await data.decide('automatic');
    expect(data.lead.leadEditProposals![0]!.state).toBe('pending');
    await data.decide('approve'); expect(await readFile(path.join(data.root, '.kai/spec/plan.md'), 'utf8')).toBe(after);
  });
  it('uses Studio as the only plan, preserves cards and never manufactures acceptance gates', async () => {
    const card = boardCardSchema.parse({ id: 'card-a', title: 'Validate form input.', kind: 'chore', createdAt: 'now', updatedAt: 'now' });
    const board = studioBoardSchema.parse({ schemaVersion: 1, cards: [card] });
    const data = await fixture(suggestion('"status": "backlog"', '"status": "done"', '.KAI/spec/BOARD.json'));
    await writeFile(path.join(data.root, '.kai/spec/board.json'), JSON.stringify(board, null, 2));
    await expect(data.prepare()).rejects.toThrow('review and check gates');
    data.setLead({ turns: [{ ...data.lead.turns[0]!, text: suggestion('a', 'b', '.kai/spec/plan.md') }] });
    await expect(data.prepare()).rejects.toThrow('authoritative');
    data.setLead({ turns: [{ ...data.lead.turns[0]!, text: suggestion('"notes": ""', '"notes": "Clarified next step."', '.kai/spec/board.json') }] });
    await data.prepare(); await data.decide('approve');
    const updated = JSON.parse(await readFile(path.join(data.root, '.kai/spec/board.json'), 'utf8'));
    expect(updated.revision).toBe(1); expect(updated.cards[0].status).toBe('backlog');
    expect(updated.cards[0].notes).toBe('Clarified next step.');
  });
});
