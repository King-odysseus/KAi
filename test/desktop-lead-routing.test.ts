import { describe, expect, it } from 'vitest';
import type { AgentRunRequest, BootstrapPayload, ConversationRecord } from '@kai/contracts';
import { preferredConversationId } from '../apps/desktop/src/renderer/src/workspace-conversation';
import { ipcInputSchemas } from '../packages/contracts/src/ipc';
import { claudeDisallowedTools } from '../apps/desktop/src/main/agent-runtime';
import { isWorkspaceConversation, scopeConversationRequest } from '../apps/desktop/src/main/conversation-scope';

const lead = { id: 'lead', projectId: 'project-a', updatedAt: '2026-11-27', archived: false, origin: { kind: 'lead', projectId: 'project-a' } } as ConversationRecord;
const builder = { id: 'builder', projectId: 'project-a', updatedAt: '2026-11-26', archived: false } as ConversationRecord;

describe('Lead and Builder conversation boundaries', () => {
  it('accepts the Lead identity at creation while retaining older create requests', () => {
    expect(ipcInputSchemas['conversations:create'].parse({ projectId: 'project-a', firstPrompt: '', origin: lead.origin }).origin?.kind).toBe('lead');
    expect(ipcInputSchemas['conversations:create'].parse({ projectId: 'project-a', firstPrompt: '' }).origin).toBeUndefined();
  });
  it('blocks edit and shell CLI tools despite a Full access composer', () => {
    const request = scopeConversationRequest(lead, { autonomy: 'full' } as AgentRunRequest);
    expect(claudeDisallowedTools(request.permissionRules)).toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write']));
  });
  it('restores Builder when a saved window points at Lead', () => {
    expect(preferredConversationId({ activeConversationId: 'lead', activeProjectId: 'project-a' } as BootstrapPayload, [lead, builder])).toBe('builder');
  });
  it('never picks the newest Lead as the fallback, including a project with no Builder yet', () => {
    const bootstrap = { activeConversationId: null, activeProjectId: 'project-a' } as BootstrapPayload;
    expect(preferredConversationId(bootstrap, [lead, builder])).toBe('builder');
    expect(preferredConversationId(bootstrap, [lead])).toBeNull();
  });
  it('keeps a Lead save out of workspace selection', () => {
    expect(isWorkspaceConversation(lead)).toBe(false);
    expect(isWorkspaceConversation(builder)).toBe(true);
  });
  it.each(['api', 'cli'] as const)('forces read-only access for a %s Lead even when the composer requests Full access', (execution) => {
    const request = { execution, autonomy: 'full', conversationId: 'lead' } as AgentRunRequest;
    expect(scopeConversationRequest(lead, request).autonomy).toBe('plan');
    expect(scopeConversationRequest(builder, request)).toBe(request);
  });
  it.each(['discuss', 'ask', 'auto'] as const)('keeps the %s handoff setting separate from Lead edit permission', (mode) => {
    const request = { execution: 'api', autonomy: 'full', conversationId: 'lead' } as AgentRunRequest;
    const saved = { ...lead, leadHandoffMode: mode };
    const scoped = scopeConversationRequest(saved, request);
    expect(scoped.autonomy).toBe('plan');
    expect(scoped.permissionRules?.[0]?.tools).toEqual(expect.arrayContaining(['write_file', 'run_command', 'task']));
  });
});
