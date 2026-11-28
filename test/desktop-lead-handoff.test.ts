import { describe, expect, it, vi } from 'vitest';
import { conversationRecordV1Schema, type ConversationRecord } from '@kai/contracts';
import { dispatchLeadTask, leadHandoffInstructions, leadHandoffMode, runnableLeadTask, type LeadDeliveryPort } from '../apps/desktop/src/renderer/src/components/lead-handoff';

const task = '### Goal\nAdd a form.\n### Files\n- src/form.ts\n### Done checks\n- Validate input.\n### Check command\nnpm test';
function record(id = 'lead-a'): ConversationRecord {
  return { schemaVersion: 1, id, projectId: 'project-a', title: 'Lead', createdAt: '2026-11-27T00:00:00.000Z', updatedAt: '2026-11-27T00:00:00.000Z', archived: false, unread: false, activeAgent: null, route: null, autonomy: null, origin: { kind: 'lead', projectId: 'project-a' }, turns: [{ id: 'reply-a', role: 'assistant', text: `Recommendation.\nBUILDER TASK:\n${task}\nEND BUILDER TASK`, createdAt: '2026-11-27T00:00:00.000Z' }], events: [] };
}
function fixture(mode: 'discuss' | 'ask' | 'auto' = 'ask') {
  let lead = { ...record(), leadHandoffMode: mode };
  let builder = { ...record('builder-a'), turns: [], origin: undefined, autonomy: 'ask' as const } as ConversationRecord;
  const start = vi.fn(async () => undefined);
  const save = vi.fn(async (item: ConversationRecord) => {
    const saved = conversationRecordV1Schema.parse(JSON.parse(JSON.stringify(item)));
    if (saved.id === lead.id) lead = saved as typeof lead;
    else builder = saved;
    return saved;
  });
  const port: LeadDeliveryPort = { loadLead: async () => lead, assertCurrent: vi.fn(), getBuilder: async () => builder, save, start, id: () => 'handoff-a', now: () => lead.updatedAt };
  return { port, start, save, get lead() { return lead; }, set lead(value) { lead = value; }, get builder() { return builder; }, set builder(value) { builder = value; } };
}

describe('Lead handoff permissions', () => {
  it('defaults old chats to Ask first and saves all three modes without changing access or history', () => {
    expect(leadHandoffMode(record())).toBe('ask');
    for (const mode of ['discuss', 'ask', 'auto'] as const) {
      const input = { ...record(), autonomy: 'plan', leadHandoffMode: mode, leadDispatchedTurnIds: ['old-reply'] };
      const saved = conversationRecordV1Schema.parse(JSON.parse(JSON.stringify(input)));
      expect(leadHandoffMode(saved)).toBe(mode);
      expect(saved.autonomy).toBe('plan');
      expect(saved.turns).toEqual(input.turns);
      expect(saved.leadDispatchedTurnIds).toEqual(['old-reply']);
    }
  });
  it.each(['discuss', 'ask'] as const)('never auto-starts in %s mode', async (mode) => {
    const f = fixture(mode);
    await expect(dispatchLeadTask('reply-a', true, f.port)).rejects.toThrow('off');
    expect(f.save).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
  });
  it('starts the exact approved task through Builder and preserves Builder permissions', async () => {
    const f = fixture();
    await dispatchLeadTask('reply-a', false, f.port);
    expect(f.start).toHaveBeenCalledWith(expect.objectContaining({ id: 'builder-a', autonomy: 'ask' }), task);
    expect(f.builder.leadHandoffs?.[0]).toMatchObject({ leadConversationId: 'lead-a', sourceTurnId: 'reply-a', delivery: 'run', task });
    expect(f.lead.turns).toEqual(record().turns);
    expect(f.lead.leadDispatchedTurnIds).toEqual(['reply-a']);
  });
  it('requires explicit approval for a recovery task even in Auto, without blocking that approved next action', async () => {
    const f = fixture('auto'); f.lead = { ...f.lead, leadRecoveryTurnIds: ['reply-a'] };
    await expect(dispatchLeadTask('reply-a', true, f.port)).rejects.toThrow('approve this recovery');
    expect(f.start).not.toHaveBeenCalled();
    await dispatchLeadTask('reply-a', false, f.port);
    expect(f.start).toHaveBeenCalledTimes(1);
  });
  it('auto-dispatches a new completed task once, including after save/load', async () => {
    const f = fixture('auto');
    await dispatchLeadTask('reply-a', true, f.port);
    await expect(dispatchLeadTask('reply-a', true, f.port)).rejects.toThrow('already sent');
    expect(f.start).toHaveBeenCalledTimes(1);
  });
  it.each(['missing end', 'question', 'none', 'two tasks', 'idea proposal', 'unfinished code'])('rejects %s replies before writing or starting', async (kind) => {
    const f = fixture('auto');
    const turn = f.lead.turns[0]!;
    if (kind === 'missing end') turn.text = `BUILDER TASK:\n${task}`;
    if (kind === 'question') turn.awaitingAnswer = true;
    if (kind === 'none') turn.text = 'BUILDER TASK:\nNone\nEND BUILDER TASK';
    if (kind === 'two tasks') turn.text += '\nBUILDER TASK:\nSomething else\nEND BUILDER TASK';
    if (kind === 'idea proposal') turn.text = 'LEAD_IDEA_PROPOSAL\n{}\nEND_LEAD_IDEA_PROPOSAL\n' + turn.text;
    if (kind === 'unfinished code') turn.text = 'BUILDER TASK:\n```ts\nconst x = 1;\nEND BUILDER TASK';
    expect(runnableLeadTask(f.lead, turn.id)).toBeNull();
    await expect(dispatchLeadTask(turn.id, true, f.port)).rejects.toThrow('complete');
    expect(f.save).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
  });
  it('keeps Lead read-only and separate idea approvals in every mode prompt', () => {
    for (const mode of ['discuss', 'ask', 'auto'] as const) {
      expect(leadHandoffInstructions(mode)).toContain('never grants you editing');
      expect(leadHandoffInstructions(mode)).toContain('separate approval');
      expect(leadHandoffInstructions(mode)).toContain('change the user requested or agreed to');
    }
  });
  it('rejects an old reply for automatic delivery', async () => {
    const f = fixture('auto');
    f.lead.turns.push({ ...f.lead.turns[0]!, id: 'follow-up', role: 'user', text: 'Wait' });
    await expect(dispatchLeadTask('reply-a', true, f.port)).rejects.toThrow('newly completed');
    expect(f.start).not.toHaveBeenCalled();
  });
  it('rechecks mode and task after waiting', async () => {
    const f = fixture('auto');
    f.port.getBuilder = async () => { f.lead = { ...f.lead, leadHandoffMode: 'discuss' }; return f.builder; };
    await expect(dispatchLeadTask('reply-a', true, f.port)).rejects.toThrow('changed');
    expect(f.save).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
  });
  it.each(['project', 'lead', 'guided'])('does not route into an unrelated %s conversation', async (kind) => {
    const f = fixture('auto');
    f.builder = { ...f.builder, ...(kind === 'project' ? { projectId: 'project-b' } : kind === 'lead' ? { origin: record().origin } : { guidedBuild: { enabled: true } as ConversationRecord['guidedBuild'] }) };
    await expect(dispatchLeadTask('reply-a', true, f.port)).rejects.toThrow('development Builder');
    expect(f.start).not.toHaveBeenCalled();
  });
  it('stops when the session changes or Builder is off/busy', async () => {
    const f = fixture('auto');
    f.port.assertCurrent = () => { throw new Error('Builder is off or busy'); };
    await expect(dispatchLeadTask('reply-a', true, f.port)).rejects.toThrow('off or busy');
    expect(f.save).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
  });
  it('keeps a failed Builder linked without automatically retrying it', async () => {
    const f = fixture('auto');
    f.start.mockRejectedValueOnce(new Error('Provider unavailable'));
    await expect(dispatchLeadTask('reply-a', true, f.port)).rejects.toThrow('Provider unavailable');
    await expect(dispatchLeadTask('reply-a', true, f.port)).rejects.toThrow('already sent');
    expect(f.start).toHaveBeenCalledTimes(1);
  });
});
