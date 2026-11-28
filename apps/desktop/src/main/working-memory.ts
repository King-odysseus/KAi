/**
 * What a run on a small window must not lose. Folding used to leave a list of tool calls clipped to 200 characters, so
 * the model read its files again, filled the window again and folded again. Here the run keeps track of what has been
 * read and changed, and a fold carries the files themselves forward, read fresh from disk, with what was done, the
 * last check and anything the person said.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { shortenLog } from './tool-output-cap';

/** A fold leaves room for this share of the project's instructions plus conversation within the model's window. */
export const OWN_FOLD_SHARE = 0.75;
/** However large the instructions are, the conversation is allowed at least this share before it folds. */
const OWN_FOLD_FLOOR_SHARE = 0.2;
/** The share of the conversation allowance that carried files may take; the rest is room to work in. */
export const CARRIED_FILES_SHARE = 0.5;
/**
 * However large the window, carried files stop here (about 24,000 tokens). The gateway reuses what it has processed
 * only up to a fold, so folds should be rare and far apart: what is carried is room not available before the next one.
 */
export const MAX_CARRIED_CHARS = 96_000;
const MAX_ACTIONS = 30;
const MAX_ACTION_CHARS = 160;
const MAX_CHECK_CHARS = 1_800;
const MAX_CARRIED_FILE_BYTES = 512 * 1024;

const EDIT_TOOLS = new Set(['replace_in_file', 'multi_edit', 'write_file', 'create_file']);
const CHECK_TOOL = /^(?:run_command|diagnostics)$|^mcp_kai[-_]terminal_terminal_run$/;
const UNCHANGED_NOTE = 'You already have these lines and they have not changed. They are earlier in this conversation, in a read_file result or in the working memory: use them. If you ask for them again you will be sent the text.';

/**
 * The size of conversation at which a run on a known window folds. Measured against the whole request: the
 * instructions and the tool list travel with it and take their part of the same window.
 */
export function ownFoldThreshold(windowTokens: number, fixedTokens: number): number {
  return Math.max(Math.floor(windowTokens * OWN_FOLD_FLOOR_SHARE), Math.floor(windowTokens * OWN_FOLD_SHARE) - fixedTokens);
}

interface FileState {
  /** Order of the last time the run read or changed it. */
  touched: number;
  edited: boolean;
}

export class WorkingMemory {
  private readonly files = new Map<string, FileState>();
  /** Per file, the lines that are in the conversation as it stands, as line number and a digest of the text. */
  private readonly present = new Map<string, Map<number, string>>();
  /** Reads already answered with the short note: asked again, they are answered in full. */
  private readonly noted = new Set<string>();
  private readonly actions: string[] = [];
  private readonly steering: string[] = [];
  private lastCheck: { command: string; result: string; excerpt: string } | undefined;
  private sequence = 0;

  /**
   * Records one tool call and returns what the model should be sent for it. That is the output as given, except for a
   * read of lines the model can already see, which gets a short note.
   */
  observe(name: string, input: unknown, output: unknown, ok: boolean): unknown {
    const args = record(input);
    const result = record(output);
    this.noteAction(name, input, ok);
    if (name === 'read_file' && ok && typeof result.path === 'string' && typeof result.text === 'string') {
      return this.observeRead(result.path, result.text, output);
    }
    if (EDIT_TOOLS.has(name) && ok && typeof args.path === 'string') {
      const file = normalize(args.path);
      this.files.set(file, { touched: ++this.sequence, edited: true });
      // Line numbers move with an edit, so what was read before no longer says what the file holds.
      this.forget(file);
    }
    if ((name === 'delete_file' || name === 'move_file') && ok) {
      for (const value of [args.path, args.from, args.source]) {
        if (typeof value !== 'string') continue;
        this.files.delete(normalize(value));
        this.forget(normalize(value));
      }
    }
    if (CHECK_TOOL.test(name)) {
      const text = [result.stdout, result.stderr, result.error].filter((value): value is string => typeof value === 'string' && value.length > 0).join('\n');
      this.lastCheck = {
        command: String(args.command ?? args.path ?? name).slice(0, 300),
        result: typeof result.exitCode === 'number' ? `exit ${result.exitCode}` : ok ? 'passed' : 'failed',
        excerpt: shortenLog(text, MAX_CHECK_CHARS),
      };
    }
    return output;
  }

  /** Something the person said while the run was going. A fold must never lose it. */
  noteSteering(text: string): void {
    if (text.trim()) this.steering.push(text.trim().slice(0, 2_000));
  }

  private observeRead(rawPath: string, text: string, output: unknown): unknown {
    const file = normalize(rawPath);
    this.files.set(file, { touched: ++this.sequence, edited: this.files.get(file)?.edited ?? false });
    const lines = numberedLines(text);
    if (lines.length === 0) return output;
    const known = this.present.get(file) ?? new Map<number, string>();
    const key = `${file}:${lines[0]![0]}-${lines[lines.length - 1]![0]}`;
    if (lines.every(([number, line]) => known.get(number) === digest(line)) && !this.noted.has(key)) {
      this.noted.add(key);
      const result = record(output);
      return {
        path: result.path,
        startLine: lines[0]![0],
        endLine: lines[lines.length - 1]![0],
        ...(result.totalLines !== undefined ? { totalLines: result.totalLines } : {}),
        unchanged: true,
        kaiNotice: UNCHANGED_NOTE,
      };
    }
    this.noted.delete(key);
    for (const [number, line] of lines) known.set(number, digest(line));
    this.present.set(file, known);
    return output;
  }

  private forget(file: string): void {
    this.present.delete(file);
    for (const key of this.noted) if (key.startsWith(`${file}:`)) this.noted.delete(key);
  }

  private noteAction(name: string, input: unknown, ok: boolean): void {
    const args = record(input);
    const subject = typeof args.path === 'string' ? `${args.path}${typeof args.start_line === 'number' ? `:${args.start_line}` : ''}`
      : typeof args.command === 'string' ? args.command
        : typeof args.query === 'string' ? args.query
          : JSON.stringify(input) ?? '';
    this.actions.push(`${name} ${subject.replace(/\s+/g, ' ').slice(0, MAX_ACTION_CHARS)} -> ${ok ? 'ok' : 'failed'}`);
    if (this.actions.length > MAX_ACTIONS) this.actions.splice(0, this.actions.length - MAX_ACTIONS);
  }

  /**
   * The text that replaces the conversation so far. Files are given as they are now, within `fileBudget` characters:
   * the one touched last first, then those only read (plans, types, the code being matched), then the ones changed.
   */
  async fold(projectRoot: string, fileBudget: number, lastSaid: string): Promise<string> {
    this.present.clear();
    this.noted.clear();
    const parts: string[] = ['[Working memory: KAI set the earlier steps aside to keep the request within the model\'s window. This is what they came to.]'];
    if (this.steering.length) parts.push(`The person told you, during this run:\n${this.steering.map((line) => `- ${line}`).join('\n')}`);
    const changed = [...this.files].filter(([, state]) => state.edited).map(([file]) => file);
    if (changed.length) parts.push(`Files you changed: ${changed.join(', ')}`);
    if (this.actions.length) parts.push(`Your latest steps, oldest first:\n${this.actions.join('\n')}`);
    if (this.lastCheck) parts.push(`Last check: ${this.lastCheck.command} (${this.lastCheck.result})${this.lastCheck.excerpt ? `\n${this.lastCheck.excerpt}` : ''}`);
    if (lastSaid.trim()) parts.push(`Last thing you said: ${lastSaid.trim().replace(/\s+/g, ' ').slice(0, 400)}`);

    const byRecency = [...this.files].sort((left, right) => right[1].touched - left[1].touched);
    const [latest, ...rest] = byRecency;
    const ordered = latest ? [latest, ...rest.filter(([, state]) => !state.edited), ...rest.filter(([, state]) => state.edited)] : [];
    const shown: string[] = [];
    const left: string[] = [];
    let room = Math.min(fileBudget, MAX_CARRIED_CHARS);
    for (const [file] of ordered) {
      const lines = await readProjectLines(projectRoot, file);
      if (!lines) continue;
      const text = lines.map((line, index) => `${index + 1}: ${line}`).join('\n');
      if (text.length > room) { left.push(file); continue; }
      room -= text.length;
      shown.push(`### ${file} (${lines.length} lines, current)\n${text}`);
      this.present.set(file, new Map(lines.map((line, index) => [index + 1, digest(line)])));
    }
    if (shown.length) parts.push(`These files are given as they are now, so there is no need to read them again:\n\n${shown.join('\n\n')}`);
    if (left.length) parts.push(`Also read or changed, and not shown here for room. Read the lines you need: ${left.join(', ')}`);
    return parts.join('\n\n');
  }
}

/** The numbered lines of a read_file result. Empty when the text is not in that shape. */
function numberedLines(text: string): Array<[number, string]> {
  const lines: Array<[number, string]> = [];
  for (const raw of text.split('\n')) {
    const match = /^(\d+): ?(.*?)\r?$/.exec(raw);
    if (!match) return [];
    lines.push([Number(match[1]), match[2]!]);
  }
  return lines;
}

async function readProjectLines(projectRoot: string, file: string): Promise<string[] | undefined> {
  try {
    const root = await fs.realpath(projectRoot);
    const target = await fs.realpath(path.resolve(root, file));
    const inside = path.relative(root, target);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return undefined;
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > MAX_CARRIED_FILE_BYTES) return undefined;
    const text = await fs.readFile(target, 'utf8');
    if (text.includes('\u0000')) return undefined;
    // Split as read_file splits, so a line carried here is recognised when it is read again.
    return text.split(/\r?\n/);
  } catch {
    return undefined;
  }
}

function normalize(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const runs = new WeakMap<object, WorkingMemory>();
/** Starts keeping a run's working memory. Only runs that fold against their own window do. */
export function startWorkingMemory(runtime: object): WorkingMemory {
  const memory = new WorkingMemory();
  runs.set(runtime, memory);
  return memory;
}
export function workingMemoryOf(runtime: object): WorkingMemory | undefined {
  return runs.get(runtime);
}
