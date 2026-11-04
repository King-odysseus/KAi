import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentExecutionResult } from '../apps/desktop/src/main/agent-runtime';
import { continueWhilePlanOpen } from '../apps/desktop/src/main/ipc';
import { writePlan } from '../apps/desktop/src/main/plan-store';

const NOW = '2026-10-02T12:00:00.000Z';
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'kai-continue-'));
  directories.push(root);
  return root;
}

function result(overrides: Partial<AgentExecutionResult> = {}): AgentExecutionResult {
  return { status: 'completed', output: 'did a step', events: [], ...overrides } as AgentExecutionResult;
}

/**
 * A CLI run is a single process, so "carry on" means invoking the agent again. The two things worth pinning are that
 * it only happens for an unfinished plan, and that it never happens to a run somebody stopped.
 */
describe('carrying a CLI run on when its plan is unfinished', () => {
  it('asks again while items remain, and stops when the plan is finished', async () => {
    const root = await project();
    await writePlan(root, 'conv_one', [{ text: 'One', state: 'pending' }], NOW);

    const prompts: string[] = [];
    const outcome = await continueWhilePlanOpen(root, 'conv_one', result(), async (prompt) => {
      prompts.push(prompt);
      // The second round finishes the plan, so no third is asked for.
      await writePlan(root, 'conv_one', [{ text: 'One', state: 'done' }], NOW);
      return result({ output: 'finished the plan', sessionId: `session-${prompts.length}` });
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('One');
    // The account keeps both rounds, so the reader sees the whole thing rather than only the last one.
    expect(outcome.output).toBe('did a step\n\nfinished the plan');
  });

  it('does nothing at all when there is no plan, or nothing left on it', async () => {
    const root = await project();
    let calls = 0;
    const again = async (): Promise<AgentExecutionResult> => { calls += 1; return result(); };

    expect((await continueWhilePlanOpen(root, 'conv_one', result(), again)).output).toBe('did a step');
    await writePlan(root, 'conv_one', [{ text: 'Done', state: 'done' }], NOW);
    await continueWhilePlanOpen(root, 'conv_one', result(), again);
    expect(calls).toBe(0);
  });

  it('never asks a run that failed or was cancelled to carry on', async () => {
    const root = await project();
    await writePlan(root, 'conv_one', [{ text: 'One', state: 'pending' }], NOW);
    let calls = 0;
    const again = async (): Promise<AgentExecutionResult> => { calls += 1; return result(); };

    await continueWhilePlanOpen(root, 'conv_one', result({ status: 'failed' }), again);
    expect(calls).toBe(0);
  });

  it('gives up after the cap, because each round is a whole agent run', async () => {
    const root = await project();
    await writePlan(root, 'conv_one', [{ text: 'Never finishes', state: 'pending' }], NOW);

    let calls = 0;
    await continueWhilePlanOpen(root, 'conv_one', result(), async () => { calls += 1; return result(); }, 2);
    expect(calls).toBe(2);
  });

  it('resumes the same agent session, so each round is not starting over', async () => {
    const root = await project();
    await writePlan(root, 'conv_one', [{ text: 'One', state: 'pending' }], NOW);

    const sessions: Array<string | undefined> = [];
    await continueWhilePlanOpen(root, 'conv_one', result({ sessionId: 'session-first' }), async (prompt, sessionId) => {
      sessions.push(sessionId);
      await writePlan(root, 'conv_one', [{ text: 'One', state: 'done' }], NOW);
      return result();
    });

    expect(sessions).toEqual(['session-first']);
  });
});
