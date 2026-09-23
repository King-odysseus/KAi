/** A run of changed lines. `id` is the hunk's position, stable for a given before/after pair. */
export interface DiffHunk {
  id: number;
  /** 1-based line where the removed lines start in the old text. */
  oldStart: number;
  /** 1-based line where the added lines start in the new text. */
  newStart: number;
  removed: string[];
  added: string[];
  contextBefore: string[];
  contextAfter: string[];
}

const CONTEXT_LINES = 2;
// Beyond this many cells the quadratic table is too slow, so the changed middle becomes one hunk.
const MAX_TABLE_CELLS = 4_000_000;

/** Split into lines that keep their own terminator, so joining them restores the text exactly (CRLF included). */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.split(/(?<=\n)/);
}

type Operation = { kind: 'equal' | 'remove' | 'add'; line: string };

function operations(before: readonly string[], after: readonly string[]): Operation[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }
  const head: Operation[] = before.slice(0, start).map((line) => ({ kind: 'equal', line }));
  const tail: Operation[] = before.slice(endBefore).map((line) => ({ kind: 'equal', line }));
  const middleBefore = before.slice(start, endBefore);
  const middleAfter = after.slice(start, endAfter);
  return [...head, ...diffMiddle(middleBefore, middleAfter), ...tail];
}

function diffMiddle(before: readonly string[], after: readonly string[]): Operation[] {
  const rows = before.length;
  const columns = after.length;
  if (rows === 0 || columns === 0 || rows * columns > MAX_TABLE_CELLS) {
    return [
      ...before.map((line): Operation => ({ kind: 'remove', line })),
      ...after.map((line): Operation => ({ kind: 'add', line })),
    ];
  }
  // Longest common subsequence lengths, filled from the end so the walk below runs forward.
  const width = columns + 1;
  const table = new Uint32Array((rows + 1) * width);
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      table[row * width + column] = before[row] === after[column]
        ? table[(row + 1) * width + column + 1]! + 1
        : Math.max(table[(row + 1) * width + column]!, table[row * width + column + 1]!);
    }
  }
  const result: Operation[] = [];
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (before[row] === after[column]) {
      result.push({ kind: 'equal', line: before[row]! });
      row += 1;
      column += 1;
    } else if (table[(row + 1) * width + column]! >= table[row * width + column + 1]!) {
      result.push({ kind: 'remove', line: before[row]! });
      row += 1;
    } else {
      result.push({ kind: 'add', line: after[column]! });
      column += 1;
    }
  }
  for (; row < rows; row += 1) result.push({ kind: 'remove', line: before[row]! });
  for (; column < columns; column += 1) result.push({ kind: 'add', line: after[column]! });
  return result;
}

interface Segment {
  equal: string[] | null;
  removed: string[];
  added: string[];
}

function segments(ops: readonly Operation[]): Segment[] {
  const result: Segment[] = [];
  let current: Segment | null = null;
  for (const op of ops) {
    if (op.kind === 'equal') {
      if (current && current.equal !== null) current.equal.push(op.line);
      else {
        current = { equal: [op.line], removed: [], added: [] };
        result.push(current);
      }
    } else {
      if (!current || current.equal !== null) {
        current = { equal: null, removed: [], added: [] };
        result.push(current);
      }
      (op.kind === 'remove' ? current.removed : current.added).push(op.line);
    }
  }
  return result;
}

export function diffHunks(before: string, after: string): DiffHunk[] {
  const parts = segments(operations(splitLines(before), splitLines(after)));
  const hunks: DiffHunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  parts.forEach((part, index) => {
    if (part.equal !== null) {
      oldLine += part.equal.length;
      newLine += part.equal.length;
      return;
    }
    const previous = parts[index - 1]?.equal ?? [];
    const next = parts[index + 1]?.equal ?? [];
    hunks.push({
      id: hunks.length,
      oldStart: oldLine,
      newStart: newLine,
      removed: part.removed,
      added: part.added,
      contextBefore: previous.slice(-CONTEXT_LINES),
      contextAfter: next.slice(0, CONTEXT_LINES),
    });
    oldLine += part.removed.length;
    newLine += part.added.length;
  });
  return hunks;
}

/** The new text with the listed hunks put back to their old content. Other hunks stay as they are. */
export function revertHunks(before: string, after: string, hunkIds: readonly number[]): string {
  const revert = new Set(hunkIds);
  const parts = segments(operations(splitLines(before), splitLines(after)));
  const output: string[] = [];
  let hunkId = 0;
  for (const part of parts) {
    if (part.equal !== null) {
      output.push(...part.equal);
      continue;
    }
    output.push(...(revert.has(hunkId) ? part.removed : part.added));
    hunkId += 1;
  }
  return output.join('');
}
