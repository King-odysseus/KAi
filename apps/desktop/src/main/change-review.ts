import type { AppSettings } from '@kai/contracts';
import { parseJsonResponse } from './learning-tutor';
import type { StructuredRequester } from './prompt-guide';

const MAX_ISSUES = 8;
const MAX_TEXT = 600;

export interface ReviewIssue {
  file: string;
  severity: 'high' | 'medium' | 'low';
  note: string;
}

export interface ChangeReview {
  /** True when the change does what was asked and nothing in it needs the user's attention. */
  ok: boolean;
  summary: string;
  issues: ReviewIssue[];
}

export interface ChangeReviewPorts {
  /** The connection to review with (the Prompt Guide's, else Direct API), or why there is none. */
  pickConnection(): Promise<{ connection: AppSettings['promptGuide'] | AppSettings['directApi'] } | { reason: string }>;
  requester: StructuredRequester;
}

const REVIEW_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'summary', 'issues'],
  properties: {
    ok: { type: 'boolean' },
    summary: { type: 'string' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'severity', 'note'],
        properties: {
          file: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          note: { type: 'string' },
        },
      },
    },
  },
} as const;

/** A second model that reads a finished change against the request, and never edits anything itself. */
export class DesktopChangeReviewer {
  constructor(private readonly ports: ChangeReviewPorts) {}

  /** A short markdown verdict for the transcript, or null when there is nothing to review or no model to do it. */
  async review(request: string, diff: string): Promise<string | null> {
    if (!diff.trim()) return null;
    const picked = await this.ports.pickConnection();
    if (!('connection' in picked)) return null;
    const result = await this.ports.requester.structuredRequest(
      picked.connection,
      { feature: 'Change review', card: 'Change review' },
      buildReviewPrompt(request, diff),
      'kai_change_review',
      REVIEW_JSON_SCHEMA,
      parseReview,
    );
    return renderReview(result);
  }
}

export function buildReviewPrompt(request: string, diff: string): { system: string; user: string } {
  const system = [
    'You are a code reviewer inside KAI, a desktop coding workbench. An agent has just changed a project to satisfy a request.',
    'Judge the diff against the request. Look for: the request not actually being met, bugs and unhandled cases, tests deleted or weakened to pass, unrelated changes (scope creep), secrets or credentials added, and risky commands.',
    'Only report a real problem you can point to in the diff. Do not praise, do not restate the change, do not nitpick style, and do not invent files.',
    'Set "ok" to true when there is nothing the user needs to act on. Keep "summary" to one or two sentences. Return only JSON matching the schema, with no markdown fences.',
  ].join('\n');
  return { system, user: `Request:\n${request.slice(0, 4_000)}\n\nDiff:\n${diff}` };
}

export function parseReview(content: string): ChangeReview {
  const raw = parseJsonResponse(content, 'change review') as Record<string, unknown>;
  const issues = Array.isArray(raw.issues)
    ? raw.issues.flatMap((item): ReviewIssue[] => {
        const value = item as Record<string, unknown> | null;
        const severity = value?.severity;
        if (!value || typeof value.note !== 'string' || !value.note.trim()) return [];
        return [{
          file: typeof value.file === 'string' ? value.file.slice(0, 300) : '',
          severity: severity === 'high' || severity === 'low' ? severity : 'medium',
          note: value.note.trim().slice(0, MAX_TEXT),
        }];
      })
    : [];
  if (typeof raw.ok !== 'boolean' || typeof raw.summary !== 'string') {
    throw new Error('The change review reply did not have the expected shape.');
  }
  return { ok: raw.ok && issues.every((issue) => issue.severity === 'low'), summary: raw.summary.trim().slice(0, MAX_TEXT), issues: issues.slice(0, MAX_ISSUES) };
}

export function renderReview(review: ChangeReview): string {
  if (review.ok && review.issues.length === 0) return `Review: no problems found. ${review.summary}`.trim();
  const lines = review.issues.map((issue) => `- ${issue.severity.toUpperCase()}${issue.file ? ` in ${issue.file}` : ''}: ${issue.note}`);
  return [`Review: ${review.ok ? 'minor notes' : 'needs your attention'}. ${review.summary}`.trim(), ...lines].join('\n');
}
