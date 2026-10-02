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
  if (open.length === 0) return '';
  return [
    'You have a plan in progress in this project. It still has these items outstanding:',
    ...open.map((item) => `- ${item.state === 'active' ? '(in progress) ' : ''}${item.text}`),
    '',
    'The request below may be a diversion from it. Deal with the request first, then carry on with the plan and keep it up to date with update_plan. If the request replaces the plan, record the new one instead.',
  ].join('\n');
}

export async function writePlan(root: string, items: readonly PlanItem[], now: string): Promise<Plan> {
  const plan: Plan = { schemaVersion: 1, items: [...items], updatedAt: now };
  const target = path.join(root, PLAN_PATH);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(planSchema.parse(plan), null, 2)}\n`, 'utf8');
  return plan;
}
