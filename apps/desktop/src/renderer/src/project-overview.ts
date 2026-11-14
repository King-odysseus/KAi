import type { ConversationRecord, CrewRun, StudioProjectSummary, WorkflowRun } from '@kai/contracts';
import { projectGoals, type ProjectGoalRecord } from './project-goals';

export interface ProjectOverviewActivity {
  studio: StudioProjectSummary | null;
  crew: CrewRun[];
  workflows: WorkflowRun[];
  conversations: ConversationRecord[];
  goals: ProjectGoalRecord[];
}

/** Collects the app records that belong to one folder, including plans that have their own Studio id. */
export function projectOverviewActivity(
  projectId: string,
  studios: readonly StudioProjectSummary[],
  crew: readonly CrewRun[],
  workflows: readonly WorkflowRun[],
  conversations: readonly ConversationRecord[],
): ProjectOverviewActivity {
  const studio = studios
    .filter((item) => item.linkedProjectId === projectId || item.id === projectId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  const projectConversations = conversations.filter((item) => item.projectId === projectId && !item.sideOf).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return {
    studio,
    crew: crew.filter((run) => run.projectId === projectId).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    workflows: workflows.filter((run) => run.projectId === projectId).sort((left, right) => right.workflow.createdAt.localeCompare(left.workflow.createdAt)),
    conversations: projectConversations,
    goals: projectGoals(projectConversations),
  };
}
