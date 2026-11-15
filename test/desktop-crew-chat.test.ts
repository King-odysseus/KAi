import { describe, expect, it } from 'vitest';
import { createDefaultCrewConfig, crewConfigSchema, crewRunSchema } from '@kai/contracts';
import type { CrewRun } from '@kai/contracts';
import { addChat, addTasks, continueToNextPhase, isUsageLimit, mergeChat, settle } from '../apps/desktop/src/main/crew-engine';
import { askPrompt, coveragePrompt, parseCoverage, planPrompt } from '../apps/desktop/src/main/crew-prompts';

const T0 = '2026-11-01T10:00:00.000Z';
const T1 = '2026-11-01T10:05:00.000Z';

function accepted(): CrewRun {
  const config = crewConfigSchema.parse(createDefaultCrewConfig('claude', 'codex'));
  const base = crewRunSchema.parse({
    schemaVersion: 1, id: 'run_1', projectId: 'p1', goal: 'Build Zuri from the plan', status: 'running', config,
    tasks: [], feed: [], startedAt: T0, updatedAt: T0,
  });
  const { run } = addTasks(base, [{ id: 'spike', title: 'Phase 0 spike', role: 'builder', acceptance: ['It works'] }], T0);
  return { ...run, tasks: run.tasks.map((task) => ({ ...task, status: 'accepted' as const })) };
}

describe('the thread between the person and the Lead', () => {
  it('adds lines in order and keeps only the newest 200', () => {
    let run = accepted();
    for (let index = 0; index < 205; index += 1) run = addChat(run, { from: 'you', kind: 'ask', text: `q${index}` }, T1);
    expect(run.chat).toHaveLength(200);
    expect(run.chat[0]?.text).toBe('q5');
    expect(run.chat.at(-1)?.text).toBe('q204');
  });

  it('joins two copies by id so a line added during another save is not lost', () => {
    const one = addChat(accepted(), { from: 'you', kind: 'ask', text: 'first' }, '2026-11-01T10:01:00.000Z');
    const two = addChat(one, { from: 'lead', kind: 'answer', text: 'second' }, '2026-11-01T10:02:00.000Z');
    const merged = mergeChat(two.chat, one.chat);
    expect(merged.map((entry) => entry.text)).toEqual(['first', 'second']);
  });
});

describe('finishing honestly', () => {
  it('says what is left when the Lead found more of the plan undone', () => {
    const run = { ...accepted(), remaining: ['Phase 1: Shell', 'Phase 2: Providers'] };
    const done = settle(run, T1);
    expect(done.status).toBe('completed');
    expect(done.feed.at(-1)?.text).toContain('Not finished yet: Phase 1: Shell; Phase 2: Providers');
    expect(done.feed.at(-1)?.text).not.toContain('project is done');
  });

  it('still says the project is done when nothing is left', () => {
    expect(settle(accepted(), T1).feed.at(-1)?.text).toBe('Every task is accepted. The project is done.');
  });

  it('moves a running board straight to planning the next phase, and tells the planner to plan only that', () => {
    const next = continueToNextPhase({ ...accepted(), keepGoing: true }, ['Phase 1: Shell', 'Phase 2: Providers'], T1);
    expect(next.status).toBe('planning');
    expect(next.followUp).toContain('Phase 1: Shell');
    expect(next.followUp).toContain('Phase 2: Providers');
    expect(next.followUp).toContain('do not wait for their acceptance');
    expect(planPrompt(next.goal, next.config, '', next)).toContain('Plan only this');
  });
});

describe('recognising an agent that has run out of usage', () => {
  it('reads the usual ways a subscription or credit runs out', () => {
    for (const text of [
      'You have reached your usage limit. Try again at 3pm.',
      'Rate limit exceeded',
      'Error: quota exceeded for this plan',
      'Your credit balance is too low to run this request.',
      'HTTP 429 Too Many Requests',
      'status 429',
      'You have reached your 5-hour limit.',
    ]) expect(isUsageLimit(text), text).toBe(true);
  });

  it('does not mistake an ordinary failure, or a line number, for a spent subscription', () => {
    for (const text of [
      'The agent crashed.',
      'The build tool crashed.',
      'desktop/scripts/verify-web-unchanged.mjs:429 threw a TypeError',
      'Cannot find module "express"',
    ]) expect(isUsageLimit(text), text).toBe(false);
  });
});

describe('the Lead coverage check', () => {
  it('reads a finished goal, and a list of what is left', () => {
    expect(parseCoverage('{"complete":true}')).toEqual({ remaining: [] });
    expect(parseCoverage('Here: {"complete":false,"remaining":["Phase 1: Shell"," ","Phase 2"]}')).toEqual({ remaining: ['Phase 1: Shell', 'Phase 2'] });
  });

  it('reads nothing from prose, so an unreadable answer never blocks a finish', () => {
    expect(parseCoverage('It looks done to me.')).toBeNull();
    expect(parseCoverage('{"remaining":["x"]}')).toBeNull();
  });

  it('shows the Lead the goal, the accepted work and what skipping did', () => {
    const run = accepted();
    const prompt = coveragePrompt(run);
    expect(prompt).toContain('Build Zuri from the plan');
    expect(prompt).toContain('- Phase 0 spike');
    expect(prompt).toContain('read any plan or specification file the goal names');
  });

  it('puts the board, the recent activity and the question in front of the Lead, and forbids changes', () => {
    const run = addChat(accepted(), { from: 'you', kind: 'ask', text: 'What is done?' }, T1);
    const prompt = askPrompt(run, 'What is blocking Phase 1?');
    expect(prompt).toContain('What is blocking Phase 1?');
    expect(prompt).toContain('Phase 0 spike [accepted]');
    expect(prompt).toContain('Do not change any files');
  });
});
