import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationRecord } from '@kai/contracts';
import { LeadConversationPanel, type LeadApprovalItem } from '../apps/desktop/src/renderer/src/components/RightPane';

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
