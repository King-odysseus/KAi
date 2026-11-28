import type { AgentRunRequest, ConversationRecord } from '@kai/contracts';

export function isWorkspaceConversation(conversation: Pick<ConversationRecord, 'origin'>): boolean {
  return conversation.origin?.kind !== 'lead';
}

/** The persisted conversation owns access; a renderer cannot promote the Lead to a writer. */
export function scopeConversationRequest(conversation: Pick<ConversationRecord, 'origin'>, request: AgentRunRequest): AgentRunRequest {
  return isWorkspaceConversation(conversation) ? request : { ...request, autonomy: 'plan', permissionRules: [{ id: 'lead-read-only', effect: 'deny', tools: ['run_command', 'replace_in_file', 'multi_edit', 'write_file', 'create_file', 'delete_file', 'move_file', 'task', 'mcp_*'], commands: [], paths: [] }] };
}
