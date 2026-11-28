import { describe, expect, it, vi } from 'vitest';
import { agentRunRequestSchema, type ConversationRecord } from '@kai/contracts';
import { loadLeadBuilderEvidence, packLeadBuilderEvidence } from '../apps/desktop/src/renderer/src/components/lead-builder-evidence';
import { buildLeadRequestText } from '../apps/desktop/src/renderer/src/components/lead-project-context';
import { leadDevelopmentPrompt } from '../apps/desktop/src/renderer/src/components/lead-edit-prompt';

function builder(): ConversationRecord {
  return { schemaVersion: 1, id: 'builder-a', projectId: 'project-a', title: 'Builder', createdAt: '2026-11-28T00:00:00Z', updatedAt: '2026-11-28T00:03:00Z', archived: false, unread: false, activeAgent: null, route: null, autonomy: 'ask', turns: [{ id: 'ask-a', role: 'user', text: 'List current changes.', createdAt: '2026-11-28T00:00:00Z' }, { id: 'reply-a', role: 'assistant', text: 'The actual changed files are listed below. src/form.ts is modified; src/helper.ts was added.', createdAt: '2026-11-28T00:02:00Z' }], leadHandoffs: [{ id: 'handoff-a', leadConversationId: 'lead-a', task: 'List current changes.', createdAt: '2026-11-28T00:00:00Z', userTurnCount: 0 }], events: [{ schemaVersion: 1, id: 'git-a', taskId: 'builder-a', type: 'tool.call', name: 'run_command', status: 'completed', timestamp: '2026-11-28T00:01:00Z', input: { command: 'git diff --name-status base..HEAD -- src' }, output: { output: 'M\tsrc/form.ts\nA\tsrc/helper.ts', exitCode: 0 } }] };
}
describe('actual Builder evidence on Lead follow-ups', () => {
  it('reloads the complete linked run after restart and sends actual reply and git output on continue', async () => {
    const run = builder(), original = structuredClone(run);
    const summary = { ...run, __summary: true, turns: [], events: [] };
    const load = vi.fn(async () => run);
    const context = await loadLeadBuilderEvidence([summary], 'lead-a', 'project-a', load);
    const text = buildLeadRequestText({ question: 'continue', builderEvidence: context.sections, specFiles: [], includeProjectOrientation: false, style: 'senior-dev', detail: 'brief', questions: 'decisions', leadCoachPrompt: leadDevelopmentPrompt });
    expect(load).toHaveBeenCalledWith('builder-a');
    expect(text.prompt).toContain(run.turns[1]!.text);
    expect(text.prompt).toContain('M\tsrc/form.ts\nA\tsrc/helper.ts');
    expect(text.prompt).toContain('git diff --name-status');
    expect(text.prompt).toContain('2026-11-28T00:01:00Z');
    expect(text.prompt).toContain('not a fresh command run');
    expect(text.included).toContain('Builder builder-a / task handoff-a — actual reply');
    expect(text.displayText).toBe('continue'); expect(run).toEqual(original);
  });
  it('loads only matching project/chat links and refuses mismatched or incomplete returned records', async () => {
    const run = builder(), otherProject = { ...builder(), id: 'outside', projectId: 'project-b' }, otherChat = { ...builder(), id: 'other-chat', leadHandoffs: [{ ...builder().leadHandoffs![0]!, leadConversationId: 'lead-b' }] };
    const load = vi.fn(async () => ({ ...run, projectId: 'project-b' }));
    const context = await loadLeadBuilderEvidence([run, otherProject, otherChat], 'lead-a', 'project-a', load);
    expect(load).toHaveBeenCalledTimes(1); expect(load).toHaveBeenCalledWith('builder-a');
    expect(context.sections).toEqual([]); expect(context.notes.join(' ')).toContain('could not be loaded completely');
    const partial = await loadLeadBuilderEvidence([run], 'lead-a', 'project-a', async () => ({ ...run, __summary: true }));
    expect(partial.sections).toEqual([]);
  });
  it('uses only command evidence from the linked completed request and retains unknown exit codes', async () => {
    const run = builder(), sample = run.events[0]!;
    run.events.push({ ...sample, id: 'old', timestamp: '2026-11-27T00:00:00Z', output: 'unrelated old output' }, { ...sample, id: 'future', timestamp: '2026-11-29T00:00:00Z', output: 'unrelated later output' }, { ...sample, id: 'cli', type: 'tool.call', name: 'Bash', status: 'completed', input: { command: 'git status --short' }, output: 'M src/form.ts' });
    const context = await loadLeadBuilderEvidence([run], 'lead-a', 'project-a', async () => run);
    const text = context.sections.map((section) => section.text).join('\n');
    expect(text).not.toContain('unrelated old'); expect(text).not.toContain('unrelated later');
    expect(text).toContain('Exit code: unknown'); expect(text).toContain('M src/form.ts');
  });
  it('names unavailable or unfinished output instead of inventing it', async () => {
    const run = builder(); run.turns.pop();
    const context = await loadLeadBuilderEvidence([run], 'lead-a', 'project-a', async () => run);
    expect(context.sections.map((section) => section.text).join('\n')).toContain('No completed Builder reply');
    expect(context.sections.some((section) => section.name.includes('actual reply'))).toBe(false);
    const failed = await loadLeadBuilderEvidence([run], 'lead-a', 'project-a', async () => { throw new Error('Unavailable'); });
    expect(failed.notes.join(' ')).toContain('do not reconstruct it from old reports');
  });
  it('keeps the full question and whole relevant evidence within a combined request budget', async () => {
    const question = 'continue\n' + 'Keep my whole question. '.repeat(280);
    const huge = '```ts\n' + 'function completeBlock() {}\n'.repeat(700) + '```';
    const text = buildLeadRequestText({ question, builderEvidence: [{ name: 'large command', text: huge }, { name: 'git files', text: 'M\tsrc/form.ts\nA\tsrc/helper.ts' }], specFiles: [{ path: '.kai/spec/plan.md', content: '## Relevant plan\nCollect current changes.\n\n## Older material\n' + 'Old planning material.\n'.repeat(900) }], openFile: { path: 'src/large.ts', content: 'export function useful() {}\n' + huge }, includeProjectOrientation: false, style: 'senior-dev', detail: 'brief', questions: 'decisions', leadCoachPrompt: leadDevelopmentPrompt });
    expect(text.displayText).toBe(question); expect(text.prompt).toContain(question);
    expect(text.prompt).toContain('M\tsrc/form.ts\nA\tsrc/helper.ts');
    expect(text.omitted).toContain('large command');
    expect(text.prompt.length).toBeLessThanOrEqual(20_000);
    expect(agentRunRequestSchema.safeParse({ conversationId: 'lead-a', prompt: text.prompt, displayText: question, agent: 'codex', execution: 'api', route: 'direct', autonomy: 'plan' }).success).toBe(true);
    const packed = packLeadBuilderEvidence([{ name: 'whole code', text: huge }], 1000);
    expect(packed.text).not.toContain('function completeBlock'); expect(packed.omitted).toContain('whole code');
  });
  it('reuses redaction before sharing evidence and never changes the saved Builder record', async () => {
    const run = builder(); const event = run.events[0]!;
    if (event.type === 'tool.call') event.output = { output: 'api_key=synthetic-private-value\nM src/form.ts', exitCode: 0 };
    const original = structuredClone(run);
    const context = await loadLeadBuilderEvidence([run], 'lead-a', 'project-a', async () => run);
    expect(context.sections.map((section) => section.text).join('\n')).not.toContain('synthetic-private-value');
    expect(context.sections.map((section) => section.text).join('\n')).toContain('[REDACTED]');
    expect(run).toEqual(original);
  });
});
