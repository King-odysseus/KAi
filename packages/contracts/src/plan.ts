import { z } from 'zod';

/**
 * The plan for the task in hand: what the agent intends to do, and how far it has got.
 *
 * This exists because the run used to have no idea what it was doing. Everything KAI knew about the task was the last
 * prompt, so "is this finished?" could only be guessed at from how the model's last sentence was phrased — which is
 * why a reply ending "tell me the remote and I will push" was read as a broken promise and nudged away, question and
 * all, and why a run that stopped mid-task could not say what was left.
 *
 * With a plan written down, the question has an answer that is looked up rather than inferred: open items mean the
 * work is not done. It also gives the person something to read, which the transcript alone never did.
 *
 * It is stored in the project (`.kai/plan.json`) rather than in the run, because a run ends and a project does not —
 * a plan has to outlive the thing that wrote it for a diversion to be survivable.
 */

export const PLAN_ITEM_STATES = ['pending', 'active', 'done'] as const;
export type PlanItemState = (typeof PLAN_ITEM_STATES)[number];
export const planItemStateSchema = z.enum(PLAN_ITEM_STATES);

export const planItemSchema = z
  .object({
    /** What is to be done, in the agent's words, short enough to read at a glance. */
    text: z.string().trim().min(1).max(300),
    state: planItemStateSchema.default('pending'),
  })
  .strict();
export type PlanItem = z.infer<typeof planItemSchema>;

export const planSchema = z
  .object({
    schemaVersion: z.literal(1),
    items: z.array(planItemSchema).max(50),
    updatedAt: z.string().min(1),
  })
  .strict();
export type Plan = z.infer<typeof planSchema>;

/** Where the plan lives, relative to the project root. */
export const PLAN_PATH = '.kai/plan.json';

export function openPlanItems(plan: Plan | null): PlanItem[] {
  return plan ? plan.items.filter((item) => item.state !== 'done') : [];
}

/** True when there is a plan and it still has something outstanding. */
export function planIsUnfinished(plan: Plan | null): boolean {
  return openPlanItems(plan).length > 0;
}

/**
 * What to tell the model when it stopped with work still on the plan. Written in the plan's own terms rather than as
 * a general instruction, so a model that lost the thread is handed the thread back.
 */
export function openPlanReminder(plan: Plan): string {
  const open = openPlanItems(plan);
  const lines = open
    .map((item) => `- ${item.state === 'active' ? '(in progress) ' : ''}${item.text}`)
    .join('\n');
  return `Your plan still has ${open.length} item${open.length === 1 ? '' : 's'} outstanding:\n${lines}\n\nCarry on with the next one. If the plan is wrong or finished, call update_plan with the corrected list and then answer.`;
}
