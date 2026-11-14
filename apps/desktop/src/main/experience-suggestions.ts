import type { AgentExperience } from './experience-store';
import { redactText } from '@kai/runtime';

export interface MemoryImprovementSuggestion {
  projectId: string;
  title: string;
  note: string;
  occurrences: number;
  examples: string[];
}

const CORRECTION_PREFIX = /^(?:(?:no|nope|actually|that's not right|that is not right|you missed|you misunderstood|wrong|not quite|i meant|i mean|please don't|please do not|stop doing|instead)\b[\s,:;.!-]*)+/i;
const STOP_WORDS = new Set('a an and are as at be but by can could did do does for from had has have i in is it its me my of on or our please so that the theirs them then there this to was we were with you your'.split(' '));

/**
 * Finds repeated explicit corrections in locally captured requests. It never writes memory: each suggestion is
 * handed to the existing Save to Brain editor so the user can revise or discard it first.
 */
export function suggestMemoryImprovements(records: readonly AgentExperience[]): MemoryImprovementSuggestion[] {
  const groups = new Map<string, { projectId: string; requests: string[]; recordIds: string[]; files: Set<string> }>();
  for (const record of records) {
    const request = redactText(record.request);
    if (record.memorySuggestionReviewed || record.outcome === 'cancelled' || !isCorrection(request)) continue;
    const correction = normalizeCorrection(request);
    if (!correction) continue;
    const key = `${record.projectId}\0${correction}`;
    const group = groups.get(key) ?? { projectId: record.projectId, requests: [], recordIds: [], files: new Set<string>() };
    group.requests.push(request.slice(0, 4_000));
    group.recordIds.push(record.id);
    for (const change of record.changes) group.files.add(redactText(change.path));
    groups.set(key, group);
  }

  return [...groups.entries()]
    .filter(([, group]) => group.requests.length >= 2)
    .map(([key, group]) => {
      const correction = key.slice(key.indexOf('\0') + 1);
      const examples = group.requests.slice(0, 3);
      const file = [...group.files][0];
      const subject = file ? ` around ${file}` : '';
      const title = `Repeated correction${subject}`.slice(0, 80);
      const note = [
        `This correction appeared in ${group.requests.length} separate local runs${subject}.`,
        `Consider saving a project rule: ${correction}`,
        'Keep the rule only if it should guide future work in this project.',
      ].join('\n\n');
      return { projectId: group.projectId, title, note, occurrences: group.requests.length, examples, recordIds: group.recordIds };
    })
    .sort((left, right) => right.occurrences - left.occurrences)
    .slice(0, 10);
}

function isCorrection(value: string): boolean {
  return CORRECTION_PREFIX.test(value.trim()) || /\b(?:you missed|you misunderstood|that's wrong|that is wrong|not what i asked|not what i meant)\b/i.test(value);
}

function normalizeCorrection(value: string): string {
  const tokens = value.trim().replace(CORRECTION_PREFIX, '').toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? [];
  const meaningful = tokens.filter((token) => !STOP_WORDS.has(token));
  return meaningful.length < 3 ? '' : meaningful.join(' ').slice(0, 500);
}
