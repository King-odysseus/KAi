import { describe, expect, it } from 'vitest';
import { buildGoalPrompt, completeGoal, createGoal, pauseGoal, resumeGoal, updateGoal } from '../src/core/goal';

describe('goal model', () => {
  const now = new Date('2026-09-12T10:00:00.000Z');

  it('requires an outcome and trims the goal fields', () => {
    expect(() => createGoal({ outcome: '  ' }, now)).toThrow(/needs an outcome/);
    const goal = createGoal({ outcome: '  Ship it  ', constraints: '  no regressions ', verification: ' tests pass ' }, now);
    expect(goal).toMatchObject({
      outcome: 'Ship it',
      constraints: 'no regressions',
      verification: 'tests pass',
      status: 'running',
    });
  });

  it('adds the goal contract to an agent prompt', () => {
    const goal = createGoal({
      outcome: 'Migrate the app to strict TypeScript',
      constraints: 'Do not change runtime behavior',
      verification: 'The full test suite passes',
    }, now);
    const prompt = buildGoalPrompt(goal, 'Start with the parser');
    expect(prompt).toContain('[ACTIVE GOAL]');
    expect(prompt).toContain('Outcome: Migrate the app to strict TypeScript');
    expect(prompt).toContain('Constraints: Do not change runtime behavior');
    expect(prompt).toContain('Definition of done: The full test suite passes');
    expect(prompt).toContain('User instruction:\nStart with the parser');
  });

  it('updates, pauses, resumes, and completes a goal', () => {
    const goal = createGoal({ outcome: 'First' }, now);
    const edited = updateGoal(goal, { outcome: 'Second', verification: 'Verified' }, new Date('2026-09-12T10:01:00Z'));
    expect(edited.id).toBe(goal.id);
    expect(edited.outcome).toBe('Second');
    expect(edited.verification).toBe('Verified');

    const paused = pauseGoal(edited, new Date('2026-09-12T10:02:00Z'));
    expect(paused.status).toBe('paused');
    const resumed = resumeGoal(paused, new Date('2026-09-12T10:03:00Z'));
    expect(resumed.status).toBe('running');
    expect(resumed.pausedAt).toBeUndefined();

    const completed = completeGoal(resumed, new Date('2026-09-12T10:04:00Z'));
    expect(completed.status).toBe('completed');
    expect(completed.completedAt).toBe('2026-09-12T10:04:00.000Z');
  });
});
