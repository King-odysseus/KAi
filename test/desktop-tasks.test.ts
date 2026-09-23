import { describe, expect, it } from 'vitest';
import { buildDecisionNote, buildTaskPrompt, columnForStatus, parseHandoffs, parseReviews, parseTasks } from '../packages/contracts/src';

describe('task board parsing', () => {
  it('maps C1 statuses onto board columns', () => {
    expect(columnForStatus('pending')).toBe('todo');
    expect(columnForStatus('claimed')).toBe('doing');
    expect(columnForStatus('in-progress')).toBe('doing');
    expect(columnForStatus('done')).toBe('done');
    expect(columnForStatus('something-new')).toBe('todo');
  });

  it('reads the /api/tasks payload, counting finished subtasks', () => {
    const tasks = parseTasks({
      count: 3,
      lines: 'ignored',
      tasks: [
        {
          date: '2026-09-20', time: '10:00', title: 'Add dark mode', creatorAgent: 'claude', assignee: 'any', status: 'in-progress', project: 'KAI',
          tags: 'frontend', claimedBy: 'codex', claimedAt: '', completedAt: '', description: 'Toggle in settings', dependsOn: '',
          subtasks: [{ text: 'CSS vars', done: true }, { text: 'Toggle', done: false }],
        },
        { title: 'Write docs', project: 'KAI', status: 'pending', assignee: 'qwen' },
        { title: 'Ship', project: 'KAI', status: 'done' },
        { project: 'no title, skipped' },
      ],
    });
    expect(tasks.map((task) => [task.title, task.column])).toEqual([['Add dark mode', 'doing'], ['Write docs', 'todo'], ['Ship', 'done']]);
    expect(tasks[0]).toMatchObject({ claimedBy: 'codex', subtasksDone: 1, subtasksTotal: 2, tags: 'frontend' });
    expect(parseTasks(null)).toEqual([]);
    expect(parseTasks({ tasks: 'oops' })).toEqual([]);
  });

  it('builds the prompt for starting a task as a conversation', () => {
    const prompt = buildTaskPrompt({ title: 'Add dark mode', description: 'Toggle in settings', project: 'KAI', dependsOn: 'Design tokens' });
    expect(prompt).toContain('Work on this task: Add dark mode');
    expect(prompt).toContain('Toggle in settings');
    expect(prompt).toContain('Design tokens');
    expect(buildTaskPrompt({ title: 'Small', description: '', project: 'KAI', dependsOn: '' })).not.toContain('Details:');
  });
});

describe('reviews, handoffs and decisions', () => {
  it('reads review records as C1 stores them', () => {
    const reviews = parseReviews({
      count: 1,
      reviews: [{ id: 'r1', date: '2026-09-20', time: '11:00', requestingAgent: 'claude', project: 'KAI', commit: 'abc123', files: ['a.ts', 'b.ts'], summary: 'Refactor auth', status: 'done', feedback: 'LGTM' }],
    });
    expect(reviews).toEqual([{ id: 'r1', project: 'KAI', commit: 'abc123', summary: 'Refactor auth', files: 'a.ts, b.ts', status: 'done', requestedBy: 'claude', feedback: 'LGTM' }]);
    expect(parseReviews({})).toEqual([]);
  });

  it('reads handoffs and skips empty ones', () => {
    const handoffs = parseHandoffs({
      handoffs: [
        { date: '2026-09-21', time: '09:00', fromAgent: 'claude', toAgent: 'codex', project: 'KAI', status: 'pending', next: 'Finish the tests', files: 'a.ts', notes: 'n' },
        {},
      ],
      to: 'any',
    });
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({ fromAgent: 'claude', toAgent: 'codex', next: 'Finish the tests' });
  });

  it('summarises a decision for the timeline', () => {
    expect(buildDecisionNote({ title: 't', context: 'Slow builds', chosen: 'Use Vite', rationale: 'Faster HMR' })).toBe('Decision: Use Vite\nWhy: Faster HMR\nContext: Slow builds');
  });
});
