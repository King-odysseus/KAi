import type { AppSettings, Plan, PlanItem } from '@kai/contracts';
import { parseJsonResponse } from './learning-tutor';
import type { StructuredRequester } from './prompt-guide';

const MAX_MISSING = 5;
const MAX_TEXT = 300;

export interface PlanReviewPorts {
  /** The connection to review with (the Prompt Guide's, else Direct API), or why there is none. */
  pickConnection(): Promise<{ connection: AppSettings['promptGuide'] | AppSettings['directApi'] } | { reason: string }>;
  requester: StructuredRequester;
}

export interface PlanReview {
  /** Steps the request asks for and the plan never mentioned. Empty when the plan covers it. */
  missing: PlanItem[];
  /** One sentence on what the plan is missing, for the log. */
  note: string;
}

const PLAN_REVIEW_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['missing', 'note'],
  properties: {
    missing: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string' } },
      },
    },
    note: { type: 'string' },
  },
} as const;

/**
 * A second model that reads the agent's plan against the task, and says what the plan never covers.
 *
 * The plan is what closes an unattended run — while it has items open the run carries on, and when it is done the
 * run stops — so a plan that quietly covers half the task is a way to look finished. This reads for the missing
 * half. It only ever **adds**: nothing the agent wrote is removed or reworded, because the plan is the agent's own
 * account of the work and an outside reader that rewrites it would be arguing with the one record of what is left.
 */
export class DesktopPlanReviewer {
  constructor(private readonly ports: PlanReviewPorts) {}

  /** What the plan is missing, or null when there is no plan, nothing to add, or no model to ask. */
  async review(request: string, plan: Plan): Promise<PlanReview | null> {
    if (plan.items.length === 0) return null;
    const picked = await this.ports.pickConnection();
    // No connection is not an error here: the run carries on with the plan it has.
    if (!('connection' in picked)) return null;
    const review = await this.ports.requester.structuredRequest(
      picked.connection,
      { feature: 'Plan review', card: 'Plan review' },
      buildPlanReviewPrompt(request, plan),
      'kai_plan_review',
      PLAN_REVIEW_JSON_SCHEMA,
      parsePlanReview,
    );
    return review;
  }
}

export function buildPlanReviewPrompt(request: string, plan: Plan): { system: string; user: string } {
  const system = [
    'You are a planner inside KAI, a desktop coding workbench. An agent is working a task on its own, and the plan below is the agent\'s own account of what is left — the run keeps going while items are open and stops when they are done.',
    'Judge the plan against the request. Name work the request clearly asks for that no item covers.',
    'Only name work the request itself asks for. Do not add polish, tests, documentation or refactors nobody asked for, do not restate the existing items, do not remove or reword anything, and do not invent files.',
    'Write each item as one short line in the same style as the plan, at most five of them.',
    'Set "note" to one sentence saying what the plan does not cover, or that it covers the request. Return only JSON matching the schema, with no markdown fences.',
  ].join('\n');
  const items = plan.items.map((item) => `- [${item.state}] ${item.text}`).join('\n');
  return { system, user: `Request:\n${request.slice(0, 4_000)}\n\nPlan:\n${items}\n\nWhat does the request ask for that the plan never mentions?` };
}

export function parsePlanReview(content: string): PlanReview {
  const raw = parseJsonResponse(content, 'plan review') as Record<string, unknown>;
  if (!Array.isArray(raw.missing) || typeof raw.note !== 'string') {
    throw new Error('The plan review reply did not have the expected shape.');
  }
  const missing = raw.missing.flatMap((entry): PlanItem[] => {
    const text = (entry as Record<string, unknown> | null)?.text;
    if (typeof text !== 'string' || !text.trim()) return [];
    return [{ text: text.trim().slice(0, MAX_TEXT), state: 'pending' as const }];
  });
  return { missing: missing.slice(0, MAX_MISSING), note: raw.note.trim().slice(0, 600) };
}

/**
 * The plan with what the review named added to the end.
 *
 * An item the plan already carries is not added twice, matched on the words rather than the id: an agent that
 * rewrote its own item in different words has still covered that step.
 */
export function mergePlanItems(items: readonly PlanItem[], missing: readonly PlanItem[]): PlanItem[] {
  const known = new Set(items.map((item) => item.text.trim().toLowerCase()));
  return [...items, ...missing.filter((item) => !known.has(item.text.trim().toLowerCase()))];
}
