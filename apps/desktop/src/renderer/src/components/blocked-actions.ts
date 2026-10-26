import type { PersistedEvent } from '@kai/contracts';

/** Who or what stopped the call: KAI's own access level, a project rule, a project hook, or the person themselves. */
export type BlockedBy = 'policy' | 'hook' | 'user';

export interface BlockedAction {
  id: string;
  tool: string;
  reason: string;
  blockedBy: BlockedBy;
  timestamp: string;
}

const BLOCKED_BY = new Set<BlockedBy>(['policy', 'hook', 'user']);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * Every call this conversation's run tried that something stopped: the access level, a project rule, a project
 * hook, or a "no" from the person. A run that is quietly stuck is often stuck on one of these, repeated — and
 * finding that out today means reading the whole transcript. This reads the conversation's own event log instead,
 * which already carries the tag each blocking point in the runtime leaves behind.
 */
export function blockedActions(events: readonly PersistedEvent[]): BlockedAction[] {
  const found: BlockedAction[] = [];
  for (const event of events) {
    if (event.type !== 'tool.call' || event.status !== 'failed') continue;
    const output = asRecord(event.output);
    const blockedBy = output?.blockedBy;
    if (!output?.blocked || typeof blockedBy !== 'string' || !BLOCKED_BY.has(blockedBy as BlockedBy)) continue;
    const reason = typeof output.error === 'string' ? output.error : 'This action was blocked.';
    found.push({ id: event.callId ?? event.id, tool: event.name, reason, blockedBy: blockedBy as BlockedBy, timestamp: event.timestamp });
  }
  return found;
}

export const BLOCKED_BY_LABEL: Record<BlockedBy, string> = {
  policy: 'Access level',
  hook: 'Project hook',
  user: 'You said no',
};
