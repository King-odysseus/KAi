import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationRecord } from '@kai/contracts';
import { LeadConversationPanel, type LeadApprovalItem } from '../apps/desktop/src/renderer/src/components/RightPane';
import { LeadRunLinks } from '../apps/desktop/src/renderer/src/components/LeadRunLinks';

const conversation = (assistantText: string, awaitingAnswer = false): ConversationRecord => ({
  schemaVersion: 1,
  id: 'lead-one', projectId: 'project-one', title: 'Lead', createdAt: '2026-11-26T00:00:00.000Z', updatedAt: '2026-11-26T00:00:00.000Z',
  archived: false, unread: false, activeAgent: 'codex', route: 'direct', autonomy: 'plan', execution: 'cli', turns: [
    { id: 'user-1', role: 'user', text: 'Please explain this.', createdAt: '2026-11-26T00:00:00.000Z' },
    { id: 'assistant-1', role: 'assistant', text: assistantText, createdAt: '2026-11-26T00:00:00.000Z', awaitingAnswer },
  ], events: [],
});

function markup(overrides: { running?: boolean; error?: string | null; conversation?: ConversationRecord; approvals?: LeadApprovalItem[]; conversations?: ConversationRecord[]; builderEnabled?: boolean } = {}): string {
  return renderToStaticMarkup(React.createElement(LeadConversationPanel, {
    projectName: 'Demo', projectId: 'project-one', conversation: overrides.conversation ?? null, streamingText: '', running: overrides.running ?? false,
    conversations: overrides.conversations ?? [], builderEnabled: overrides.builderEnabled ?? true,
    error: overrides.error ?? null, approvals: overrides.approvals ?? [], inventory: { apiProviders: [], cliAgents: [] }, savedCoach: null,
    onAsk: vi.fn(), onStop: vi.fn(), onClearError: vi.fn(), onRespondApproval: vi.fn(), onSendToBuilder: vi.fn(), onReviewIdea: vi.fn(),
  }));
}

describe('shared Lead panel', () => {
  it('shows the actual recorded git output in the linked result instead of hiding non-check commands', () => {
    const run = conversation('Here is the file enumeration.'); run.id = 'builder-one';
    run.turns[0]!.text = 'List changed files.';
    run.leadHandoffs = [{ id: 'handoff-one', leadConversationId: 'lead-one', task: 'List changed files.', createdAt: run.createdAt, userTurnCount: 0 }];
    run.events = [{ schemaVersion: 1, id: 'git-event', taskId: run.id, type: 'tool.call', name: 'run_command', status: 'completed', timestamp: run.createdAt, input: { command: 'git diff --name-status base..HEAD' }, output: { stdout: 'M src/form.ts\nA src/helper.ts', exitCode: 0 } }];
    const html = renderToStaticMarkup(React.createElement(LeadRunLinks, { leadId: 'lead-one', conversations: [run], target: null, inventory: { apiProviders: [], cliAgents: [] }, running: false }));
    expect(html).toContain('Recorded command: git diff --name-status');
    expect(html).toContain('M src/form.ts\nA src/helper.ts');
  });
  it('makes a saved price pause actionable without rendering a chat error or assuming free usage', () => {
    const builder = conversation('Builder finished.'); builder.id = 'builder-one';
    builder.leadHandoffs = [{ id: 'handoff-one', leadConversationId: 'lead-one', task: 'Task', createdAt: builder.createdAt, userTurnCount: 0, completion: { resultTurnId: 'assistant-1', state: 'review-needed', reason: 'Review needed.', recordedAt: builder.updatedAt, checks: [], missingChecks: [], criteria: [], files: [], continuationNote: 'Paid usage could not be measured. Choose manual review before another paid request.' } }];
    const html = renderToStaticMarkup(React.createElement(LeadRunLinks, { leadId: 'lead-one', conversations: [builder], target: { execution: 'api', api: { provider: 'deepseek', model: 'deepseek-chat' } }, inventory: { apiProviders: [], cliAgents: [] }, running: false, onReview: vi.fn() }));
    expect(html).toContain('Automatic review paused');
    expect(html).toContain('Normal Lead chat still works');
    expect(html).toContain('Review once with Lead · Paid API');
    expect(html).toContain('may incur a charge');
    expect(html).not.toContain('role="alert"');
  });
  it('collapses generated review payloads while retaining their full saved text', () => {
    const chat = conversation('## Review\nThe check failed.');
    const fullText = 'Review evidence: ' + 'Keep all recorded evidence. '.repeat(150);
    chat.turns[0]!.text = fullText;
    chat.leadGeneratedTurns = [{ id: chat.turns[0]!.id, label: 'Review the Builder result' }];
    const html = markup({ conversation: chat });
    expect(html).toContain('<summary>Review the Builder result</summary>');
    expect(html).toContain(fullText.trim());
    expect(chat.turns[0]!.text).toBe(fullText);
  });
  it('keeps the composer fixed while only the transcript scrolls', () => {
    const css = readFileSync(new URL('../apps/desktop/src/renderer/src/styles.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.context-pane-body > \.lead-context-pane\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/);
    expect(css).toMatch(/\.lead-transcript\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/);
    expect(css).toMatch(/\.lead-compose\s*\{[^}]*flex:\s*0 0 auto;/);
  });

  it('always renders the API/CLI, provider/agent, and model selectors', () => {
    const html = markup();
    expect(html).toContain('Lead runs on');
    expect(html).toContain('Lead agent');
    expect(html).toContain('Model');
  });

  it('shows the reply error, full question, approval request, and Stop action in the panel', () => {
    const longQuestion = `Which file should I explain? ${'detail '.repeat(200)}`;
    const approvals: LeadApprovalItem[] = [{ conversationId: 'lead-one', requestId: 'approval-1', title: 'High-risk change', detail: 'This touches permissions.', risk: 'high', tool: 'edit_file' }];
    const html = markup({ running: true, error: 'Connection interrupted', conversation: conversation(longQuestion, true), approvals });
    expect(html).toContain('Connection interrupted');
    expect(html).toContain(longQuestion);
    expect(html).toContain('High-risk change');
    expect(html).toContain('Stop Lead');
  });

  it('renders only the marked Builder task for handoff', () => {
    const html = markup({ conversation: conversation('Reasoning here.\n\nBUILDER TASK:\nAdd a small empty-state message.') });
    expect(html).toContain('Add a small empty-state message.');
    expect(html).toContain('Reasoning here.');
    expect(html).toContain('Send task to Builder');
  });

  it('offers project chat history and a separate new-chat action', () => {
    const older = { ...conversation('Old chat'), id: 'lead-old', title: 'Lead' };
    const newer = { ...conversation('Current chat'), id: 'lead-new', title: 'Lead' };
    const html = markup({ conversation: newer, conversations: [newer, older] });
    expect(html).toContain('Lead chat history');
    expect(html).toContain('New Lead chat');
    expect(html).toContain('Open Lead chat history');
  });

  it('keeps Builder task handoff disabled while Lead & Builder is off', () => {
    const html = markup({ conversation: conversation('Reasoning.\n\nBUILDER TASK:\nAdd a settings hint.'), builderEnabled: false });
    expect(html).toContain('Builder is off');
    expect(html).toContain('disabled=""');
  });
});

it('renders headings, list items and code inside the Builder task card', () => {
 const html = markup({ conversation: conversation('## Recommendation\nKeep it small.\nBUILDER TASK:\n### Files\n- `src/form.ts`\n### Check\n```sh\nnpm test\n```\nEND BUILDER TASK') });
 expect(html).toMatch(/<h3[^>]*>Files<\/h3>/);
 expect(html).toContain('<li>');
 expect(html).toContain('<pre><code>npm test</code></pre>');
 expect(html).toContain('<span>sh</span>');
});

it('discloses supplied, omitted and unavailable context and actual recorded reads', () => {
 const chat = conversation('## Next step\nReview the form.');
 chat.leadContext = { suppliedAt: chat.updatedAt, included: ['.kai/spec/brief.md'], omitted: ['large.md — Background'], unavailable: ['missing.md'] };
 chat.events = [{ schemaVersion: 1, id: 'read', taskId: 't', type: 'tool.call', name: 'read_file', status: 'completed', timestamp: chat.updatedAt, input: { path: 'src/form.ts' }, output: { content: 'form' } }];
 const html = markup({ conversation: chat });
 expect(html).toContain('Latest request context supplied');
 expect(html).toContain('Recorded file reads (1)');
 expect(html).toContain('src/form.ts');
 expect(html).toContain('large.md');
 expect(html).toContain('missing.md');
});
