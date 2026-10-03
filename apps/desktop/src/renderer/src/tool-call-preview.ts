import { diffHunks, splitLines } from '@kai/contracts';

/**
 * What a tool call did, in the terms the transcript can show: a file change with its before and
 * after text, or a command with its output. Everything else a tool does stays a one-line entry in
 * the Activity list, which is why `describeToolCall` answers `null` for it.
 */
export interface EditPair {
  before: string;
  after: string;
}

export type ToolCallPreview =
  | { kind: 'edit'; path: string; pairs: readonly EditPair[]; replaceAll: boolean }
  | { kind: 'write'; path: string; content: string; creates: boolean }
  | { kind: 'delete'; path: string }
  | { kind: 'move'; from: string; to: string }
  | { kind: 'command'; command: string; cwd: string | null; output: string; exitCode: number | null }
  | { kind: 'explore'; question: string; answer: string | null };

export interface PreviewLine {
  kind: 'context' | 'removed' | 'added' | 'gap';
  text: string;
}

export interface ToolCallPreviewView {
  verb: string;
  /** The path or command the header names. */
  target: string;
  added: number;
  removed: number;
  /** The body, already capped, including a final "… N more lines" row when the cap bit. */
  lines: PreviewLine[];
  note: string | null;
}

/** A rewritten file can be arbitrarily long, and the transcript is not a code viewer. */
const MAX_PREVIEW_LINES = 400;
/** A command's output is quoted by its tail, not its head, so the end is what survives. */
const MAX_OUTPUT_CHARS = 4_000;

/**
 * Tools whose arguments carry a visible change. These render as cards in the conversation instead
 * of one-line entries in the Activity list. The name alone decides, so the transcript can sort
 * events cheaply on every render; `describeToolCall` then reads the arguments.
 */
const PREVIEW_TOOLS = new Set([
  'replace_in_file',
  'edit',
  'multi_edit',
  'multiedit',
  'create_file',
  'write_file',
  'write',
  'delete_file',
  'move_file',
  'run_command',
  'bash',
  'shell_command',
  'explore',
]);

export function isPreviewableTool(name: string): boolean {
  return PREVIEW_TOOLS.has(name.toLowerCase());
}

export function describeToolCall(name: string, input: unknown, output: unknown): ToolCallPreview | null {
  const args = asRecord(input);
  if (!args) return null;
  // The names differ between KAI's own tools and provider-native ones an agent adapter may pass
  // through verbatim, so both spellings of every field are accepted.
  const path = firstText(args.path, args.file_path);
  const before = firstText(args.old_text, args.old_string);
  const after = firstText(args.new_text, args.new_string);
  const content = typeof args.content === 'string' ? args.content : null;
  const command = typeof args.command === 'string' ? args.command : null;
  switch (name.toLowerCase()) {
    case 'replace_in_file':
    case 'edit':
      if (!path || before === null || after === null) return null;
      return { kind: 'edit', path, pairs: [{ before, after }], replaceAll: args.replace_all === true };
    case 'multi_edit':
    case 'multiedit': {
      if (!path || !Array.isArray(args.edits)) return null;
      const pairs = args.edits.flatMap((entry): EditPair[] => {
        const edit = asRecord(entry);
        const from = edit ? firstText(edit.old_text, edit.old_string) : null;
        const to = edit ? firstText(edit.new_text, edit.new_string) : null;
        return from === null || to === null ? [] : [{ before: from, after: to }];
      });
      return pairs.length === 0 ? null : { kind: 'edit', path, pairs, replaceAll: false };
    }
    case 'create_file':
    case 'write_file':
    case 'write':
      if (!path || content === null) return null;
      return { kind: 'write', path, content, creates: name.toLowerCase() === 'create_file' };
    case 'delete_file':
      return path ? { kind: 'delete', path } : null;
    case 'move_file': {
      const from = firstText(args.from, args.source);
      const to = firstText(args.to, args.destination);
      return from && to ? { kind: 'move', from, to } : null;
    }
    case 'run_command':
    case 'bash':
    case 'shell_command': {
      if (command === null) return null;
      const result = asRecord(output);
      return {
        kind: 'command',
        command,
        cwd: typeof args.cwd === 'string' ? args.cwd : null,
        output: commandOutput(result ?? (typeof output === 'string' ? { stdout: output } : {})),
        exitCode: result && typeof result.exitCode === 'number' ? result.exitCode : null,
      };
    }
    case 'explore': {
      const question = typeof args.question === 'string' ? args.question : null;
      if (!question) return null;
      const result = asRecord(output);
      const answer = result && typeof result.answer === 'string' ? result.answer : result && typeof result.error === 'string' ? `Could not answer: ${result.error}` : null;
      return { kind: 'explore', question, answer };
    }
    default:
      return null;
  }
}

/** The header, the counts and the body of one card, with the body already capped. */
export function renderToolCallPreview(preview: ToolCallPreview): ToolCallPreviewView {
  const lines: PreviewLine[] = [];
  let budget = MAX_PREVIEW_LINES;
  let omitted = 0;
  const push = (kind: PreviewLine['kind'], text: string): void => {
    if (budget <= 0) {
      omitted += 1;
      return;
    }
    budget -= 1;
    lines.push({ kind, text: stripEnding(text) });
  };

  let added = 0;
  let removed = 0;
  let note: string | null = null;

  if (preview.kind === 'edit') {
    preview.pairs.forEach((pair, index) => {
      // A blank row separates a multi_edit's replacements, the way two hunks are separated.
      if (index > 0) push('gap', '');
      for (const hunk of diffHunks(pair.before, pair.after)) {
        added += hunk.added.length;
        removed += hunk.removed.length;
        for (const line of hunk.contextBefore) push('context', line);
        for (const line of hunk.removed) push('removed', line);
        for (const line of hunk.added) push('added', line);
        for (const line of hunk.contextAfter) push('context', line);
      }
    });
    if (preview.replaceAll) note = 'Every occurrence replaced';
    else if (preview.pairs.length > 1) note = `${preview.pairs.length} edits`;
  } else if (preview.kind === 'write') {
    const contentLines = splitLines(preview.content);
    added = contentLines.length;
    for (const line of contentLines) push('added', line);
    // The tool can replace an existing file, and its arguments carry only the new text, so the
    // whole file reads as added. Say so rather than letting that look like a diff of every line.
    if (!preview.creates) note = 'Whole file written';
  } else if (preview.kind === 'command') {
    for (const line of tail(preview.output, MAX_OUTPUT_CHARS).split(/\r?\n/)) push('context', line);
    if (preview.exitCode !== null && preview.exitCode !== 0) note = `Exit code ${preview.exitCode}`;
  } else if (preview.kind === 'explore') {
    for (const line of (preview.answer ?? 'Still exploring…').split(/\r?\n/)) push('context', line);
  }

  if (omitted > 0) lines.push({ kind: 'gap', text: `… ${omitted} more ${omitted === 1 ? 'line' : 'lines'}` });

  return { ...headerFor(preview), added, removed, lines, note };
}

function headerFor(preview: ToolCallPreview): { verb: string; target: string } {
  if (preview.kind === 'edit') return { verb: 'Edit', target: preview.path };
  if (preview.kind === 'write') return { verb: preview.creates ? 'Create file' : 'Write file', target: preview.path };
  if (preview.kind === 'delete') return { verb: 'Delete file', target: preview.path };
  if (preview.kind === 'move') return { verb: 'Move file', target: `${preview.from} → ${preview.to}` };
  if (preview.kind === 'explore') return { verb: 'Explored', target: preview.question };
  return { verb: 'Command', target: preview.cwd ? `${preview.command}  (in ${preview.cwd})` : preview.command };
}

/** stdout and stderr as the user would see them in a terminal, with a failure's message last. */
function commandOutput(output: Record<string, unknown>): string {
  const parts = [output.stdout, output.stderr, output.error]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    // Each stream ends in its own newline; without this the join would add a blank line between them.
    .map((part) => part.replace(/\s+$/, ''));
  return parts.join('\n');
}

function tail(text: string, limit: number): string {
  return text.length > limit ? text.slice(text.length - limit) : text;
}

function stripEnding(line: string): string {
  return line.replace(/\r?\n$/, '');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) if (typeof value === 'string' && value.length > 0) return value;
  return null;
}
