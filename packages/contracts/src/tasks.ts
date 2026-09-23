/** Task, review and handoff shapes returned by the Cognitive1 REST API, read defensively. */

export type TaskColumn = 'todo' | 'doing' | 'done';

export interface BoardTask {
  title: string;
  project: string;
  status: string;
  column: TaskColumn;
  creator: string;
  assignee: string;
  claimedBy: string;
  description: string;
  tags: string;
  dependsOn: string;
  date: string;
  subtasksDone: number;
  subtasksTotal: number;
}

export interface BoardReview {
  id: string;
  project: string;
  commit: string;
  summary: string;
  files: string;
  status: string;
  requestedBy: string;
  feedback: string;
}

export interface BoardHandoff {
  date: string;
  time: string;
  fromAgent: string;
  toAgent: string;
  project: string;
  status: string;
  next: string;
  notes: string;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : value == null ? '' : String(value));

export function columnForStatus(status: string): TaskColumn {
  if (status === 'done') return 'done';
  return status === 'claimed' || status === 'in-progress' ? 'doing' : 'todo';
}

export function parseTasks(payload: unknown): BoardTask[] {
  const tasks = record(payload).tasks;
  if (!Array.isArray(tasks)) return [];
  return tasks
    .map((item) => {
      const task = record(item);
      const subtasks = Array.isArray(task.subtasks) ? task.subtasks.map(record) : [];
      const status = text(task.status) || 'pending';
      return {
        title: text(task.title),
        project: text(task.project),
        status,
        column: columnForStatus(status),
        creator: text(task.creatorAgent),
        assignee: text(task.assignee),
        claimedBy: text(task.claimedBy),
        description: text(task.description),
        tags: text(task.tags),
        dependsOn: text(task.dependsOn),
        date: text(task.date),
        subtasksDone: subtasks.filter((subtask) => subtask.done === true).length,
        subtasksTotal: subtasks.length,
      };
    })
    .filter((task) => task.title);
}

export function parseReviews(payload: unknown): BoardReview[] {
  const reviews = record(payload).reviews;
  if (!Array.isArray(reviews)) return [];
  return reviews.map((item) => {
    const review = record(item);
    return {
      id: text(review.id),
      project: text(review.project),
      commit: text(review.commit),
      summary: text(review.summary),
      files: Array.isArray(review.files) ? review.files.map(text).join(', ') : text(review.files),
      status: text(review.status),
      requestedBy: text(review.requestingAgent ?? review.agent),
      feedback: text(review.feedback),
    };
  }).filter((review) => review.id || review.summary);
}

export function parseHandoffs(payload: unknown): BoardHandoff[] {
  const handoffs = record(payload).handoffs;
  if (!Array.isArray(handoffs)) return [];
  return handoffs.map((item) => {
    const handoff = record(item);
    return {
      date: text(handoff.date),
      time: text(handoff.time),
      fromAgent: text(handoff.fromAgent),
      toAgent: text(handoff.toAgent),
      project: text(handoff.project),
      status: text(handoff.status),
      next: text(handoff.next),
      notes: text(handoff.notes),
    };
  }).filter((handoff) => handoff.fromAgent || handoff.next);
}

/** The prompt used to start a conversation from a task. */
export function buildTaskPrompt(task: Pick<BoardTask, 'title' | 'description' | 'project' | 'dependsOn'>): string {
  return [
    `Work on this task: ${task.title}`,
    task.description ? `Details:\n${task.description}` : null,
    task.dependsOn ? `It depends on the task "${task.dependsOn}", so check that is done first.` : null,
    'Restate your understanding and approach briefly, then do the work and report what changed.',
  ].filter((line): line is string => line !== null).join('\n\n');
}

export function buildDecisionNote(input: { title: string; context: string; chosen: string; rationale: string }): string {
  return `Decision: ${input.chosen}\nWhy: ${input.rationale}\nContext: ${input.context}`;
}
