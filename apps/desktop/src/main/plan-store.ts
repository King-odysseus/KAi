import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { PLAN_PATH, openPlanItems, planSchema, type Plan, type PlanItem } from '@kai/contracts';

/**
 * Reading and writing the task plan.
 *
 * It lives in the project rather than in a run, so it outlives the run that wrote it: that is what lets a question
 * interrupt the work, get answered, and leave the plan intact for the work to resume. A file also means the person can
 * read it without asking KAI, and the agent can read back what it said it would do.
 *
 * A plan that is missing, unreadable or malformed is no plan. It is a convenience for the run, never a reason to fail
 * one, and a half-written file must not stop somebody working.
 */

export async function readPlan(root: string): Promise<Plan | null> {
  try {
    const raw = await fs.readFile(path.join(root, PLAN_PATH), 'utf8');
    const parsed = planSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * What to tell a run about the plan already in hand, or nothing when there is none or it is finished.
 *
 * This is what makes a diversion survivable. Steering cancels the run and starts the next instruction fresh, so
 * without this the new run has no idea it interrupted anything — the plan would be sitting in the project, unread,
 * while the model answered the new question and stopped. Told about it, the run answers, and then carries on.
 */
export function planBriefingFor(plan: Plan | null): string {
  const open = openPlanItems(plan);
  // The instruction is sent whether or not a plan exists. It used to be sent only alongside an existing plan, which
  // is the wrong way round: a run with no plan is exactly the one that needs to be told to write one, and the tool's
  // own description is easy to skim past. Without this nothing ever starts a plan, and everything downstream of one
  // — knowing when the task is finished, surviving a diversion — never gets the chance to work.
  const parts = [
    'Keep a plan for this project in .kai/plan.json, written with update_plan: a short list of steps and which are done.',
    'Write one before you start anything that takes more than a couple of steps, and update it as you go. It is what tells KAI whether the task is finished, so do not describe the plan in a reply instead of recording it.',
  ];
  if (open.length > 0) {
    parts.push(
      '',
      'A plan is already in progress and still has these outstanding:',
      ...open.map((item) => `- ${item.state === 'active' ? '(in progress) ' : ''}${item.text}`),
      '',
      'The request below may be a diversion from it. Deal with the request first, then carry on with the plan and keep it up to date. If the request replaces the plan, record the new one instead.',
    );
  }
  return parts.join('\n');
}

export async function writePlan(root: string, items: readonly PlanItem[], now: string): Promise<Plan> {
  const plan: Plan = { schemaVersion: 1, items: [...items], updatedAt: now };
  const target = path.join(root, PLAN_PATH);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(planSchema.parse(plan), null, 2)}\n`, 'utf8');
  return plan;
}
