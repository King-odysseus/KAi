import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { conventionRuleSchema } from '@kai/contracts';
import type { ConventionItem, ConventionsState } from '@kai/contracts';
import { AtomicJsonStore, type NodeFileSystem } from '@kai/runtime';
import { buildProfile, snapshotProject } from './conventions-scan';
import type { ProjectSnapshot } from './conventions-scan';
import { readStyleFacts, styleConventionsOf } from './style-scan';

const stateSchema = z
  .object({
    schemaVersion: z.literal(1),
    // Project folders the developer marked as "this is how I want it to look".
    references: z.array(z.string()).max(50),
    rules: z.array(conventionRuleSchema).max(60),
    // Keys the developer turned off.
    muted: z.array(z.string()).max(300),
    // Keys the developer has already been shown, so a new one can be flagged.
    seen: z.array(z.string()).max(600),
    // What was filed in C1, by key, with a fingerprint of its text so a changed convention is filed again.
    filed: z.record(z.string(), z.string()),
  })
  .strict();
type Saved = z.infer<typeof stateSchema>;
const emptySaved = (): Saved => ({ schemaVersion: 1, references: [], rules: [], muted: [], seen: [], filed: {} });

export interface ConventionPorts {
  /** Every project the developer has opened. */
  projects(): Promise<Array<{ id: string; name: string; path: string }>>;
  /** Files one note into C1. Returns what C1 answered. */
  learn(payload: Record<string, unknown>): Promise<unknown>;
  /** Told whenever the list changes, so the screen can show it. */
  onChange?(state: ConventionsState): void;
  now?(): number;
}

const STALE_MS = 15 * 60_000;
const BRIEFING_LINES = 12;
const BRIEFING_CHARS = 1_800;
/** A habit is served on every run only when at least this share of the developer's projects show it. */
const HABIT_SHARE = 0.4;

/** One line per convention an agent should follow, rules first, then style, then the stack. Pure, so it can be tested. */
export function buildBriefing(items: readonly ConventionItem[]): string {
  const served = items.filter((item) => !item.muted);
  const order: Record<ConventionItem['source'], number> = { rule: 0, style: 1, habit: 2 };
  const lines = [...served]
    .sort((a, b) => order[a.source] - order[b.source])
    .map((item) => `- ${item.text}`)
    .slice(0, BRIEFING_LINES);
  if (lines.length === 0) return '';
  const text = ['How this developer builds. Follow these in any code you write, unless the task says otherwise:', ...lines].join('\n');
  return text.length > BRIEFING_CHARS ? `${text.slice(0, BRIEFING_CHARS - 1)}…` : text;
}

const fingerprint = (text: string): string => createHash('sha1').update(text).digest('hex').slice(0, 12);

/**
 * Learns how the developer builds, keeps learning, and hands every agent run the short list. It reads project folders
 * on this computer (no model, nothing sent anywhere), counts what several projects share, reads the look of the
 * projects marked as references, adds the developer's own rules, and files what it serves into C1 so the brain holds
 * it too. Rescans run on a timer and when a run finds the list old, never on the run's own time.
 */
export class ConventionService {
  private readonly store: AtomicJsonStore<Saved>;
  private items: ConventionItem[] = [];
  private projects: Array<{ name: string; path: string }> = [];
  private total = 0;
  private scannedAt: string | null = null;
  private scanning: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private tail: Promise<void> = Promise.resolve();
  private cachedBriefing = '';
  private styleItems: ConventionItem[] = [];
  private habitItems: ConventionItem[] = [];
  private firstTimer: NodeJS.Timeout | null = null;

  constructor(filePath: string, fileSystem: NodeFileSystem, private readonly ports: ConventionPorts) {
    this.store = new AtomicJsonStore({ filePath, fileSystem, schema: stateSchema, defaultValue: emptySaved });
  }

  private now(): number {
    return this.ports.now?.() ?? Date.now();
  }

  /** Starts watching: a first scan soon after launch, then one every interval. */
  start(intervalMs = 20 * 60_000, firstDelayMs = 15_000): void {
    this.stop();
    this.firstTimer = setTimeout(() => { void this.refresh().catch(() => undefined); }, firstDelayMs);
    this.firstTimer.unref?.();
    this.timer = setInterval(() => { void this.refresh().catch(() => undefined); }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.firstTimer) clearTimeout(this.firstTimer);
    this.timer = null;
    this.firstTimer = null;
  }

  private async load(): Promise<Saved> {
    return this.store.load().catch(emptySaved);
  }

  private write<T>(change: (saved: Saved) => Saved | Promise<Saved>, then: (saved: Saved) => T): Promise<T> {
    const result = this.tail.then(async () => {
      const next = await change(await this.load());
      await this.store.save(next);
      return then(next);
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Reads the projects again. Safe to call often: a scan already running is shared, not started twice. */
  refresh(): Promise<void> {
    if (this.scanning) {
      // A scan that began before this call may have missed what just changed, so one more runs after it. Everyone who
      // asks in the meantime shares that one follow-up, so a burst of requests costs two scans, not many.
      this.followUp ??= this.scanning.then(() => { this.followUp = null; return this.refresh(); });
      return this.followUp;
    }
    this.scanning = this.scan().finally(() => { this.scanning = null; });
    return this.scanning;
  }

  private followUp: Promise<void> | null = null;

  /** Resolves when no scan or write is in flight, so shutdown (and a test) can leave nothing half done behind it. */
  async idle(): Promise<void> {
    for (let round = 0; round < 3; round += 1) await Promise.allSettled([this.scanning, this.followUp, this.tail]);
  }

  private async scan(): Promise<void> {
    const saved = await this.load();
    const projects = await this.ports.projects().catch(() => []);
    const snapshots: ProjectSnapshot[] = [];
    for (const project of projects) {
      try { snapshots.push(await snapshotProject(project.path, project.name)); } catch { /* an unreadable project is skipped */ }
    }
    const at = new Date(this.now()).toISOString();
    const profile = buildProfile(snapshots, at);
    const habits: ConventionItem[] = profile.conventions
      .filter((convention) => convention.count / convention.total >= HABIT_SHARE)
      .map((convention) => ({
        key: `habit:${convention.key}`,
        source: 'habit' as const,
        text: `${convention.label} (used in ${convention.count} of ${convention.total} of your projects)`,
        evidence: `${convention.count} of ${convention.total} projects: ${convention.projects.slice(0, 6).join(', ')}`,
        projects: convention.projects,
        muted: false,
        isNew: false,
      }));

    const styles: ConventionItem[] = [];
    for (const reference of saved.references) {
      const project = projects.find((candidate) => candidate.path === reference);
      if (!project) continue;
      const found = styleConventionsOf(await readStyleFacts(project.path).catch(() => null) ?? { buttons: { radius: {}, border: {}, shadow: {} }, cards: { radius: {}, border: {}, shadow: {} }, samples: { buttons: 0, cards: 0 } });
      for (const item of found) {
        styles.push({
          key: `style:${project.name}:${item.key}`,
          source: 'style',
          text: `${item.text} (as in ${project.name})`,
          evidence: item.evidence,
          projects: [project.name],
          muted: false,
          isNew: false,
        });
      }
    }
    this.projects = projects.map((project) => ({ name: project.name, path: project.path }));
    this.total = snapshots.length;
    this.scannedAt = at;
    await this.apply(styles, habits);
  }

  /** Merges what the scan found with what the developer wrote and muted. Reads and computes only; nothing is sent. */
  private merge(saved: Saved): void {
    const rules: ConventionItem[] = saved.rules.map((rule) => ({
      key: `rule:${rule.id}`, source: 'rule', text: rule.text, evidence: 'Written by you', projects: [], muted: false, isNew: false,
    }));
    const seen = new Set(saved.seen);
    const muted = new Set(saved.muted);
    this.items = [...rules, ...this.styleItems, ...this.habitItems].map((item) => ({
      ...item, muted: muted.has(item.key), isNew: seen.size > 0 && !seen.has(item.key) && item.source !== 'rule',
    }));
    this.cachedBriefing = buildBriefing(this.items);
  }

  /** After a scan: remember what was found, tell the screen, and file what is served into C1. */
  private async apply(styles: ConventionItem[], habits: ConventionItem[]): Promise<void> {
    this.styleItems = styles;
    this.habitItems = habits;
    const saved = await this.write(
      (current) => {
        this.merge(current);
        // The first list the developer ever has is not "new": only what turns up afterwards is.
        return current.seen.length === 0 && this.items.length > 0 ? { ...current, seen: this.items.map((item) => item.key) } : current;
      },
      (next) => next,
    );
    this.merge(saved);
    this.emit(saved);
    await this.fileInC1();
  }

  private emit(saved: Saved): void {
    this.ports.onChange?.(this.snapshot(saved));
  }

  private snapshot(saved: Saved): ConventionsState {
    const served = this.items.filter((item) => !item.muted);
    return {
      scannedAt: this.scannedAt,
      scanning: this.scanning !== null,
      total: this.total,
      items: this.items,
      rules: saved.rules,
      projects: this.projects.map((project) => ({ ...project, reference: saved.references.includes(project.path) })),
      filedInC1: served.filter((item) => saved.filed[item.key] !== undefined).length,
    };
  }

  /** Files each served convention into C1 once, and again whenever its wording changes. A failure is not fatal. */
  private async fileInC1(): Promise<void> {
    const saved = await this.load();
    const pending = this.items.filter((item) => !item.muted && saved.filed[item.key] !== fingerprint(item.text));
    if (pending.length === 0) return;
    const filed: Record<string, string> = {};
    for (const item of pending) {
      try {
        const answer = (await this.ports.learn({
          title: `Convention: ${item.text.slice(0, 80)}`,
          type: 'patterns',
          agent: 'kai',
          project: 'global',
          tags: ['convention', item.source, 'auto-detected'].join(','),
          note: `${item.text}. ${item.evidence}.`,
          why: 'It is how this developer already builds, so new work should match it.',
          how: 'Follow it in any code you write unless the task says otherwise.',
        })) as { ok?: boolean; rejected?: boolean } | null;
        // A rejected note is not retried every scan; it is remembered as filed so C1's own judgement stands.
        if (answer?.rejected || answer?.ok !== false) filed[item.key] = fingerprint(item.text);
      } catch { /* C1 may be stopped; the note is tried again on the next scan */ }
    }
    if (Object.keys(filed).length === 0) return;
    await this.write((current) => ({ ...current, filed: { ...current.filed, ...filed } }), (next) => this.emit(next));
  }

  /** What every agent run is told. Instant: it never waits for a scan, and asks for a fresh one when this is old. */
  briefing(): string {
    if (!this.scannedAt || this.now() - new Date(this.scannedAt).getTime() > STALE_MS) void this.refresh().catch(() => undefined);
    return this.cachedBriefing;
  }

  async state(refresh = false): Promise<ConventionsState> {
    if (refresh) await this.refresh();
    else if (!this.scannedAt) void this.refresh().catch(() => undefined);
    const saved = await this.load();
    this.merge(saved);
    return this.snapshot(saved);
  }

  /** Applies a change to rules, mutes or references at once and tells the screen, without waiting for a scan. */
  private async changed(change: (saved: Saved) => Saved): Promise<ConventionsState> {
    const saved = await this.write(change, (next) => next);
    this.merge(saved);
    this.emit(saved);
    void this.fileInC1().catch(() => undefined);
    return this.snapshot(saved);
  }

  async setReference(path: string, reference: boolean): Promise<ConventionsState> {
    const result = await this.changed((saved) => ({
      ...saved,
      references: reference ? [...new Set([...saved.references, path])].slice(0, 50) : saved.references.filter((item) => item !== path),
    }));
    // A new reference means new style facts to read.
    void this.refresh().catch(() => undefined);
    return result;
  }

  addRule(text: string): Promise<ConventionsState> {
    return this.changed((saved) => ({ ...saved, rules: [...saved.rules, { id: randomUUID().slice(0, 8), text: text.trim() }].slice(0, 60) }));
  }

  removeRule(id: string): Promise<ConventionsState> {
    return this.changed((saved) => ({ ...saved, rules: saved.rules.filter((rule) => rule.id !== id) }));
  }

  setMuted(key: string, muted: boolean): Promise<ConventionsState> {
    return this.changed((saved) => ({ ...saved, muted: muted ? [...new Set([...saved.muted, key])] : saved.muted.filter((item) => item !== key) }));
  }

  /** The person has looked at the list: nothing in it is "new" any more. */
  markSeen(): Promise<ConventionsState> {
    return this.changed((saved) => ({ ...saved, seen: [...new Set([...saved.seen, ...this.items.map((item) => item.key)])].slice(-600) }));
  }
}
