export type WorkbenchGoalStatus = 'running' | 'paused' | 'completed';

export interface GoalInput {
  outcome: string;
  constraints?: string;
  verification?: string;
}

export interface WorkbenchGoal extends Required<GoalInput> {
  id: string;
  status: WorkbenchGoalStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  pausedAt?: string;
  completedAt?: string;
}

function clean(value: string | undefined): string {
  return (value ?? '').trim();
}

export function createGoal(input: GoalInput, now = new Date()): WorkbenchGoal {
  const outcome = clean(input.outcome);
  if (!outcome) throw new Error('A goal needs an outcome.');
  const timestamp = now.toISOString();
  return {
    id: `goal_${now.getTime()}_${Math.random().toString(16).slice(2, 8)}`,
    outcome,
    constraints: clean(input.constraints),
    verification: clean(input.verification),
    status: 'running',
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
  };
}

export function updateGoal(goal: WorkbenchGoal, input: GoalInput, now = new Date()): WorkbenchGoal {
  const outcome = clean(input.outcome);
  if (!outcome) throw new Error('A goal needs an outcome.');
  return {
    ...goal,
    outcome,
    constraints: clean(input.constraints),
    verification: clean(input.verification),
    updatedAt: now.toISOString(),
  };
}

/** Builds the instruction block sent to an agent for a goal-backed turn. */
export function buildGoalPrompt(goal: WorkbenchGoal, userPrompt?: string): string {
  const lines = [
    '[ACTIVE GOAL]',
    `Outcome: ${goal.outcome}`,
    goal.constraints ? `Constraints: ${goal.constraints}` : '',
    goal.verification ? `Definition of done: ${goal.verification}` : '',
    'Continue working toward this outcome. Verify the definition of done before reporting completion.',
  ].filter(Boolean);

  const task = clean(userPrompt);
  return task ? `${lines.join('\n')}\n\nUser instruction:\n${task}` : lines.join('\n');
}

export function pauseGoal(goal: WorkbenchGoal, now = new Date()): WorkbenchGoal {
  if (goal.status !== 'running') return goal;
  const timestamp = now.toISOString();
  return { ...goal, status: 'paused', pausedAt: timestamp, updatedAt: timestamp };
}

export function resumeGoal(goal: WorkbenchGoal, now = new Date()): WorkbenchGoal {
  if (goal.status !== 'paused') return goal;
  const timestamp = now.toISOString();
  return { ...goal, status: 'running', pausedAt: undefined, updatedAt: timestamp };
}

export function completeGoal(goal: WorkbenchGoal, now = new Date()): WorkbenchGoal {
  if (goal.status === 'completed') return goal;
  const timestamp = now.toISOString();
  return { ...goal, status: 'completed', completedAt: timestamp, updatedAt: timestamp };
}
