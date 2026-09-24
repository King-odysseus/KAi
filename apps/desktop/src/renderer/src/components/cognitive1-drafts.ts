import type { BrainEntryType } from '@kai/contracts';

/**
 * Overwatch's opinion about one draft. `keep` and `noise` are calls Overwatch is willing to make by itself once its
 * confidence clears the auto-reject threshold; `borderline` is always handed back to a human.
 */
export type DraftVerdict = 'keep' | 'noise' | 'borderline';

/** What the reviewer wants done with a draft. `null` means "leave it in the queue for now". */
export type DraftMark = 'approve' | 'reject' | null;

export type VerdictSource = 'annotation' | 'overwatch';

export interface DraftRow {
  /** Position in the draft queue. This is the only identifier any C1 endpoint accepts, and it shifts on every change. */
  index: number;
  title: string;
  /** The `#type:` the entry will be filed under. `unknown` when neither the block nor the daemon could name one. */
  type: string;
  /** The daemon reports the *agent* that wrote the draft in its `project` field, so it is labelled as such here. */
  agent: string;
  /** A real project name, only when the block carries an explicit `**Project:**` field. */
  project: string | null;
  tags: string[];
  verdict: DraftVerdict | null;
  confidence: number | null;
  reason: string | null;
  /** Where Overwatch would move the entry before approving it, when it disagrees with the `#type:` in the block. */
  suggestedType: BrainEntryType | null;
  verdictSource: VerdictSource | null;
}

export interface DraftCounts {
  total: number;
  keep: number;
  noise: number;
  borderline: number;
  /** Drafts Overwatch has not looked at: no annotation, and no classification asked for yet. */
  unclassified: number;
  /** Drafts that will not move unless a human marks them. */
  needsHuman: number;
}

export interface DraftDecision {
  index: number;
  action: 'approve' | 'reject';
}

export interface DraftTypeChange {
  index: number;
  type: BrainEntryType;
}

/** A reviewer's mark, remembered against the draft title so a refresh that renumbers the queue cannot misapply it. */
export interface StoredMark {
  title: string;
  mark: DraftMark;
}

export type MarkBook = Record<number, StoredMark>;

export const BRAIN_TYPES: readonly BrainEntryType[] = ['bugs', 'decisions', 'gotchas', 'patterns'];

export function isBrainType(value: unknown): value is BrainEntryType {
  return typeof value === 'string' && (BRAIN_TYPES as readonly string[]).includes(value);
}

const VERDICT_ANNOTATION = /^#overwatch:\s*(keep|noise|borderline)\b[^\n]*/im;
const TYPE_ANNOTATION = /^#type:\s*(.+)$/im;
const TAGS_ANNOTATION = /^#tags:\s*(.+)$/im;
const PROJECT_FIELD = /^\*\*project:?\*\*\s*(.+)$/im;
const TYPE_WORD = /(bugs|decisions|gotchas|patterns)/;

/**
 * Reads the verdict Overwatch writes into a draft block, e.g. `#overwatch: keep (85% confidence)` or
 * `#overwatch: borderline (noise@70%: restates a known gotcha)`.
 *
 * These annotations are trusted by the daemon at face value, so showing them costs nothing: a draft that already
 * carries one needs no model call to display a verdict. That is why the review queue can render immediately.
 */
export function parseDraftVerdict(raw: string): Pick<DraftRow, 'verdict' | 'confidence' | 'reason'> | null {
  const line = VERDICT_ANNOTATION.exec(raw)?.[0];
  if (!line) return null;
  const verdict = /^#overwatch:\s*(keep|noise|borderline)/i.exec(line)?.[1]?.toLowerCase() as DraftVerdict;
  return { verdict, confidence: annotationConfidence(line, verdict), reason: annotationReason(line) };
}

/** `(85% confidence)` and `noise@70%` both carry a percentage; either one is the confidence Overwatch settled on. */
function annotationConfidence(line: string, verdict: DraftVerdict): number {
  const percent = /(\d{1,3})\s*%/.exec(line)?.[1];
  if (percent !== undefined) return Math.min(1, Number(percent) / 100);
  // Without a percentage the daemon means it trusted the annotation outright: a keep or noise is certain and a
  // borderline is a coin toss. Matching those values keeps the badge consistent with what resolve-preview reports.
  return verdict === 'borderline' ? 0.5 : 1;
}

function annotationReason(line: string): string | null {
  const inner = /\(([^()]*)\)\s*$/.exec(line.trim())?.[1]?.trim();
  if (!inner) return null;
  const cleaned = inner
    .replace(/^(?:noise|keep|borderline)\s*@\s*\d{1,3}\s*%?\s*:?\s*/i, '')
    .replace(/^\d{1,3}\s*%\s*confidence\s*/i, '')
    .replace(/^[-–—:,\s]+/, '')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Reads the draft queue from either shape C1 hands it over in: the `{ drafts, count }` body that `GET
 * /api/brain/drafts` returns, or a bare array.
 */
export function draftRows(value: unknown): DraftRow[] {
  const queued = Array.isArray(value) ? value : record(value).drafts;
  return records(queued).map((draft, position) => {
    const raw = typeof draft.raw === 'string' ? draft.raw : '';
    const annotation = parseDraftVerdict(raw);
    const index = typeof draft.index === 'number' && Number.isInteger(draft.index) ? draft.index : position;
    return {
      index,
      title: text(draft.title) ?? `Draft ${index + 1}`,
      type: draftType(raw, draft.type),
      agent: text(draft.project) ?? 'unknown',
      project: text(PROJECT_FIELD.exec(raw)?.[1]) ?? null,
      tags: draftTags(raw),
      verdict: annotation?.verdict ?? null,
      confidence: annotation?.confidence ?? null,
      reason: annotation?.reason ?? null,
      suggestedType: null,
      verdictSource: annotation ? 'annotation' : null,
    };
  });
}

/** The daemon's own fallback order: an explicit `#type:`, then a brain type named anywhere in the block, then unknown. */
function draftType(raw: string, fallback: unknown): string {
  const annotated = TYPE_ANNOTATION.exec(raw)?.[1]?.trim().toLowerCase();
  if (annotated) return annotated;
  const mentioned = TYPE_WORD.exec(raw)?.[1];
  if (mentioned) return mentioned;
  return text(fallback) ?? 'unknown';
}

function draftTags(raw: string): string[] {
  const line = TAGS_ANNOTATION.exec(raw)?.[1];
  if (!line) return [];
  return line.split(',').map((tag) => tag.trim()).filter((tag) => tag.length > 0);
}

/**
 * Folds an `overwatch-resolve-preview` result onto the rows it classified. Overwatch wins over a stale annotation
 * because the preview re-reads every block, and a draft it could not place keeps whatever the queue already said.
 */
export function applyClassifications(rows: DraftRow[], value: unknown): DraftRow[] {
  const classified = records(record(value).classifications);
  if (classified.length === 0) return rows;
  const byIndex = new Map<number, Record<string, unknown>>();
  for (const entry of classified) {
    if (typeof entry.index === 'number' && Number.isInteger(entry.index)) byIndex.set(entry.index, entry);
  }
  return rows.map((row) => {
    const entry = byIndex.get(row.index);
    if (!entry) return row;
    return {
      ...row,
      verdict: verdictOf(entry.verdict) ?? row.verdict,
      confidence: typeof entry.confidence === 'number' ? entry.confidence : row.confidence,
      reason: text(entry.reason) ?? row.reason,
      suggestedType: isBrainType(entry.suggestedType) ? entry.suggestedType : row.suggestedType,
      verdictSource: 'overwatch',
    };
  });
}

function verdictOf(value: unknown): DraftVerdict | null {
  return value === 'keep' || value === 'noise' || value === 'borderline' ? value : null;
}

/**
 * The mark a draft starts with: Overwatch's keep becomes an approval and its noise becomes a rejection, so agreeing
 * with Overwatch is one click. Borderline and unclassified drafts start unmarked, which is what makes them the queue.
 */
export function defaultMark(row: DraftRow): DraftMark {
  if (row.verdict === 'keep') return 'approve';
  if (row.verdict === 'noise') return 'reject';
  return null;
}

/**
 * The mark in force for a row: the reviewer's own mark when it still refers to this draft, otherwise the default.
 * A mark is only honoured while the title at that index is unchanged, so a refresh that renumbers the queue drops
 * stale marks instead of applying someone else's decision to the wrong entry.
 */
export function markFor(row: DraftRow, marks: MarkBook): DraftMark {
  const stored = marks[row.index];
  if (stored && stored.title === row.title) return stored.mark;
  return defaultMark(row);
}

export function marksForAll(rows: DraftRow[], mark: DraftMark): MarkBook {
  const next: MarkBook = {};
  for (const row of rows) next[row.index] = { title: row.title, mark };
  return next;
}

/**
 * Every mark that would move a draft, ordered highest index first.
 *
 * The C1 API identifies a draft only by its position in the queue, and approving or rejecting removes the block, so
 * acting low-to-high would renumber every draft still to come and act on the wrong entries. Descending order keeps
 * each index valid at the moment it is used.
 */
export function planDecisions(rows: DraftRow[], marks: MarkBook): DraftDecision[] {
  return rows
    .map((row) => ({ index: row.index, action: markFor(row, marks) }))
    .filter((entry): entry is DraftDecision => entry.action === 'approve' || entry.action === 'reject')
    .sort((left, right) => right.index - left.index);
}

/**
 * Retype approvals that Overwatch disagrees with before they are filed.
 *
 * A draft is approved by copying its block verbatim into `brain/learned/<type>.md`, so the `#type:` has to be
 * rewritten first. `drafts/type` edits the block in place without moving it, so the indices this plan reuses stay
 * valid, and it runs before the approvals for the same reason they run highest-first.
 */
export function planTypeChanges(
  rows: DraftRow[],
  decisions: DraftDecision[],
  adoptSuggestedTypes: boolean,
): DraftTypeChange[] {
  if (!adoptSuggestedTypes) return [];
  const approved = new Set(decisions.filter((decision) => decision.action === 'approve').map((decision) => decision.index));
  return rows
    .filter((row) => approved.has(row.index) && row.suggestedType !== null && row.suggestedType !== row.type)
    .map((row) => ({ index: row.index, type: row.suggestedType as BrainEntryType }))
    .sort((left, right) => right.index - left.index);
}

export function draftCounts(rows: DraftRow[]): DraftCounts {
  const counts: DraftCounts = { total: rows.length, keep: 0, noise: 0, borderline: 0, unclassified: 0, needsHuman: 0 };
  for (const row of rows) {
    if (row.verdict === 'keep') counts.keep += 1;
    else if (row.verdict === 'noise') counts.noise += 1;
    else if (row.verdict === 'borderline') counts.borderline += 1;
    else counts.unclassified += 1;
  }
  counts.needsHuman = counts.borderline + counts.unclassified;
  return counts;
}

export interface RecapLine {
  tone: 'info' | 'good' | 'warn';
  text: string;
}

/**
 * The plain-language answer to "what is waiting on me", for the top of the review screen. It states what Overwatch
 * has already decided, what it cannot decide, and whether asking it for more verdicts will cost anything.
 */
export function reviewRecap(input: {
  counts: DraftCounts;
  overwatch: { enabled: boolean; ready: boolean };
  urgentCount: number;
  insights: string[];
}): RecapLine[] {
  const { counts, overwatch, urgentCount, insights } = input;
  const lines: RecapLine[] = [];

  if (counts.total === 0) {
    lines.push({ tone: 'good', text: 'No drafts are waiting for review.' });
  } else {
    const decides: string[] = [];
    if (counts.keep > 0) decides.push(`${counts.keep} worth keeping`);
    if (counts.noise > 0) decides.push(`${counts.noise} that look like noise`);
    if (decides.length > 0) {
      lines.push({ tone: 'info', text: `Overwatch has a verdict on ${counts.keep + counts.noise} of ${counts.total} drafts: ${decides.join(', ')}.` });
    }
    if (counts.borderline > 0) {
      lines.push({ tone: 'warn', text: `${counts.borderline} draft(s) came back borderline. Overwatch leaves those to you.` });
    }
    if (counts.unclassified > 0) {
      lines.push({ tone: 'info', text: `${counts.unclassified} draft(s) have no verdict yet. Asking Overwatch costs one model call each.` });
    }
    if (counts.needsHuman === 0) {
      lines.push({ tone: 'good', text: 'Every draft has a verdict, so accepting them all is a single action below.' });
    }
  }

  if (!overwatch.enabled) {
    lines.push({ tone: 'warn', text: 'Overwatch is off, so new drafts arrive unclassified. Configure it under Settings, C1 Brain, AI Overwatch.' });
  } else if (!overwatch.ready) {
    lines.push({ tone: 'warn', text: 'Overwatch is configured but has no API key, so drafts stay unclassified until you add one.' });
  }

  if (urgentCount > 0) {
    lines.push({ tone: 'warn', text: `${urgentCount} urgent note(s) are pinned for every agent working in this brain.` });
  }

  const latest = insights[0];
  if (typeof latest === 'string' && latest.trim().length > 0) {
    lines.push({ tone: 'info', text: `Most recent Overwatch activity: ${latest.trim()}` });
  }

  return lines;
}

/**
 * Whether applying a decision contradicts Overwatch, which is what C1 records as a correction and shows the
 * classifier from then on. Mirrors the daemon's own rule: rejecting a draft it did not call noise, or approving
 * one it did. Agreement teaches nothing, and approving a borderline only settles Overwatch's own doubt.
 */
export function isOverrule(action: DraftDecision['action'], verdict: DraftVerdict | null): boolean {
  if (verdict === null) return false;
  if (action === 'reject') return verdict !== 'noise';
  return verdict === 'noise';
}

/** How many of the planned decisions will be recorded as corrections to Overwatch. */
export function countOverrules(rows: DraftRow[], decisions: DraftDecision[]): number {
  const verdicts = new Map(rows.map((row) => [row.index, row.verdict]));
  return decisions.filter((decision) => isOverrule(decision.action, verdicts.get(decision.index) ?? null)).length;
}

/**
 * The corrections Overwatch has been taught, as C1 reports them. `null` when the connected engine predates
 * learning and sends no count, so the UI says nothing rather than claiming a zero it cannot know.
 */
export function learnedCorrections(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Splits a decision plan into the counts a confirmation dialog needs to be specific. */
export function describeDecisions(decisions: DraftDecision[]): { approvals: number; rejections: number } {
  return {
    approvals: decisions.filter((decision) => decision.action === 'approve').length,
    rejections: decisions.filter((decision) => decision.action === 'reject').length,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record).filter((item) => Object.keys(item).length > 0) : [];
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
