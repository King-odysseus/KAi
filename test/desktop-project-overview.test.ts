import { describe, expect, it } from 'vitest';
import type { ConversationRecord, CrewRun, StudioProjectSummary, WorkflowRun } from '@kai/contracts';
import { projectOverviewActivity } from '../apps/desktop/src/renderer/src/project-overview';

describe('project overview activity', () => {
  it('joins plans, runs and conversations by their owning folder', () => {
    const studio = (id: string, linkedProjectId: string | null, updatedAt: string) => ({ id, linkedProjectId, updatedAt }) as StudioProjectSummary;
    const crew = (id: string, projectId: string, updatedAt: string) => ({ id, projectId, updatedAt }) as CrewRun;
    const workflow = (conversationId: string, projectId: string, createdAt: string) => ({ conversationId, projectId, workflow: { createdAt } }) as WorkflowRun;
    const goal = { id: 'goal-a', outcome: 'Ship dashboard', constraints: '', verification: 'Smoke test', status: 'running', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z', startedAt: '2026-11-01T00:00:00.000Z' } as const;
    const conversation = (id: string, projectId: string | null, updatedAt: string, sideOf?: string, attachedGoal?: ConversationRecord['goal']) => ({ id, projectId, updatedAt, title: id, ...(attachedGoal ? { goal: attachedGoal } : {}), ...(sideOf ? { sideOf } : {}) }) as ConversationRecord;

    const result = projectOverviewActivity('folder-a', [
      studio('plan-a-old', 'folder-a', '2026-10-01T00:00:00.000Z'),
      studio('plan-b', 'folder-b', '2026-11-02T00:00:00.000Z'),
      studio('plan-a-new', 'folder-a', '2026-11-01T00:00:00.000Z'),
    ], [
      crew('crew-a', 'folder-a', '2026-11-01T00:00:00.000Z'),
      crew('crew-b', 'folder-b', '2026-11-02T00:00:00.000Z'),
    ], [
      workflow('workflow-a', 'folder-a', '2026-11-01T00:00:00.000Z'),
      workflow('workflow-b', 'folder-b', '2026-11-02T00:00:00.000Z'),
    ], [
      conversation('conversation-a', 'folder-a', '2026-11-01T00:00:00.000Z', undefined, goal),
      conversation('side-a', 'folder-a', '2026-11-02T00:00:00.000Z', 'conversation-a', { ...goal, id: 'goal-side' }),
      conversation('conversation-b', 'folder-b', '2026-11-03T00:00:00.000Z'),
    ]);

    expect(result.studio?.id).toBe('plan-a-new');
    expect(result.crew.map((run) => run.id)).toEqual(['crew-a']);
    expect(result.workflows.map((run) => run.conversationId)).toEqual(['workflow-a']);
    expect(result.conversations.map((item) => item.id)).toEqual(['conversation-a']);
    expect(result.goals.map((item) => [item.goal.id, item.conversationId])).toEqual([['goal-a', 'conversation-a']]);
  });
});
