import type { AgentRunEvent } from '@kai/contracts';

/**
 * Approvals are window-owned even when no normal conversation is active, such as a workflow run.
 * Other agent output is only relevant to the conversation currently streaming in this renderer.
 */
export function shouldHandleAgentEvent(
  payload: AgentRunEvent,
  runningConversationId: string | null,
): boolean {
  return payload.event.type === 'approval.request' || payload.conversationId === runningConversationId;
}
