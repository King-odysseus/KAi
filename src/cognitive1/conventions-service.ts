import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { buildProfile, snapshotProject } from './conventions';
import type { ProjectSnapshot } from './conventions';
import { readStyleFacts, styleConventionsOf } from './style-scan';

/**
 * The extension's own version of KAI Desktop's convention service. It learns how the developer builds from the
 * project folders under one parent folder, keeps learning on a timer, files what it serves into this extension's own
 * C1, and hands every agent run a short list. It shares nothing with the desktop app: the two keep separate memory.
 */

export interface ConventionItem {
  key: string;
  source: 'habit' | 'style' | 'rule';
  text: string;
  evidence: string;
  projects: string[];
  muted: boolean;
  isNew: boolean;
}

export interface ConventionsState {
  scannedAt: string | null;
  scanning: boolean;
  total: number;
  items: ConventionItem[];
  rules: Array<{ id: string; text: string }>;
  projects: Array<{ name: string; path: string; reference: boolean }>;
  filedInC1: number;
}

interface Saved {
  references: string[];
  rules: Array<{ id: string; text: string }>;
  muted: string[];
  seen: string[];
  filed: Record<string, string>;
}

const emptySaved = (): Saved => ({ references: [], rules: [], muted: [], seen: [], filed: {} });

export interface ConventionPorts {
  /** The folders to read as projects: every folder inside the chosen parent folder. */
  projectFolders(): Promise<string[]>;
  /** Files one note into this extension's C1. */
  learn(note: { title: string; description: string; tags: string[] }): Promise<unknown>;
  onChange?(state: ConventionsState): void;
  now?(): number;
}

const STALE_MS = 15 * 60_000;
const BRIEFING_LINES = 12;
const BRIEFING_CHARS = 1_800;
const HABIT_SHARE = 0.4;

/** One line per convention an agent should follow: rules first, then style, then the stack. Muted ones are left out. */
export function buildBriefing(items: readonly ConventionItem[]): string {
  const order = { rule: 0, style: 1, habit: 2 } as const;
  const lines = items
    .filter((item) => !item.muted)
    .sort((a, b) => order[a.source] - order[b.source])
    .map((item) => `- ${item.text}`)
    .slice(0, BRIEFING_LINES);
  if (lines.length === 0) return '';
  const text = ['How this developer builds. Follow these in any code you write, unless the task says otherwise:', ...lines].join('\n');
  return text.length > BRIEFING_CHARS ? `${text.slice(0, BRIEFING_CHARS - 1)}…` : text;
}

const fingerprint = (text: string): string => createHash('sha1').update(text).digest('hex').slice(0, 12);

export class ConventionService {
  private items: ConventionItem[] = [];
  private styleItems: ConventionItem[] = [];
  private habitItems: ConventionItem[] = [];
  private folders: string[] = [];
  private total = 0;
  private scannedAt: string | null = null;
  private scanning: Promise<void> | null = null;
  private followUp: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private firstTimer: NodeJS.Timeout | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private cachedBriefing = '';

  constructor(private readonly filePath: string, private readonly ports: ConventionPorts) {}

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

  /** Resolves when no scan or write is in flight. */
  async idle(): Promise<void> {
    for (let round = 0; round < 3; round += 1) await Promise.allSettled([this.scanning, this.followUp, this.tail]);
  }

  private async load(): Promise<Saved> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as Partial<Saved>;
      return { ...emptySaved(), ...parsed };
    } catch {
      return emptySaved();
    }
  }

  private async save(saved: Saved): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(saved), 'utf8');
    await fs.rename(temporary, this.filePath);
  }

  private write(change: (saved: Saved) => Saved): Promise<Saved> {
    const result = this.tail.then(async () => {
      const next = change(await this.load());
      await this.save(next);
      return next;
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Reads the projects again. A call made during a scan queues one fresh scan after it, shared by everyone waiting. */
  refresh(): Promise<void> {
    if (this.scanning) {
      this.followUp ??= this.scanning.then(() => { this.followUp = null; return this.refresh(); });
      return this.followUp;
    }
    this.scanning = this.scan().finally(() => { this.scanning = null; });
    return this.scanning;
  }

  private async scan(): Promise<void> {
    const saved = await this.load();
    const folders = await this.ports.projectFolders().catch(() => [] as string[]);
    const snapshots: ProjectSnapshot[] = [];
    for (const folder of folders) {
      try { snapshots.push(await snapshotProject(folder, path.basename(folder))); } catch { /* skipped */ }
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
      if (!folders.includes(reference)) continue;
      const name = path.basename(reference);
      const facts = await readStyleFacts(reference).catch(() => null);
      if (!facts) continue;
      for (const item of styleConventionsOf(facts)) {
        styles.push({ key: `style:${name}:${item.key}`, source: 'style', text: `${item.text} (as in ${name})`, evidence: item.evidence, projects: [name], muted: false, isNew: false });
      }
    }
    this.folders = folders;
    this.total = snapshots.length;
    this.scannedAt = at;
    this.styleItems = styles;
    this.habitItems = habits;
    const next = await this.write((current) =>
      // The first list the developer ever has is not "new": only what turns up afterwards is.
      current.seen.length === 0 && this.merge(current).length > 0 ? { ...current, seen: this.items.map((item) => item.key) } : current);
    this.merge(next);
    this.emit(next);
    await this.fileInC1();
  }

  private merge(saved: Saved): ConventionItem[] {
    const rules: ConventionItem[] = saved.rules.map((rule) => ({ key: `rule:${rule.id}`, source: 'rule', text: rule.text, evidence: 'Written by you', projects: [], muted: false, isNew: false }));
    const seen = new Set(saved.seen);
    const muted = new Set(saved.muted);
    this.items = [...rules, ...this.styleItems, ...this.habitItems].map((item) => ({ ...item, muted: muted.has(item.key), isNew: seen.size > 0 && !seen.has(item.key) && item.source !== 'rule' }));
    this.cachedBriefing = buildBriefing(this.items);
    return this.items;
  }

  private snapshot(saved: Saved): ConventionsState {
    const served = this.items.filter((item) => !item.muted);
    return {
      scannedAt: this.scannedAt,
      scanning: this.scanning !== null,
      total: this.total,
      items: this.items,
      rules: saved.rules,
      projects: this.folders.map((folder) => ({ name: path.basename(folder), path: folder, reference: saved.references.includes(folder) })),
      filedInC1: served.filter((item) => saved.filed[item.key] !== undefined).length,
    };
  }

  private emit(saved: Saved): void {
    this.ports.onChange?.(this.snapshot(saved));
  }

  /** Files each served convention into C1 once, and again when its wording changes. A failure is not fatal. */
  private async fileInC1(): Promise<void> {
    const saved = await this.load();
    const pending = this.items.filter((item) => !item.muted && saved.filed[item.key] !== fingerprint(item.text));
    if (pending.length === 0) return;
    const filed: Record<string, string> = {};
    for (const item of pending) {
      try {
        await this.ports.learn({
          title: `Convention: ${item.text.slice(0, 80)}`,
          description: `${item.text}. ${item.evidence}. It is how this developer already builds: follow it in any code you write unless the task says otherwise.`,
          tags: ['convention', item.source, 'auto-detected'],
        });
        filed[item.key] = fingerprint(item.text);
      } catch { /* tried again on the next scan */ }
    }
    if (Object.keys(filed).length === 0) return;
    const next = await this.write((current) => ({ ...current, filed: { ...current.filed, ...filed } }));
    this.emit(next);
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

  private async changed(change: (saved: Saved) => Saved): Promise<ConventionsState> {
    const saved = await this.write(change);
    this.merge(saved);
    this.emit(saved);
    void this.fileInC1().catch(() => undefined);
    return this.snapshot(saved);
  }

  async setReference(folder: string, reference: boolean): Promise<ConventionsState> {
    const result = await this.changed((saved) => ({ ...saved, references: reference ? [...new Set([...saved.references, folder])].slice(0, 50) : saved.references.filter((item) => item !== folder) }));
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

  markSeen(): Promise<ConventionsState> {
    return this.changed((saved) => ({ ...saved, seen: [...new Set([...saved.seen, ...this.items.map((item) => item.key)])].slice(-600) }));
  }
}
