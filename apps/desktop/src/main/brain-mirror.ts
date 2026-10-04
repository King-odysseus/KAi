import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * The second brain. KAI writes to its own C1 daemon and, when a mirror is configured, files the same lesson into
 * another daemon as well — usually the standalone one that commits and pushes its brain on a timer.
 *
 * Mirroring only happens on the way in. Reads, claims, sessions and handoffs stay with the daemon that owns them,
 * because copying that state would leave the two disagreeing about who is working where.
 *
 * This file holds the once-only half: taking the entries a brain already has and filing them into the other one, so
 * switching the mirror on does not leave years of earlier lessons behind. Entries go in through the learn route, so
 * the receiving brain applies its own duplicate and quality rules rather than trusting ours.
 */

export const BRAIN_TYPES = ['bugs', 'decisions', 'gotchas', 'patterns'] as const;
export type BrainType = (typeof BRAIN_TYPES)[number];

export interface BrainEntry {
  type: BrainType;
  /** The heading after the date, without the trailing `-- agent`. */
  title: string;
  agent: string;
  /** The `#tags:` line, comma-separated, when the file has one. */
  tags: string;
  date: string;
  /** Everything under the heading, verbatim. */
  body: string;
  /** The entry's own project, when the body names one. An entry with none is filed without a project. */
  project?: string;
}

const HEADING = /^## \[(\d{4}-\d{2}-\d{2})\]\s*(.+)$/;

/**
 * Reads one of the four learned markdown files. A file that is missing or unreadable is no entries rather than an
 * error: a brain with no decisions yet is normal, and the migration should not stop for it.
 */
export function parseLearnedMarkdown(type: BrainType, markdown: string): BrainEntry[] {
  const entries: BrainEntry[] = [];
  // The daemon writes these files with Windows line endings, and in JavaScript `.` does not match a carriage
  // return, so a heading would never match until the endings are normalised.
  for (const block of markdown.replace(/\r\n?/g, '\n').split(/\n(?=## \[)/)) {
    const lines = block.split('\n');
    const heading = HEADING.exec(lines[0] ?? '');
    if (!heading) continue;
    const rest = heading[2] ?? '';
    // Titles carry the agent after ` -- `; a title is allowed to contain hyphens of its own.
    const split = rest.lastIndexOf(' -- ');
    const title = (split > 0 ? rest.slice(0, split) : rest).trim();
    const agent = split > 0 ? rest.slice(split + 4).trim() : 'unknown';
    if (!title) continue;
    const body = lines.slice(1).join('\n').trim();
    const tagLine = lines.find((line) => line.trim().toLowerCase().startsWith('#tags:'));
    // The project the entry was filed under, which the daemon writes into the body. Reading it here is what keeps
    // a mirrored entry in its own project instead of landing in the other brain as `global`, dated today — where it
    // also picked up the recency boost and started crowding out real recall.
    const projectLine = lines.find((line) => /^project:/i.test(line.trim()));
    entries.push({
      type,
      title,
      agent: agent || 'unknown',
      tags: tagLine ? tagLine.split(':').slice(1).join(':').trim() : '',
      date: heading[1] ?? '',
      body,
      ...(projectLine ? { project: projectLine.split(':').slice(1).join(':').trim() } : {}),
    });
  }
  return entries;
}

export interface MirrorTransport {
  /** Files one entry. Answers true when the receiving brain took it. */
  post(entry: BrainEntry): Promise<boolean>;
}

export interface MirrorOutcome {
  read: number;
  posted: number;
  rejected: number;
  failed: number;
}

/** Files entries one at a time, counting what the receiving brain turned away so the caller can report honestly. */
export async function postEntries(entries: readonly BrainEntry[], transport: MirrorTransport): Promise<MirrorOutcome> {
  const outcome: MirrorOutcome = { read: entries.length, posted: 0, rejected: 0, failed: 0 };
  for (const entry of entries) {
    try {
      if (await transport.post(entry)) outcome.posted += 1;
      else outcome.rejected += 1;
    } catch {
      outcome.failed += 1;
    }
  }
  return outcome;
}

/** Reads the four learned files of a brain. A missing file is no entries, not a failure. */
export async function readBrainEntries(brainDir: string): Promise<BrainEntry[]> {
  const entries: BrainEntry[] = [];
  for (const type of BRAIN_TYPES) {
    const markdown = await fs.readFile(path.join(brainDir, 'learned', `${type}.md`), 'utf8').catch(() => '');
    entries.push(...parseLearnedMarkdown(type, markdown));
  }
  return entries;
}

/**
 * A comparable form of an entry, for asking "does the other brain already have this?". It matches the way the
 * receiving daemon compares for itself: type and title, ignoring case and punctuation.
 */
export function entryKey(type: BrainType, title: string): string {
  return `${type}:${title.toLowerCase().replace(/[^a-z0-9]+/g, '')}`;
}

/** The entries the other brain already holds, so a sync only sends what is missing. */
export async function fetchMirrorKeys(
  endpoint: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 30_000,
): Promise<Set<string>> {
  const keys = new Set<string>();
  const response = await fetchImpl(new URL('/api/brain/export?format=json', endpoint), {
    headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`The mirror answered ${response.status} when asked what it already holds.`);
  const payload = (await response.json()) as { entries?: Array<{ type?: string; title?: string }> };
  for (const entry of payload.entries ?? []) {
    if (entry?.type && entry.title) keys.add(entryKey(entry.type as BrainType, entry.title));
  }
  return keys;
}

export interface MirrorBrainOptions {
  /** The brain directory to read from, the same one the Brain page calls the brain; `learned/` sits inside it. */
  sourceBrain: string;
  endpoint: string;
  token?: string;
  /** Reports the entries without filing them, so the plan can be seen before anything is written. */
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
  project?: string;
  onProgress?: (done: number, total: number) => void;
  /**
   * Told about an entry the mirror turned away, with whatever reason it gave.
   *
   * A rejection is not a failure and does not stop the sync, so it used to be counted and otherwise dropped — the
   * entry simply came back in the next reconcile, every fifteen minutes, forever, with nothing anywhere saying which
   * entry or why. That is a loop nobody can see or fix.
   */
  onRejected?: (entry: BrainEntry, reason: string) => void;
}

/**
 * Brings the mirror up to date with this brain: it reads every entry this brain holds, asks the mirror what it
 * already has, and files the difference.
 *
 * The reconcile is what covers every way a lesson can arrive. A run, the Save to Brain dialog, and an agent calling
 * brain_learn over its own MCP connection all end up in the same four files, so reading the files catches what
 * intercepting calls would miss. The receiving brain still applies its own duplicate and quality rules, so a race
 * between this and a live mirror of the same entry costs a wasted request, never a duplicate entry.
 */
export async function syncBrainToMirror(options: MirrorBrainOptions): Promise<MirrorOutcome & { skipped: number }> {
  const entries = await readBrainEntries(options.sourceBrain);
  const empty = { read: entries.length, posted: 0, rejected: 0, failed: 0, skipped: 0 };
  if (options.dryRun) return empty;

  const send = options.fetchImpl ?? fetch;
  // A mirror that will not say what it holds is not a reason to stop: the entries it already has will be turned
  // away as duplicates, so the sync still converges, just with more requests.
  const known = await fetchMirrorKeys(options.endpoint, options.token, send).catch(() => new Set<string>());
  const missing = entries.filter((entry) => !known.has(entryKey(entry.type, entry.title)));
  if (missing.length === 0) return empty;

  let done = 0;
  const outcome = await postEntries(missing, {
    post: async (entry) => {
      const response = await send(new URL('/api/brain/learn', options.endpoint), {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
        body: JSON.stringify({
          type: entry.type,
          title: entry.title,
          note: entry.body.slice(0, 8_000),
          tags: entry.tags,
          agent: entry.agent,
          // The entry's own project first. `options.project` is the fallback for an entry whose body names none,
          // and that was the only thing ever sent — so every mirrored entry lost the project it was filed under.
          ...(entry.project ?? options.project ? { project: entry.project ?? options.project } : {}),
        }),
        signal: AbortSignal.timeout(20_000),
      });
      done += 1;
      options.onProgress?.(done, missing.length);
      if (!response.ok) {
        options.onRejected?.(entry, `the mirror answered ${response.status}`);
        return false;
      }
      const payload = (await response.json().catch(() => null)) as { rejected?: boolean; duplicate?: boolean; reason?: string } | null;
      const accepted = payload?.rejected !== true && payload?.duplicate !== true;
      if (!accepted) options.onRejected?.(entry, payload?.reason || (payload?.duplicate === true ? 'already there' : 'the mirror refused it'));
      return accepted;
    },
  });
  return { ...outcome, read: entries.length, skipped: entries.length - missing.length };
}

export interface BrainMirrorLoopOptions {
  /** Whether to sync at all right now: the mirror is on and the brain is up. */
  ready: () => Promise<boolean>;
  sync: () => Promise<{ posted: number; failed: number }>;
  intervalMs?: number;
  onError?: (error: unknown) => void;
  onSync?: (outcome: { posted: number; failed: number }) => void;
}

/** Close enough to the other daemon's own sync cadence that a lesson arrives in the same window. */
const DEFAULT_SYNC_INTERVAL_MS = 15 * 60_000;
/** A first pass waits a moment, so it does not compete with everything else the app starts at launch. */
const FIRST_SYNC_DELAY_MS = 45_000;

/**
 * Keeps a brain and its mirror level, without anyone pressing anything. It is what makes agents writing straight to
 * the daemon over MCP arrive in the other brain too: nothing intercepts them, the files are simply read afterwards.
 */
export class BrainMirrorLoop {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly intervalMs: number;

  constructor(private readonly options: BrainMirrorLoopOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
    const first = setTimeout(() => void this.tick(), FIRST_SYNC_DELAY_MS);
    first.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass, never two at once, and never a thrown error: a background job has nobody to tell. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (!(await this.options.ready())) return;
      const outcome = await this.options.sync();
      if (outcome.posted > 0 || outcome.failed > 0) this.options.onSync?.(outcome);
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.running = false;
    }
  }
}
