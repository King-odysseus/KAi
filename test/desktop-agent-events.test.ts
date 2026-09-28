import { describe, expect, it } from 'vitest';
import {
  isApprovalForConversation,
  shouldHandleAgentEvent,
} from '../apps/desktop/src/renderer/src/agent-events';

describe('desktop agent events', () => {
  it('only treats an approval as active when it belongs to the open conversation', () => {
    expect(isApprovalForConversation('conversation-1', 'conversation-1')).toBe(true);
    expect(isApprovalForConversation('conversation-1', 'conversation-2')).toBe(false);
    expect(isApprovalForConversation('conversation-1', null)).toBe(false);
  });

  it('does not match the missing approval and missing conversation placeholders', () => {
    expect(isApprovalForConversation(undefined, undefined)).toBe(false);
    expect(isApprovalForConversation(null, null)).toBe(false);
  });

  it('still accepts approvals while another conversation is streaming', () => {
    const approval = {
      conversationId: 'workflow-run',
      event: { type: 'approval.request' },
    };
    expect(shouldHandleAgentEvent(approval as never, null)).toBe(true);
  });
});
