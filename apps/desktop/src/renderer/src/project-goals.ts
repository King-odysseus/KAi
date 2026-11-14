import type { ConversationRecord, WorkbenchGoal } from '@kai/contracts';

export interface ProjectGoalRecord {
  conversationId: string;
  conversationTitle: string;
  goal: WorkbenchGoal;
}

export function projectGoals(conversations: readonly ConversationRecord[]): ProjectGoalRecord[] {
  return conversations.flatMap((conversation) => conversation.goal ? [{
    conversationId: conversation.id,
    conversationTitle: conversation.title || 'Untitled conversation',
    goal: conversation.goal,
  }] : []).sort((left, right) => right.goal.updatedAt.localeCompare(left.goal.updatedAt));
}
