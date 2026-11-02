import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { listProjectFiles } from './repo-map';

/**
 * What KAI has learned about an open project, kept on this machine and handed to an agent before it starts.
 *
 * An agent that knows nothing about a project spends its first minutes finding its way: listing folders, searching,
 * opening files to see what they are. This is the short version of that, learned instead of rediscovered. It has three
 * sources, none of which needs a model or the brain to be running:
 *
 * - **The folder shape**, from the project's own file list.
 * - **What is changing**, from a watcher on the project folder: the files that keep being edited, by anyone — the
 *   person in their editor, another tool, an agent — are where the work is.
 * - **What earlier runs did**, from the runs KAI itself finished here: the task, the files it touched, and whether the
 *   checks passed.
 *
 * It is read-only for agents and written only by KAI, and it never leaves the machine.
 */

export interface RunNote {
  at: string;
  taskId?: string;
  taskOutcome?: string;
  task: string;
  outcome: 'completed' | 'failed';
  files: string[];
  checks: 'passed' | 'failed' | 'none';
  /** A short account from the finished agent run; file paths above remain the evidence to verify it against. */
  summary?: string;
}

export interface ProjectKnowledge {
  version: 1;
  root: string;
  updatedAt: string;
  /** Files seen changing, with how often and when last. Bounded, so a busy project cannot grow it without limit. */
  changes: Record<string, { count: number; lastAt: string }>;
  /** The latest finished runs, newest last. */
  runs: RunNote[];
}

export const MAX_RUN_NOTES = 30;
export const MAX_TRACKED_FILES = 400;
const RECENT_DAYS = 14;
const DEFAULT_BRIEFING_CHARACTERS = 3_200;

export function emptyKnowledge(root: string): ProjectKnowledge {
  return { version: 1, root, updatedAt: new Date(0).toISOString(), changes: {}, runs: [] };
}

/** Records that these project-relative files changed at `at`. Returns a new value. */
export function noteChanges(knowledge: ProjectKnowledge, files: readonly string[], at: string): ProjectKnowledge {
  if (files.length === 0) return knowledge;
  const changes = { ...knowledge.changes };
  for (const file of new Set(files)) {
    const previous = changes[file];
    changes[file] = { count: (previous?.count ?? 0) + 1, lastAt: at };
  }
  const kept = Object.entries(changes)
    .sort((left, right) => right[1].lastAt.localeCompare(left[1].lastAt))
    .slice(0, MAX_TRACKED_FILES);
  return { ...knowledge, updatedAt: at, changes: Object.fromEntries(kept) };
}

/** Records one finished run. Returns a new value. */
export function noteRun(knowledge: ProjectKnowledge, note: RunNote): ProjectKnowledge {
  const runs = [...knowledge.runs, note].slice(-MAX_RUN_NOTES);
  return { ...knowledge, updatedAt: note.at, runs };
}

/** "src/ (123 files: .ts, .tsx)", biggest folders first, for the top level of a project. */
export function summariseFolders(files: readonly string[], limit = 12): string[] {
  const groups = new Map<string, { count: number; extensions: Map<string, number> }>();
  for (const file of files) {
    const slash = file.indexOf('/');
    const key = slash < 0 ? '(top level)' : `${file.slice(0, slash)}/`;
    const group = groups.get(key) ?? { count: 0, extensions: new Map() };
    group.count += 1;
    const extension = path.extname(file).toLowerCase();
    if (extension) group.extensions.set(extension, (group.extensions.get(extension) ?? 0) + 1);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort((left, right) => right[1].count - left[1].count)
    .slice(0, limit)
    .map(([name, group]) => {
      const top = [...group.extensions.entries()].sort((left, right) => right[1] - left[1]).slice(0, 2).map(([extension]) => extension);
      return `${name} (${group.count} file${group.count === 1 ? '' : 's'}${top.length ? `: ${top.join(', ')}` : ''})`;
    });
}

function oneLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/**
 * The briefing an agent is handed. Empty when KAI has learned nothing yet, so a brand-new project gets no filler.
 * Sections are dropped from the bottom when the text would run long, because the folder shape and the check commands
 * are worth more to a newcomer than the oldest run note.
 */
export function renderKnowledge(
  knowledge: ProjectKnowledge,
  extras: { folders?: readonly string[]; scripts?: readonly string[]; now?: number; maxCharacters?: number; query?: string } = {},
): string {
  const now = extras.now ?? Date.now();
  const sections: string[] = [];

  if (extras.folders?.length) sections.push(`Folders: ${extras.folders.join('; ')}.`);
  if (extras.scripts?.length) sections.push(`To check your work: ${extras.scripts.join(', ')}.`);

  const cutoff = now - RECENT_DAYS * 86_400_000;
  const hot = Object.entries(knowledge.changes)
    .filter(([, change]) => Date.parse(change.lastAt) >= cutoff)
    .sort((left, right) => right[1].count - left[1].count || right[1].lastAt.localeCompare(left[1].lastAt))
    .slice(0, 8)
    .map(([file, change]) => `${file} (${change.count}×)`);
  if (hot.length) sections.push(`Files being worked on lately: ${hot.join(', ')}.`);

  const recentRuns = knowledge.runs.slice(-5).reverse();
  const queryTerms = new Set((extras.query?.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []));
  const relevance = (run: RunNote): number => {
    if (queryTerms.size === 0) return 0;
    const searchable = `${run.task} ${run.summary ?? ''} ${run.files.join(' ')}`.toLowerCase();
    let matches = 0;
    for (const term of queryTerms) if (searchable.includes(term)) matches += 1;
    return matches / queryTerms.size;
  };
  const runs = [...recentRuns]
    .map((run, index) => ({ run, index, score: relevance(run) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 5)
    .map(({ run }) => {
    const files = run.files.slice(0, 4).join(', ') + (run.files.length > 4 ? ` and ${run.files.length - 4} more` : '');
    const checks = run.checks === 'none' ? '' : `, checks ${run.checks}`;
    const summary = run.summary ? ` — ${oneLine(run.summary, 180)}` : '';
    return `- ${run.at.slice(0, 10)} ${run.outcome === 'completed' ? 'done' : 'did not finish'}: "${oneLine(run.task, 110)}"${summary}; evidence: ${files || 'no files'}${checks}`;
  });
  if (runs.length) sections.push(`What earlier runs here did:\n${runs.join('\n')}`);

  if (sections.length === 0) return '';
  const head = '# What KAI already knows about this project\nStart from this and open files by name; search only for what it does not cover.';
  const limit = extras.maxCharacters ?? DEFAULT_BRIEFING_CHARACTERS;
  let text = head;
  for (const section of sections) {
    if (text.length + section.length + 2 > limit) break;
    text += `\n\n${section}`;
  }
  return text;
}

/** The check commands a project's package.json offers, as the commands to type. */
export async function projectScripts(root: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
    const wanted = ['typecheck', 'test', 'lint', 'build'];
    return wanted.filter((name) => typeof parsed.scripts?.[name] === 'string').map((name) => `npm run ${name}`);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The service: storage, the watcher, and the entry points the rest of the app calls.
// ---------------------------------------------------------------------------------------------------------------------

const IGNORED_SEGMENTS = new Set([
  '.git', '.hg', '.svn', '.kai', '.next', '.venv', '__pycache__', 'build', 'coverage', 'dist', 'node_modules', 'out', 'release',
  'target', 'vendor', '.cache', '.turbo', '.idea', '.vscode',
]);
const IGNORED_SUFFIX = /(?:~|\.log|\.tmp|\.swp|\.lock)$/i;
const FLUSH_MS = 4_000;
const SAVE_MS = 10_000;
const MAX_WATCHED_PROJECTS = 5;

/** True for a path nobody wants to learn from: dependencies, build output, editor scratch files. */
export function shouldIgnore(relative: string): boolean {
  if (!relative) return true;
  const normal = relative.replace(/\\/g, '/');
  return normal.split('/').some((segment) => IGNORED_SEGMENTS.has(segment)) || IGNORED_SUFFIX.test(normal);
}

interface Live {
  knowledge: ProjectKnowledge;
  watcher: FSWatcher | null;
  pending: Set<string>;
  flushTimer: NodeJS.Timeout | null;
  saveTimer: NodeJS.Timeout | null;
  folders: { at: number; lines: string[] } | null;
}

let storageDirectory: string | null = null;
const live = new Map<string, Live>();

/** Tells the service where to keep its files. Until it is called nothing is read, written or watched. */
export function configureProjectKnowledge(directory: string): void {
  storageDirectory = directory;
}

function fileFor(root: string): string | null {
  if (!storageDirectory) return null;
  const key = createHash('sha1').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 12);
  return path.join(storageDirectory, `${path.basename(root).replace(/[^\w.-]/g, '_')}-${key}.json`);
}

async function open(root: string): Promise<Live> {
  const resolved = path.resolve(root);
  const existing = live.get(resolved);
  if (existing) return existing;
  let knowledge = emptyKnowledge(resolved);
  const file = fileFor(resolved);
  if (file) {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as ProjectKnowledge;
      if (parsed?.version === 1 && parsed.changes && Array.isArray(parsed.runs)) knowledge = { ...parsed, root: resolved };
    } catch {
      // No file yet, or one that cannot be read: start empty rather than refuse to learn.
    }
  }
  const entry: Live = { knowledge, watcher: null, pending: new Set(), flushTimer: null, saveTimer: null, folders: null };
  // Another call may have opened it while this one was reading the file; the first one wins.
  return live.get(resolved) ?? (live.set(resolved, entry), entry);
}

async function save(root: string): Promise<void> {
  const entry = live.get(path.resolve(root));
  const file = fileFor(root);
  if (!entry || !file) return;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(entry.knowledge), 'utf8');
    await fs.rename(temporary, file);
  } catch {
    // Learning is a convenience; a failed save is retried with the next change.
  }
}

function scheduleSave(root: string, entry: Live): void {
  if (entry.saveTimer) return;
  entry.saveTimer = setTimeout(() => {
    entry.saveTimer = null;
    void save(root);
  }, SAVE_MS);
  entry.saveTimer.unref?.();
}

/** Starts learning from the project's files changing. Safe to call on every open; it watches each project once. */
export async function startWatchingProject(root: string): Promise<void> {
  if (!storageDirectory) return;
  const resolved = path.resolve(root);
  const entry = await open(resolved);
  if (entry.watcher) return;
  if ([...live.values()].filter((item) => item.watcher).length >= MAX_WATCHED_PROJECTS) return;
  try {
    entry.watcher = watch(resolved, { recursive: true, persistent: false }, (_event, name) => {
      const relative = typeof name === 'string' ? name.replace(/\\/g, '/') : '';
      if (shouldIgnore(relative)) return;
      entry.pending.add(relative);
      if (entry.flushTimer) return;
      entry.flushTimer = setTimeout(() => {
        entry.flushTimer = null;
        const files = [...entry.pending];
        entry.pending.clear();
        entry.knowledge = noteChanges(entry.knowledge, files, new Date().toISOString());
        scheduleSave(resolved, entry);
      }, FLUSH_MS);
      entry.flushTimer.unref?.();
    });
    entry.watcher.on('error', () => {
      entry.watcher?.close();
      entry.watcher = null;
    });
  } catch {
    // A platform or folder that cannot be watched simply learns from runs alone.
  }
}

/** The briefing for a project, or an empty string when there is nothing to say yet. */
export async function knowledgeBriefing(root: string, maxCharacters?: number, query?: string): Promise<string> {
  if (!storageDirectory) return '';
  const resolved = path.resolve(root);
  const entry = await open(resolved);
  if (!entry.folders || Date.now() - entry.folders.at > 60_000) {
    const files = await listProjectFiles(resolved).catch(() => [] as string[]);
    entry.folders = { at: Date.now(), lines: summariseFolders(files) };
  }
  return renderKnowledge(entry.knowledge, {
    folders: entry.folders.lines,
    scripts: await projectScripts(resolved),
    ...(maxCharacters ? { maxCharacters } : {}),
    ...(query ? { query } : {}),
  });
}

/** Adds one finished run to what is known about the project. */
export async function recordRunKnowledge(root: string, note: RunNote): Promise<void> {
  if (!storageDirectory) return;
  const entry = await open(root);
  entry.knowledge = noteRun(entry.knowledge, note);
  scheduleSave(root, entry);
}

/** Writes anything waiting and closes the watchers. Called on quit. */
export async function stopProjectKnowledge(): Promise<void> {
  const saves: Promise<void>[] = [];
  for (const [root, entry] of live) {
    entry.watcher?.close();
    entry.watcher = null;
    if (entry.flushTimer) clearTimeout(entry.flushTimer);
    if (entry.saveTimer) clearTimeout(entry.saveTimer);
    if (entry.pending.size > 0) entry.knowledge = noteChanges(entry.knowledge, [...entry.pending], new Date().toISOString());
    entry.pending.clear();
    saves.push(save(root));
  }
  await Promise.all(saves);
  live.clear();
}
