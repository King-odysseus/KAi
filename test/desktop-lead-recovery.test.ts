import { describe, expect, it } from 'vitest';
import { conversationRecordV1Schema, type ConversationRecord } from '@kai/contracts';
import { isLeadRecoveryRequest, leadRecoveryPrompt, markLeadRecoveryReply, LEAD_RECOVERY_PREFIX, LEAD_RECOVERY_RULES } from '../apps/desktop/src/renderer/src/components/lead-recovery';
import { leadDevelopmentPrompt } from '../apps/desktop/src/renderer/src/components/lead-edit-prompt';
import { buildLeadRequestText } from '../apps/desktop/src/renderer/src/components/lead-project-context';
import { agentRunRequestSchema } from '@kai/contracts';

const stamp = '2026-11-28T00:00:00Z';
function record(): ConversationRecord {
  return conversationRecordV1Schema.parse({ schemaVersion: 1, id: 'builder-a', projectId: 'project-a', title: 'Builder', createdAt: stamp, updatedAt: stamp, archived: false, unread: false, activeAgent: null, route: null, autonomy: 'ask', events: [], turns: [{ id: 'ask', role: 'user', text: 'Collect evidence.', createdAt: stamp }, { id: 'answer', role: 'assistant', text: 'Historical report claims a pass.', createdAt: stamp }], leadHandoffs: [{ id: 'handoff-a', leadConversationId: 'lead-a', task: 'Collect evidence.', userTurnCount: 0, createdAt: stamp, completion: { resultTurnId: 'answer', state: 'not-checked', reason: 'No current check evidence.', checks: [], missingChecks: ['npm test'], criteria: [], files: [], recordedAt: stamp } }] });
}
describe('Lead recovery planning', () => {
  it('recognises recovery requests while leaving ordinary implementation requests alone', () => {
    expect(isLeadRecoveryRequest('The project is stuck. What are my options?')).toBe(true);
    expect(isLeadRecoveryRequest('Explain ways forward.')).toBe(true);
    expect(isLeadRecoveryRequest(LEAD_RECOVERY_PREFIX)).toBe(true);
    expect(isLeadRecoveryRequest('Add input validation to this form.')).toBe(false);
  });
  it('asks for concrete recovery options, dependencies and evidence without accepting failed gates', () => {
    const builder = record(), handoff = builder.leadHandoffs![0]!;
    const prompt = leadRecoveryPrompt(builder, handoff);
    expect(prompt.startsWith(LEAD_RECOVERY_PREFIX)).toBe(true);
    expect(prompt).toContain('independent step'); expect(prompt).toContain('exact evidence or diff');
    expect(prompt).toContain('Historical report claims a pass.');
    expect(prompt).toContain('No current check evidence.');
    expect(prompt).toContain('Checkpoint diff unavailable');
    expect(prompt).toContain('explicit approval'); expect(prompt).toContain('not proof that software is not installed');
    expect(handoff.completion!.state).toBe('not-checked');
  });
  it('keeps recovery evidence whole within the real agent request budget', () => {
    const builder = record(); builder.turns[1]!.text = '## Large old report\n' + 'old report line\n'.repeat(1800);
    const question = leadRecoveryPrompt(builder, builder.leadHandoffs![0]!);
    expect(question).toContain('Evidence omitted due to size');
    const request = buildLeadRequestText({ question, specFiles: [{ path: '.kai/spec/plan.md', content: '# Plan\n- [ ] Collect evidence.\n' }], includeProjectOrientation: false, style: 'senior-dev', detail: 'brief', questions: 'decisions', leadCoachPrompt: leadDevelopmentPrompt });
    expect(request.displayText).toBe(question);
    expect(agentRunRequestSchema.safeParse({ conversationId: 'lead-a', prompt: request.prompt, displayText: question, agent: 'codex', route: 'direct', execution: 'api', autonomy: 'plan' }).success).toBe(true);
  });
  it('allows explicitly requested recovery after a stopped run without inventing completed evidence', () => {
    const builder = record(); builder.turns.pop();
    expect(leadRecoveryPrompt(builder, builder.leadHandoffs![0]!)).toContain('No completed Builder reply is available');
    expect(leadRecoveryPrompt(builder, builder.leadHandoffs![0]!)).toContain('Collect evidence.');
  });
  it('stores recovery reply identity without changing the chosen handoff or history', () => {
    const lead = { ...record(), id: 'lead-a', origin: { kind: 'lead' as const, projectId: 'project-a' }, leadHandoffMode: 'auto' as const };
    const saved = conversationRecordV1Schema.parse(markLeadRecoveryReply(lead));
    expect(saved.leadRecoveryTurnIds).toEqual(['answer']); expect(saved.leadHandoffMode).toBe('auto');
    expect(saved.turns).toEqual(lead.turns);
    expect(markLeadRecoveryReply(saved).leadRecoveryTurnIds).toEqual(['answer']);
  });
  it.each(['read-only', 'ask', 'plan'] as const)('allows planning around blockers under %s access without authorising edits or gate bypasses', (access) => {
    const prompt = leadDevelopmentPrompt('The project is blocked.', 'senior-dev', 'brief', 'decisions', access);
    expect(prompt).toContain(LEAD_RECOVERY_RULES);
    expect(prompt).toContain('do not weaken tests'); expect(prompt).toContain('All existing edit approvals');
  });
});
