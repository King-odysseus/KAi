/**
 * Keeps one tool result from filling a small model's window. A single test run could return 200,000 characters, about
 * 50,000 tokens, which on the person's own hardware is most of what the model can hold and minutes of reading. What is
 * kept is what a developer reads first (the errors and the end); the whole result is saved where `read_file` can get it.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { toolOutputImages } from './image-attachments';

/** The share of a model's window one tool result may take. */
export const TOOL_OUTPUT_WINDOW_SHARE = 0.08;
/** Used when nothing says how large the window is. */
export const UNKNOWN_WINDOW_TOKENS = 32_768;
const MIN_LIMIT = 6_000;
const MAX_LIMIT = 60_000;
const TAIL_LINES = 60;
const ERROR_LINE = /\b(error|errors|fail|failed|failure|fatal|exception|traceback|assert|expected|received|warning)\b|✗|✘|×|TS\d{4}/i;
export const OUTPUT_FOLDER = '.kai/outputs';

export function toolOutputLimit(windowTokens: number | undefined): number {
  const characters = Math.floor((windowTokens ?? UNKNOWN_WINDOW_TOKENS) * 4 * TOOL_OUTPUT_WINDOW_SHARE);
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, characters));
}

export async function capToolOutput(
  projectRoot: string,
  callId: string,
  name: string,
  output: unknown,
  limit: number,
): Promise<unknown> {
  const whole = typeof output === 'string' ? output : JSON.stringify(output);
  if (whole === undefined || whole.length <= limit) return output;
  // A picture is sent as a picture, not as text, and cutting its bytes would destroy it.
  if (toolOutputImages(output).images.length > 0) return output;
  const record = output && typeof output === 'object' && !Array.isArray(output) ? output as Record<string, unknown> : undefined;

  // A file can be read again from where this stopped, so nothing needs saving.
  if (name === 'read_file' && record && typeof record.text === 'string') return shortenFileRead(record, record.text, limit);

  if (record && (typeof record.stdout === 'string' || typeof record.stderr === 'string')) {
    const stdout = typeof record.stdout === 'string' ? record.stdout : '';
    const stderr = typeof record.stderr === 'string' ? record.stderr : '';
    const saved = await save(projectRoot, callId, [stdout && `--- stdout ---\n${stdout}`, stderr && `--- stderr ---\n${stderr}`].filter(Boolean).join('\n'));
    const room = limit - 600;
    // Each stream gets half, and whatever the quieter one does not need.
    const errorRoom = Math.min(stderr.length, Math.max(Math.floor(room / 2), room - stdout.length));
    return {
      ...record,
      ...(stdout ? { stdout: shortenLog(stdout, room - errorRoom) } : {}),
      ...(stderr ? { stderr: shortenLog(stderr, errorRoom) } : {}),
      kaiNotice: savedNote(saved),
    };
  }

  if (record) {
    const trimmed = trimLongestList(record, limit);
    if (trimmed) return trimmed;
  }
  const saved = await save(projectRoot, callId, whole);
  return { kaiNotice: savedNote(saved), excerpt: shortenLog(typeof output === 'string' ? output : JSON.stringify(output, null, 1), limit - 600) };
}

function shortenFileRead(record: Record<string, unknown>, text: string, limit: number): Record<string, unknown> {
  const kept: string[] = [];
  let size = 0;
  for (const line of text.split('\n')) {
    if (size + line.length + 1 > limit - 600) break;
    kept.push(line);
    size += line.length + 1;
  }
  if (kept.length === 0) kept.push(text.slice(0, limit - 600));
  const last = /^(\d+):/.exec(kept[kept.length - 1]!);
  return {
    ...record,
    text: kept.join('\n'),
    truncated: true,
    kaiNotice: `Only part of this read fits the model's window.${last ? ` Call read_file with start_line ${Number(last[1]) + 1} for what follows.` : ' Ask for fewer lines.'}`,
  };
}

/** The lines that name a problem, then the end of the output, within `room` characters. */
export function shortenLog(text: string, room: number): string {
  if (text.length <= room) return text;
  if (room <= 200) return text.slice(-Math.max(0, room));
  const lines = text.split('\n').map((line) => (line.length > 600 ? `${line.slice(0, 600)} …` : line));
  const tail: string[] = [];
  let tailSize = 0;
  let index = lines.length - 1;
  for (; index >= 0 && tail.length < TAIL_LINES; index -= 1) {
    const size = lines[index]!.length + 1;
    if (tailSize + size > room * 0.65) break;
    tail.unshift(lines[index]!);
    tailSize += size;
  }
  // A single enormous last line leaves no whole line that fits.
  if (tail.length === 0) return `[… ${text.length - room} characters left out …]\n${text.slice(-(room - 100))}`;
  const errors: string[] = [];
  let errorSize = 0;
  for (let line = 0; line <= index; line += 1) {
    const value = lines[line]!;
    if (!ERROR_LINE.test(value)) continue;
    if (errorSize + value.length + 1 > room - tailSize - 150) break;
    errors.push(value);
    errorSize += value.length + 1;
  }
  const omitted = index + 1 - errors.length;
  return [
    ...(errors.length ? ['[Lines that mention a problem:]', ...errors] : []),
    `[… ${omitted} lines left out …]`,
    ...tail,
  ].join('\n');
}

/** Search matches and file lists are shortened by dropping items, which keeps every one that stays whole. */
function trimLongestList(record: Record<string, unknown>, limit: number): Record<string, unknown> | undefined {
  const [key, list] = Object.entries(record)
    .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
    .sort((left, right) => JSON.stringify(right[1]).length - JSON.stringify(left[1]).length)[0] ?? [];
  if (!key || !list) return undefined;
  const rest = JSON.stringify({ ...record, [key]: [] }).length;
  if (rest > limit / 2) return undefined;
  const kept: unknown[] = [];
  let size = rest + 300;
  for (const item of list) {
    const length = (JSON.stringify(item)?.length ?? 4) + 1;
    if (size + length > limit) break;
    kept.push(item);
    size += length;
  }
  if (kept.length === 0) return undefined;
  return {
    ...record,
    [key]: kept,
    truncated: true,
    kaiNotice: `Showing ${kept.length} of ${list.length} results, which is what fits the model's window. Narrow the request for the rest.`,
  };
}

function savedNote(file: string | undefined): string {
  return file
    ? `Output shortened to fit the model's window. The whole output is in ${file}: search it, or read the lines you need with read_file.`
    : 'Output shortened to fit the model\'s window, and the whole output could not be saved. Run the command again with narrower output if you need more.';
}

async function save(projectRoot: string, callId: string, text: string): Promise<string | undefined> {
  try {
    const folder = path.join(projectRoot, ...OUTPUT_FOLDER.split('/'));
    await fs.mkdir(folder, { recursive: true });
    // The folder ignores itself, so saved output never shows up as a change to the project.
    await fs.writeFile(path.join(folder, '.gitignore'), '*\n', { flag: 'wx' }).catch(() => undefined);
    const name = `${callId.replace(/[^A-Za-z0-9_-]+/g, '-').slice(-60) || 'output'}-${Date.now().toString(36)}.log`;
    await fs.writeFile(path.join(folder, name), text.slice(0, 500_000), 'utf8');
    return `${OUTPUT_FOLDER}/${name}`;
  } catch {
    return undefined;
  }
}
