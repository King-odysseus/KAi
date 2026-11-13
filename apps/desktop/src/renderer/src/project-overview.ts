import type { ConversationRecord, CrewRun, StudioProjectSummary, WorkflowRun } from '@kai/contracts';

export interface ProjectOverviewActivity {
  studio: StudioProjectSummary | null;
  crew: CrewRun[];
  workflows: WorkflowRun[];
  conversations: ConversationRecord[];
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
  return {
    studio,
    crew: crew.filter((run) => run.projectId === projectId).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    workflows: workflows.filter((run) => run.projectId === projectId).sort((left, right) => right.workflow.createdAt.localeCompare(left.workflow.createdAt)),
    conversations: conversations.filter((item) => item.projectId === projectId && !item.sideOf).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
  };
}
