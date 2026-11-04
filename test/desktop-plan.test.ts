import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planPathFor, openPlanItems, planIsUnfinished, openPlanReminder, type Plan } from '@kai/contracts';
import { planBriefingFor, readPlan, writePlan } from '../apps/desktop/src/main/plan-store';

const NOW = '2026-10-02T10:00:00.000Z';
const TAB = 'conv_one';
const OTHER_TAB = 'conv_two';
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
    await writePlan(root, TAB, [{ text: 'Read the spec', state: 'done' }, { text: 'Write the parser', state: 'active' }], NOW);

    const read = await readPlan(root, TAB);
    expect(read?.items).toHaveLength(2);
    expect(read?.items[1]).toMatchObject({ text: 'Write the parser', state: 'active' });
  });

  it('treats a missing, unreadable, or malformed plan as no plan rather than failing the run', async () => {
    const root = await project();
    expect(await readPlan(root, TAB)).toBeNull();

    await mkdir(path.join(root, '.kai', 'plans'), { recursive: true });
    await writeFile(path.join(root, planPathFor(TAB)!), '{ not json', 'utf8');
    expect(await readPlan(root, TAB)).toBeNull();
  });

  it('keeps the plan of each conversation to itself, so a new tab starts with none', async () => {
    const root = await project();
    await writePlan(root, TAB, [{ text: 'Only for the first tab', state: 'pending' }], NOW);

    expect(await readPlan(root, OTHER_TAB)).toBeNull();
    await writePlan(root, OTHER_TAB, [{ text: 'Second tab work', state: 'done' }], NOW);
    expect((await readPlan(root, TAB))?.items).toEqual([{ text: 'Only for the first tab', state: 'pending' }]);
    expect((await readPlan(root, OTHER_TAB))?.items).toEqual([{ text: 'Second tab work', state: 'done' }]);
  });

  it('ignores the old project-wide plan file and refuses ids that are not safe file names', async () => {
    const root = await project();
    await mkdir(path.join(root, '.kai'), { recursive: true });
    await writeFile(path.join(root, '.kai', 'plan.json'), JSON.stringify(plan([{ text: 'stale', state: 'pending' }])), 'utf8');
    expect(await readPlan(root, TAB)).toBeNull();

    expect(planPathFor('../escape')).toBeNull();
    expect(planPathFor('a/b')).toBeNull();
    expect(await readPlan(root, '../escape')).toBeNull();
    await expect(writePlan(root, '../escape', [], NOW)).rejects.toThrow();
    await expect(writePlan(root, undefined, [], NOW)).rejects.toThrow();
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

    expect(briefing).toContain('plan is already in progress');
    expect(briefing).toContain('Write the parser');
    expect(briefing).toContain('may be a diversion');
  });

  it('tells a run with no plan to write one, which is the half that was missing', () => {
    // It used to say nothing at all without an existing plan — the wrong way round, since a run with no plan is
    // exactly the one that needs telling, and nothing else ever starts one.
    const none = planBriefingFor(null);
    expect(none).toContain('update_plan');
    expect(none).toContain('before you start anything that takes more than a couple of steps');
    // But it does not pretend to have items to report.
    expect(none).not.toContain('already in progress');
    expect(none).not.toContain('may be a diversion');

    // A finished plan is treated the same way: ready for the next task rather than carrying a stale list.
    const finished = planBriefingFor(plan([{ text: 'done', state: 'done' }]));
    expect(finished).toContain('update_plan');
    expect(finished).not.toContain('already in progress');
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
