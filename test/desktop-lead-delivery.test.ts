import { describe, expect, it } from 'vitest';
import { conversationRecordV1Schema, verificationRunSchema, verificationStatuses, verificationCaveat, type ConversationRecord, type PersistedEvent } from '@kai/contracts';
import { handoffResult, leadChatTitle, leadResultReview, type LeadHandoff } from '../apps/desktop/src/renderer/src/components/lead-delivery';

const handoff: LeadHandoff = { id: 'handoff-a', leadConversationId: 'lead-a', task: 'Add a form', createdAt: '2026-11-27T10:00:00.000Z', userTurnCount: 0 };
function builder(output = '', exitCode = 0): ConversationRecord {
 const conversation: ConversationRecord = { schemaVersion: 1, id: 'builder-a', projectId: 'project-a', title: 'Form', createdAt: handoff.createdAt, updatedAt: '2026-11-27T10:03:00.000Z', archived: false, unread: false, activeAgent: null, route: null, autonomy: null, turns: [
 { id: 'u', role: 'user', text: handoff.task, createdAt: handoff.createdAt },
 { id: 'a', role: 'assistant', text: 'I changed the form.', createdAt: '2026-11-27T10:02:00.000Z' }], events: [], leadHandoffs: [handoff] };
 if (output) conversation.events.push({ schemaVersion: 1, id: 'e', taskId: 't', type: 'tool.call', timestamp: '2026-11-27T10:01:00.000Z', name: 'run_command', status: exitCode ? 'failed' : 'completed', input: { command: 'npx tsc --noEmit' }, output: { output, exitCode } } as PersistedEvent);
 return conversation;
}
describe('Lead task delivery and evidence', () => {
 it('includes the linked git command output even when the command is not a test or build check', () => {
   const run = builder('M\tsrc/form.ts\nA\tsrc/helper.ts');
   const event = run.events[0]!;
   if (event.type === 'tool.call') event.input = { command: 'git diff --name-status base..HEAD -- src' };
   const text = leadResultReview(run, handoff, null);
   expect(text).toContain('git diff --name-status');
   expect(text).toContain('M\tsrc/form.ts\nA\tsrc/helper.ts');
   expect(handoffResult(run, handoff)?.status).toBe('Not checked');
 });
 it('keeps links across save/load and accepts old conversations without them', () => {
   expect(conversationRecordV1Schema.parse(JSON.parse(JSON.stringify(builder()))).leadHandoffs).toEqual([handoff]);
   const older = builder(); delete older.leadHandoffs;
   expect(conversationRecordV1Schema.parse(older).leadHandoffs).toBeUndefined();
 });
 it('does not attribute an unrelated reply or old task to a new draft', () => {
   expect(handoffResult(builder(), { ...handoff, userTurnCount: 2 })).toBeNull();
   expect(handoffResult(builder(), { ...handoff, task: 'Other task' })).toBeNull();
 });
 it('uses the real check outcome, never Builder prose, for the status', () => {
   expect(handoffResult(builder(), handoff)?.status).toBe('Not checked');
   expect(handoffResult(builder('No type errors'), handoff)?.status).toBe('Checked');
   expect(handoffResult(builder('Type error', 1), handoff)?.status).toBe('Failed');
   expect(handoffResult(builder('mock tsc: success'), handoff)?.status).toBe('Not checked');
 });
 it('keeps mock evidence unverified in older stored records', () => {
   const record = verificationRunSchema.parse({ id: 'check', projectId: 'project-a', command: 'npx tsc', source: 'agent', exitCode: 0, passed: true, startedAt: handoff.createdAt, durationMs: 1, head: null, files: [{ path: 'src/form.ts', hash: 'hash' }], testsPassed: null, testsFailed: null, outputTail: 'mock tsc success' });
   expect(record.passed).toBe(false);
   expect(record.unverifiedReason).toContain('mock');
   expect(verificationStatuses(record, record.files)[0]?.status).toBe('unverified');
   expect(verificationCaveat('npm test', '12 tests passed including mock service tests')).toBeUndefined();
 });
 it('reviews complete changes and check evidence and names unavailable diffs', () => {
   const text = leadResultReview(builder('No type errors'), handoff, { conversationId: 'builder-a', turnId: 'a', gitAvailable: true, files: [{ path: 'src/form.ts', added: 1, removed: 1, before: 'old', after: 'new', binary: false }] });
   expect(text).toContain('Before:\nold\n\nAfter:\nnew');
   expect(text).toContain('npx tsc --noEmit');
   expect(leadResultReview(builder(), handoff, null)).toContain('Checkpoint diff unavailable');
 });
 it('omits oversized complete evidence rather than cutting code', () => {
   const text = leadResultReview(builder(), handoff, { conversationId: 'builder-a', turnId: 'a', gitAvailable: true, files: [{ path: 'large.ts', added: 1, removed: 0, before: '', after: 'x'.repeat(30_000), binary: false }] });
   expect(text).toContain('Evidence omitted due to size: Changes: large.ts');
   expect(text.length).toBeLessThan(12_000);
 });
 it('names chats from the question without modifying the saved question', () => {
   expect(leadChatTitle('How should form validation work?\nMore context')).toBe('How should form validation work?');
 });
});
