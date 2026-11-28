import { describe, expect, it } from 'vitest';
import type { ConversationRecord } from '@kai/contracts';
import { changedLineRange, diffChangedRange, workspaceEdits } from '../apps/desktop/src/renderer/src/components/workspace-code-follow';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BuilderOutcome } from '../apps/desktop/src/renderer/src/components/BuilderOutcome';
import { WorkspaceCodePanel } from '../apps/desktop/src/renderer/src/components/WorkspaceCodePanel';

describe('Workspace code following', () => {
  it('keeps the completed result actionable when another task was only put in the draft', () => {
    const chat = { turns: [{ id: 'q', role: 'user', text: 'Build the form', createdAt: '2026-11-28T00:00:00Z' }, { id: 'a', role: 'assistant', text: 'Built it', createdAt: '2026-11-28T00:01:00Z' }], events: [], leadHandoffs: [{ id: 'done', task: 'Build the form', userTurnCount: 0, leadConversationId: 'lead-a', completion: { state: 'not-checked', reason: 'Check missing' } }, { id: 'draft', task: 'Another task', userTurnCount: 2, leadConversationId: 'lead-a' }] } as ConversationRecord;
    const html = renderToStaticMarkup(React.createElement(BuilderOutcome, { conversation: chat, onOpenLead: () => undefined }));
    expect(html).toContain('Not checked');
    expect(html).toContain('Review result with Lead');
  });
  it('offers previous and next navigation through touched files', () => {
    const html = renderToStaticMarkup(React.createElement(WorkspaceCodePanel, { project: null, conversation: null, path: null, visible: true, dirty: false, follow: true, onFollow: () => undefined, onSelect: () => undefined, onDirty: () => undefined, onClose: () => undefined, formatOnSave: false, editorView: {} as never }));
    expect(html).toContain('Previous changed file');
    expect(html).toContain('Next changed file');
  });
  it('does not show an older passed result as the outcome of a newer pending task', () => {
    const chat = { leadHandoffs: [{ id: 'old', completion: { state: 'passed', reason: 'Previously checked' } }, { id: 'new' }] } as ConversationRecord;
    expect(renderToStaticMarkup(React.createElement(BuilderOutcome, { conversation: chat }))).toBe('');
  });
  it('follows only actual edit events, never reads or failed edits', () => {
    const event = { schemaVersion: 1, taskId: 'builder-a', timestamp: '2026-11-28T00:00:00Z', type: 'tool.call', status: 'completed' };
    const chat = { events: [{ ...event, id: 'read', name: 'read_file', input: { path: 'src/read.ts' } }, { ...event, id: 'write', name: 'write_file', input: { path: 'src/form.ts' } }, { ...event, id: 'fail', name: 'replace_in_file', status: 'failed', input: { path: 'src/fail.ts' } }] } as ConversationRecord;
    expect(workspaceEdits(chat).paths).toEqual(['src/form.ts']);
    expect(workspaceEdits(chat).latest?.path).toBe('src/form.ts');
    expect(workspaceEdits(null).paths).toEqual([]);
  });
  it('supports CLI file paths and final checkpoint file lists', () => {
    const chat = { events: [{ id: 'edit', type: 'tool.call', name: 'Edit', status: 'started', input: { file_path: 'src/a.ts' } }, { id: 'done', type: 'turn.changes', files: [{ path: 'src/b.ts' }] }] } as ConversationRecord;
    expect(workspaceEdits(chat).paths).toEqual(['src/a.ts', 'src/b.ts']);
    expect(workspaceEdits(chat).latest?.path).toBe('src/b.ts');
  });
  it('follows native CLI patch and applied-file events while ignoring proposals', () => {
    const chat = { events: [{ id: 'patch', type: 'tool.call', name: 'functions.apply_patch', status: 'completed', input: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n+change\n*** End Patch' }, { id: 'applied', type: 'file.edit.applied', filePath: 'src/b.ts' }, { id: 'proposed', type: 'diff.proposal', filePath: 'not-applied.ts' }] } as ConversationRecord;
    expect(workspaceEdits(chat).paths).toEqual(['src/a.ts', 'src/b.ts']);
  });
  it('highlights actual changed lines without simulating typing', () => {
    expect(changedLineRange('one\ntwo\nthree', 'one\nnew\nthree')).toEqual({ start: 2, end: 2 });
    expect(changedLineRange('one', 'one')).toBeNull();
    expect(changedLineRange('one\ntwo', 'one')).toEqual({ start: 1, end: 1 });
  });
  it('follows verified live shell diffs and highlights their changed lines on first open', () => {
    const diff = '--- a/src/form.ts\n+++ b/src/form.ts\n@@ -8,3 +8,3 @@\n context\n-before\n+after\n context';
    const chat = { events: [{ id: 'actual', type: 'diff.proposal', applied: true, filePath: 'src/form.ts', diff }, { id: 'proposal', type: 'diff.proposal', filePath: 'src/proposal.ts', diff }] } as ConversationRecord;
    expect(workspaceEdits(chat).paths).toEqual(['src/form.ts']);
    expect(workspaceEdits(chat).ranges['src/form.ts']).toEqual({ start: 9, end: 9 });
    expect(diffChangedRange('@@ -4,1 +3,0 @@\n-deleted')).toEqual({ start: 3, end: 3 });
  });
});
