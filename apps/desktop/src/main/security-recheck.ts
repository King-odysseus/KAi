import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SecurityFindingReportItem } from '@kai/contracts';
import type { ClaimCheck, ClaimToCheck } from './change-review';

/**
 * A second, sceptical look at an audit's findings before they are filed. A finding is never dropped here: a missed
 * vulnerability costs far more than a false alarm, so a doubt is written into the evidence for the person to weigh.
 */
const CONTEXT_LINES = 15;
const MAX_SNIPPET_CHARS = 3_000;
const MAX_FILE_BYTES = 400_000;

/** `src/app.ts:42`, `src/app.ts line 42`, `src/app.ts (lines 42-50)`. Undefined when no file can be read from it. */
export function parseLocation(location: string): { file: string; line?: number } | undefined {
  const match = /^\s*([^\s:()]+\.[A-Za-z0-9]{1,8})(?:\s*[:(]\s*(?:lines?\s*)?(\d+))?/i.exec(location);
  if (!match) return undefined;
  const line = match[2] ? Number(match[2]) : undefined;
  return { file: match[1].replace(/\\/g, '/'), ...(line && line > 0 ? { line } : {}) };
}

/** The lines around `line` (or the top of the file), numbered so the checker can refer to them. */
export function snippetAround(text: string, line?: number): string {
  const lines = text.split(/\r?\n/);
  const centre = line ? line - 1 : 0;
  const start = Math.max(0, centre - CONTEXT_LINES);
  const end = Math.min(lines.length, centre + CONTEXT_LINES + 1);
  return lines.slice(start, end).map((value, index) => `${start + index + 1}: ${value}`).join('\n').slice(0, MAX_SNIPPET_CHARS);
}

async function readSnippet(projectPath: string, location: string): Promise<string> {
  const parsed = parseLocation(location);
  if (!parsed) return '';
  try {
    const root = await fs.realpath(projectPath);
    const target = await fs.realpath(path.resolve(root, parsed.file));
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return '';
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return '';
    return snippetAround(await fs.readFile(target, 'utf8'), parsed.line);
  } catch {
    return '';
  }
}

export interface ClaimChecker {
  checkClaims(claims: readonly ClaimToCheck[]): Promise<Map<number, ClaimCheck>>;
}

/** The evidence with the second check's doubt written into it. A confirmed finding is left exactly as it was. */
export function annotateEvidence(evidence: string, check: ClaimCheck | undefined): string {
  if (!check || check.verdict === 'confirmed') return evidence;
  const lead = check.verdict === 'rejected'
    ? 'Second check disagreed (kept for you to judge, not dropped)'
    : 'Second check could not confirm this from the code alone';
  const reason = check.reason.trim().slice(0, 400);
  return `${lead}${reason ? `: ${reason}` : '.'}\n\n${evidence}`.slice(0, 4_000);
}

/** Runs the check over a report's findings. If the checker is missing or fails, every finding is returned as it was. */
export async function recheckReportItems(
  items: readonly SecurityFindingReportItem[],
  projectPath: string,
  checker: ClaimChecker | undefined,
): Promise<SecurityFindingReportItem[]> {
  if (!checker || items.length === 0) return [...items];
  try {
    const claims: ClaimToCheck[] = [];
    for (const item of items) {
      claims.push({ claim: `[${item.severity}] ${item.title} (${item.vulnClass})`, location: item.location, evidence: item.evidence, snippet: await readSnippet(projectPath, item.location) });
    }
    const checks = await checker.checkClaims(claims);
    return items.map((item, index) => ({ ...item, evidence: annotateEvidence(item.evidence, checks.get(index)) }));
  } catch {
    return [...items];
  }
}
