import type { AppSettings, ChangeReviewResult, ReviewFinding } from '@kai/contracts';
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

export type ReviewLearningMode = 'novice' | 'intermediate' | 'expert';

/** What one AI review may read: enough for a real change, small enough to send in one request. */
const MAX_TOTAL_DIFF = 90_000;
const MAX_FILE_DIFF = 16_000;
const MAX_FINDINGS = 20;

export interface ReviewFileDiff {
  path: string;
  diff: string;
}

const FILES_REVIEW_JSON_SCHEMA = {
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
        required: ['file', 'line', 'severity', 'note'],
        properties: {
          file: { type: 'string' },
          line: { type: ['integer', 'null'] },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          note: { type: 'string' },
        },
      },
    },
  },
} as const;

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
  async review(request: string, diff: string, mode: ReviewLearningMode = 'intermediate'): Promise<string | null> {
    if (!diff.trim()) return null;
    const picked = await this.ports.pickConnection();
    if (!('connection' in picked)) return null;
    const result = await this.ports.requester.structuredRequest(
      picked.connection,
      { feature: 'Change review', card: 'Change review' },
      buildReviewPrompt(request, diff, mode),
      'kai_change_review',
      REVIEW_JSON_SCHEMA,
      parseReview,
    );
    return renderReview(result);
  }

  /**
   * Reads the diffs of several files together and returns findings that each name their file. Unlike review() it
   * says why it could not run: a missing connection is an error the user can act on, not a silent nothing.
   */
  async reviewFiles(request: string, files: readonly ReviewFileDiff[], mode: ReviewLearningMode): Promise<ChangeReviewResult> {
    const picked = await this.ports.pickConnection();
    if (!('connection' in picked)) {
      throw new Error(`${picked.reason} AI review needs a model: set one up under Settings, Connections and models (the Prompt Guide or Direct API).`);
    }
    const { text, included, skipped } = packFileDiffs(files);
    if (included.length === 0) {
      return { ok: true, summary: 'There was nothing to read.', findings: [], reviewedFiles: [], skippedFiles: skipped };
    }
    const prompt = buildFilesReviewPrompt(request, text, included, mode);
    const parsed = await this.ports.requester.structuredRequest(
      picked.connection,
      { feature: 'Change review', card: 'Change review' },
      prompt,
      'kai_change_review_files',
      FILES_REVIEW_JSON_SCHEMA,
      (content) => parseFilesReview(content, included),
    );
    return { ...parsed, reviewedFiles: included, skippedFiles: skipped };
  }
}

/** Fits the diffs into one request, trimming each file and leaving out what does not fit, and says what was left out. */
export function packFileDiffs(files: readonly ReviewFileDiff[]): { text: string; included: string[]; skipped: Array<{ file: string; reason: string }> } {
  const included: string[] = [];
  const skipped: Array<{ file: string; reason: string }> = [];
  const parts: string[] = [];
  let used = 0;
  for (const file of files) {
    const diff = file.diff.trim();
    if (!diff) { skipped.push({ file: file.path, reason: 'No text changes to read' }); continue; }
    if (/^Binary files .* differ$/m.test(diff) || diff.includes('GIT binary patch')) { skipped.push({ file: file.path, reason: 'Binary file' }); continue; }
    const body = diff.length > MAX_FILE_DIFF ? `${diff.slice(0, MAX_FILE_DIFF)}\n[diff trimmed]` : diff;
    const part = `=== FILE: ${file.path} ===\n${body}`;
    if (used + part.length > MAX_TOTAL_DIFF) { skipped.push({ file: file.path, reason: 'Too much for one review; review it on its own' }); continue; }
    used += part.length;
    parts.push(part);
    included.push(file.path);
  }
  return { text: parts.join('\n\n'), included, skipped };
}

export function buildFilesReviewPrompt(request: string, diffText: string, files: readonly string[], mode: ReviewLearningMode): { system: string; user: string } {
  const base = buildReviewPrompt(request, '', mode).system;
  const system = [
    base,
    'The diff covers several files, each under a "=== FILE: path ===" heading. Every finding must name the file it is about, exactly as written in a heading.',
    'Give "line" as a line number in the changed file only when the diff lets you be sure of it; otherwise use null.',
    'Read the files together: report a problem that spans them (a rename that left a reference behind, a deleted file something still imports) once, on the file where it shows up.',
  ].join('\n');
  const user = [
    `Review level: ${mode}`,
    `Request:\n${(request.trim() || 'Review these changes for correctness, regressions, security and internal consistency.').slice(0, 4_000)}`,
    `Files (${files.length}): ${files.join(', ')}`,
    `Diff:\n${diffText}`,
  ].join('\n\n');
  return { system, user };
}

/** Reads the reviewer's reply, keeping only findings about files that were actually reviewed. */
export function parseFilesReview(content: string, reviewed: readonly string[]): Omit<ChangeReviewResult, 'reviewedFiles' | 'skippedFiles'> {
  const raw = parseJsonResponse(content, 'change review') as Record<string, unknown>;
  if (typeof raw.ok !== 'boolean' || typeof raw.summary !== 'string') {
    throw new Error('The change review reply did not have the expected shape.');
  }
  const known = (file: string): string | undefined => {
    const clean = file.trim().replace(/\\/g, '/');
    return reviewed.find((path) => path === clean) ?? reviewed.find((path) => clean.endsWith(`/${path}`) || path.endsWith(`/${clean}`));
  };
  const findings = Array.isArray(raw.issues)
    ? raw.issues.flatMap((item): ReviewFinding[] => {
        const value = item as Record<string, unknown> | null;
        if (!value || typeof value.note !== 'string' || !value.note.trim() || typeof value.file !== 'string') return [];
        const file = known(value.file);
        if (!file) return [];
        const severity = value.severity;
        const line = typeof value.line === 'number' && Number.isInteger(value.line) && value.line > 0 ? value.line : undefined;
        return [{
          file,
          ...(line ? { line } : {}),
          severity: severity === 'high' || severity === 'low' ? severity : 'medium',
          note: value.note.trim().slice(0, MAX_TEXT),
        }];
      })
    : [];
  return {
    ok: raw.ok && findings.every((finding) => finding.severity === 'low'),
    summary: raw.summary.trim().slice(0, MAX_TEXT),
    findings: findings.slice(0, MAX_FINDINGS),
  };
}

export function buildReviewPrompt(request: string, diff: string, mode: ReviewLearningMode = 'intermediate'): { system: string; user: string } {
  const teaching = mode === 'novice'
    ? 'Explain each real finding in plain language: what the code does, why the risk matters, and one concrete question the learner can use to inspect it. Avoid unexplained jargon.'
    : mode === 'expert'
      ? 'Use concise, technical findings. Prioritize contracts, data flow, trust boundaries, concurrency, and regression risks; explicitly connect affected modules when the diff supports it.'
      : 'Explain the consequence and relevant dependency or call path for each finding, using standard engineering terminology.';
  const system = [
    'You are a code reviewer inside KAI, a desktop coding workbench. An agent has just changed a project to satisfy a request.',
    'Judge the diff against the request. Look for: the request not actually being met, bugs and unhandled cases, tests deleted or weakened to pass, unrelated changes (scope creep), secrets or credentials added, and risky commands.',
    'Only report a real problem you can point to in the diff. Do not praise, do not restate the change, do not nitpick style, and do not invent files.',
    teaching,
    'Set "ok" to true when there is nothing the user needs to act on. Keep "summary" to one or two sentences. Return only JSON matching the schema, with no markdown fences.',
  ].join('\n');
  return { system, user: `Review level: ${mode}\n\nRequest:\n${request.slice(0, 4_000)}\n\nDiff:\n${diff.slice(0, 100_000)}` };
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
