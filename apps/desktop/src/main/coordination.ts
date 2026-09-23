import type { ActiveClaim, PreflightResult, UrgentNote } from '@kai/contracts';

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const asText = (value: unknown): string => (typeof value === 'string' ? value : value == null ? '' : String(value));
const splitFiles = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map(asText).filter(Boolean)
    : asText(value).split(',').map((item) => item.trim()).filter(Boolean);

/** Active claims from the Cognitive1 /api/status payload. Anything malformed is skipped, not fatal. */
export function parseActiveClaims(status: unknown): ActiveClaim[] {
  const claims = asRecord(status).activeClaims;
  if (!Array.isArray(claims)) return [];
  return claims.map((item) => {
    const claim = asRecord(item);
    return {
      agent: asText(claim.agent),
      project: asText(claim.project),
      what: asText(claim.what),
      files: splitFiles(claim.files),
      date: asText(claim.date),
      time: asText(claim.time),
    };
  }).filter((claim) => claim.agent || claim.project);
}

/** Urgent warnings from /api/urgent. */
export function parseUrgentNotes(payload: unknown): UrgentNote[] {
  const notes = asRecord(payload).urgentNotes;
  if (!Array.isArray(notes)) return [];
  return notes.map((item) => {
    const note = asRecord(item);
    return {
      project: asText(note.project) || 'global',
      what: asText(note.what),
      do: asText(note.do),
      doNot: asText(note.doNot ?? note.do_not),
      until: asText(note.until),
    };
  }).filter((note) => note.what);
}

/** Text of an MCP tool result, joining every text block. */
export function mcpText(result: unknown): string {
  const content = asRecord(result).content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => asRecord(block))
    .filter((block) => block.type === 'text')
    .map((block) => asText(block.text))
    .join('\n');
}

/** Parses the text returned by the `conflict_check` tool. */
export function parseConflictText(text: string): PreflightResult['conflicts'] {
  if (!/CONFLICT DETECTED/i.test(text)) return [];
  const conflicts: PreflightResult['conflicts'] = [];
  let current: PreflightResult['conflicts'][number] | null = null;
  for (const line of text.split(/\r?\n/)) {
    const agent = /^Agent:\s*(.+?)\s*\((.*)\)\s*$/.exec(line);
    if (agent) {
      current = { agent: agent[1]!, project: agent[2]!, overlap: [] };
      conflicts.push(current);
      continue;
    }
    const overlap = /^Overlapping files:\s*(.+)$/.exec(line);
    if (overlap && current) current.overlap = overlap[1]!.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return conflicts;
}

/** Group brain-wide `recall` output into rows the palette can show. */
export interface RecallHit {
  source: 'entry' | 'handoff' | 'daily' | 'knowledge';
  label: string;
  detail: string;
}

export function parseRecallText(text: string): RecallHit[] {
  const hits: RecallHit[] = [];
  let source: RecallHit['source'] | null = null;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^###\s+(Brain Entries|Handoffs|Daily Logs|Knowledge Base)/.exec(line);
    if (heading) {
      source = heading[1] === 'Brain Entries' ? 'entry' : heading[1] === 'Handoffs' ? 'handoff' : heading[1] === 'Daily Logs' ? 'daily' : 'knowledge';
      continue;
    }
    const item = /^-\s+(.*)$/.exec(line);
    if (!item || !source) continue;
    const entry = /^\[([^\]]+)\]\s+\[([^\]]+)\]\s+(.+?)(?:\s+—\s+(.+))?$/.exec(item[1]!);
    if (source === 'entry' && entry) hits.push({ source, label: entry[3]!, detail: `${entry[2]} · ${entry[1]}${entry[4] ? ` · ${entry[4]}` : ''}` });
    else hits.push({ source, label: item[1]!, detail: '' });
  }
  return hits;
}
