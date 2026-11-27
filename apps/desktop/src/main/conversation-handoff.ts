import type { ConversationRecord } from '@kai/contracts';

export function renderConversationHandoff(turns: readonly ConversationRecord['turns'][number][], preserveFull = false): string {
  const lines = (preserveFull ? turns : turns.slice(-12)).map((turn) => `${turn.role === 'user' ? 'User' : 'KAI'}: ${turn.text}`).join('\n\n');
  if (!lines) return '';
  const body = preserveFull ? lines : lines.slice(-60_000);
  return `# Conversation handoff\nYou are continuing an existing conversation after the user changed agent, route, or provider. Preserve the prior intent, decisions, and context; do not ask them to repeat it.\n\n${body}`;
}
