import type { LearningSuggestionPlacement } from '@kai/contracts';

/** An edit in 1-based editor coordinates, plus the lines the inserted code ends up on so they can be shown. */
export interface PlacementEdit {
  range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
  text: string;
  insertedLines: { start: number; end: number };
}

export type PlacementResult = { ok: true; edit: PlacementEdit } | { ok: false; reason: string };

export interface SuggestionTarget {
  filePath: string;
  startLine?: number;
  endLine?: number;
}

const FILE_MENTION = /(?:[\w@.-]+\/)*[\w@-][\w@.-]*\.(?:py|pyi|ts|tsx|js|jsx|mjs|cjs|json|css|scss|less|html|md|mdx|ya?ml|toml|ini|cfg|go|rs|java|kt|rb|php|cs|c|cc|cpp|h|hpp|vue|svelte|sql|sh|ps1|xml|gradle|env)\b/g;

/**
 * The file a suggestion is meant for. The tutor's own words ("Type this in config/settings.py") win over its
 * citations, because it also cites files it only read for context. Lines come from a citation of that same file.
 */
export function suggestionTarget(
  instructions: readonly string[],
  sourceNotes: ReadonlyArray<{ filePath?: string; startLine?: number; endLine?: number }>,
): SuggestionTarget | null {
  const cited = sourceNotes.filter((note): note is SuggestionTarget => Boolean(note.filePath));
  const normalise = (value: string): string => value.replace(/\\/g, '/').replace(/^\.\//, '');
  for (const text of instructions) {
    for (const mention of normalise(text).match(FILE_MENTION) ?? []) {
      const note = cited.find((item) => normalise(item.filePath) === mention)
        ?? cited.find((item) => normalise(item.filePath).endsWith(`/${mention}`));
      if (note) return { filePath: note.filePath, ...(note.startLine ? { startLine: note.startLine } : {}), ...(note.endLine ? { endLine: note.endLine } : {}) };
      if (mention.includes('/')) return { filePath: mention };
    }
  }
  return cited[0] ?? null;
}

const leadingSpace =(line: string): string => /^[ \t]*/.exec(line)?.[0] ?? '';

/**
 * Where the anchor's lines sit in the file. Lines are compared without their surrounding whitespace, so a tutor
 * that got the indentation slightly wrong still finds the spot, but every non-blank line must match in order.
 */
export function findAnchor(lines: readonly string[], anchor: string): Array<{ start: number; end: number }> {
  const wanted = anchor.split(/\r?\n/).map((line) => line.trim());
  while (wanted.length > 0 && !wanted[0]) wanted.shift();
  while (wanted.length > 0 && !wanted.at(-1)) wanted.pop();
  if (wanted.length === 0) return [];
  const matches: Array<{ start: number; end: number }> = [];
  for (let index = 0; index + wanted.length <= lines.length; index += 1) {
    if (wanted.every((line, offset) => lines[index + offset]!.trim() === line)) {
      matches.push({ start: index + 1, end: index + wanted.length });
    }
  }
  return matches;
}

/**
 * Code the tutor already indented is kept as it is. Code written flush left is shifted to the surrounding
 * indentation, keeping its own inner indentation.
 */
function reindent(code: string, indent: string): string[] {
  const lines = code.replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '').split('\n');
  const flushLeft = lines.some((line) => line.trim() && !leadingSpace(line));
  return lines.map((line) => (line.trim() ? (flushLeft ? indent + line : line) : ''));
}

/** Code added after the anchor sits at the deeper of the anchor's last line and the line that follows it. */
function indentAfter(lines: readonly string[], end: number): string {
  const own = leadingSpace(lines[end - 1]!);
  const next = lines.slice(end).find((line) => line.trim());
  const following = next === undefined ? '' : leadingSpace(next);
  return following.length > own.length ? following : own;
}

/** The edit that puts a tutor suggestion where its placement says, or why it cannot be placed safely. */
export function placeSuggestion(lines: readonly string[], placement: LearningSuggestionPlacement, code: string): PlacementResult {
  const matches = findAnchor(lines, placement.anchor);
  if (matches.length === 0) {
    return { ok: false, reason: `The spot the tutor named is not in ${placement.filePath} any more. The file may have changed.` };
  }
  if (matches.length > 1) {
    return { ok: false, reason: `The spot the tutor named appears ${matches.length} times in ${placement.filePath}, so KAI did not guess.` };
  }
  const { start, end } = matches[0]!;
  const placed = reindent(code, placement.position === 'after' ? indentAfter(lines, end) : leadingSpace(lines[start - 1]!));
  if (placement.position === 'replace') {
    return {
      ok: true,
      edit: {
        range: { startLineNumber: start, startColumn: 1, endLineNumber: end, endColumn: lines[end - 1]!.length + 1 },
        text: placed.join('\n'),
        insertedLines: { start, end: start + placed.length - 1 },
      },
    };
  }
  if (placement.position === 'before') {
    return {
      ok: true,
      edit: {
        range: { startLineNumber: start, startColumn: 1, endLineNumber: start, endColumn: 1 },
        text: `${placed.join('\n')}\n`,
        insertedLines: { start, end: start + placed.length - 1 },
      },
    };
  }
  const column = lines[end - 1]!.length + 1;
  return {
    ok: true,
    edit: {
      range: { startLineNumber: end, startColumn: column, endLineNumber: end, endColumn: column },
      text: `\n${placed.join('\n')}`,
      insertedLines: { start: end + 1, end: end + placed.length },
    },
  };
}
