import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PLAN_PATH, openPlanItems, planIsUnfinished, openPlanReminder, type Plan } from '@kai/contracts';
import { planBriefingFor, readPlan, writePlan } from '../apps/desktop/src/main/plan-store';

const NOW = '2026-10-02T10:00:00.000Z';
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'kai-plan-'));
  directories.push(root);
  return root;
}

function plan(items: Array<{ text: string; state: 'pending' | 'active' | 'done' }>): Plan {
  return { schemaVersion: 1, items, updatedAt: NOW };
}

/**
 * The plan is what the run consults to decide whether it is finished, so the two things worth testing are that it is
 * read back faithfully and that "finished" means what it says.
 */
describe('the task plan', () => {
  it('survives a round trip, which is what lets it outlive a run', async () => {
    const root = await project();
    await writePlan(root, [{ text: 'Read the spec', state: 'done' }, { text: 'Write the parser', state: 'active' }], NOW);

    const read = await readPlan(root);
    expect(read?.items).toHaveLength(2);
    expect(read?.items[1]).toMatchObject({ text: 'Write the parser', state: 'active' });
  });

  it('treats a missing, unreadable, or malformed plan as no plan rather than failing the run', async () => {
    const root = await project();
    expect(await readPlan(root)).toBeNull();

    await mkdir(path.join(root, '.kai'), { recursive: true });
    await writeFile(path.join(root, PLAN_PATH), '{ not json', 'utf8');
    expect(await readPlan(root)).toBeNull();
  });

  it('counts only unfinished items, so a plan of done work ends the run', () => {
    expect(openPlanItems(plan([{ text: 'a', state: 'done' }, { text: 'b', state: 'done' }]))).toHaveLength(0);
    expect(planIsUnfinished(plan([{ text: 'a', state: 'done' }]))).toBe(false);
    expect(planIsUnfinished(plan([{ text: 'a', state: 'done' }, { text: 'b', state: 'pending' }]))).toBe(true);
    expect(planIsUnfinished(null)).toBe(false);
  });

  it('tells a new run what it interrupted, which is what makes a diversion survivable', () => {
    // Steering cancels the run and starts the next instruction fresh, so this note is the only thing that connects
    // the new run to the work it interrupted.
    const briefing = planBriefingFor(plan([
      { text: 'Read the spec', state: 'done' },
      { text: 'Write the parser', state: 'pending' },
    ]));

    expect(briefing).toContain('plan in progress');
    expect(briefing).toContain('Write the parser');
    expect(briefing).toContain('may be a diversion');
    // Nothing to say when there is no plan, or nothing left on it.
    expect(planBriefingFor(null)).toBe('');
    expect(planBriefingFor(plan([{ text: 'done', state: 'done' }]))).toBe('');
  });

  it('hands back the outstanding items by name, so a model that lost the thread gets it back', () => {
    const reminder = openPlanReminder(plan([
      { text: 'Read the spec', state: 'done' },
      { text: 'Write the parser', state: 'active' },
      { text: 'Add the tests', state: 'pending' },
    ]));

    expect(reminder).toContain('2 items outstanding');
    expect(reminder).toContain('(in progress) Write the parser');
    expect(reminder).toContain('Add the tests');
    // The finished one is not repeated back at it.
    expect(reminder).not.toContain('Read the spec');
  });
});
