import type { ConversationRecord } from '@kai/contracts';
import { collectPaidRuns, type ExternalPaidRun } from './usage-budget';

/**
 * A small index of what the paid API runs have cost, so a run can check the budget without reading every saved
 * conversation.
 *
 * The usage check used to load all of the conversations (661 of them, 718 MB of JSON, a few gigabytes of objects) at
 * the start and end of every API run, and eight runs starting together ran KAI's main process out of memory. Of
 * everything in those conversations the check needs only the paid runs: 565 records in all, about a tenth of a
 * megabyte.
 *
 * It follows the conversations two ways, and either alone would be enough to keep it right:
 *  - it is told whenever a conversation is saved or removed, and takes the paid runs from the record it is handed;
 *  - it compares a cheap stamp of every conversation file with the one it holds, and reads again only a file whose
 *    stamp differs: a conversation written by an older build, or edited by hand, or one saved before this existed.
 * A conversation is only ever read one at a time, so the most it holds is the biggest single file.
 */

const LEDGER_VERSION = 1;
const PERSIST_DELAY_MS = 2_000;

interface Entry {
  /** The conversation file's stamp when these runs were taken from it. */
  stamp: string | null;
  title: string;
  runs: ExternalPaidRun[];
}

export interface UsageLedgerPorts {
  /** Every saved conversation's stamp, by id, without reading any of them. */
  stamps(): Promise<Map<string, string>>;
  /** One conversation, read on its own. Null when it is gone or cannot be read. */
  read(id: string): Promise<ConversationRecord | null>;
  /** The ledger as last written, or null when there is none. */
  load(): Promise<string | null>;
  save(text: string): Promise<void>;
}

export class UsageLedger {
  private readonly entries = new Map<string, Entry>();
  private loaded: Promise<void> | null = null;
  private reconciling: Promise<void> | null = null;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly ports: UsageLedgerPorts, private readonly persistDelayMs: number = PERSIST_DELAY_MS) {}

  /** Every paid run there is, brought up to date with what is on disk first. */
  async runs(): Promise<ExternalPaidRun[]> {
    await this.ensureLoaded();
    // One catch-up for everyone who asks while it is going, so eight runs starting together do it once.
    this.reconciling ??= this.reconcile().finally(() => { this.reconciling = null; });
    await this.reconciling;
    return [...this.entries.values()].flatMap((entry) => entry.runs);
  }

  /** A conversation was saved. Its paid runs are taken from the record itself: nothing is read. */
  noteSaved(conversation: ConversationRecord, stamp: string | null): void {
    this.entries.set(conversation.id, { stamp, title: conversation.title, runs: collectPaidRuns([conversation]) });
    this.touch();
  }

  noteRemoved(id: string): void {
    if (this.entries.delete(id)) this.touch();
  }

  /** Writes the ledger now, for a quit. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.dirty) await this.persist();
    await this.writing;
  }

  private ensureLoaded(): Promise<void> {
    this.loaded ??= (async () => {
      let text: string | null = null;
      try {
        text = await this.ports.load();
      } catch {
        // Unreadable is the same as absent: it is rebuilt from the conversations below.
      }
      if (!text) return;
      try {
        const parsed = JSON.parse(text) as { version?: unknown; entries?: unknown };
        if (parsed.version !== LEDGER_VERSION || !parsed.entries || typeof parsed.entries !== 'object') return;
        for (const [id, value] of Object.entries(parsed.entries as Record<string, unknown>)) {
          const entry = value as Partial<Entry> | null;
          if (!entry || !Array.isArray(entry.runs) || typeof entry.title !== 'string') continue;
          // What this run has already been told about a conversation is newer than what was written before.
          if (!this.entries.has(id)) this.entries.set(id, { stamp: typeof entry.stamp === 'string' ? entry.stamp : null, title: entry.title, runs: entry.runs });
        }
      } catch {
        // A damaged ledger is simply not used; the conversations are the truth and it is built again from them.
      }
    })();
    return this.loaded;
  }

  private async reconcile(): Promise<void> {
    const stamps = await this.ports.stamps();
    for (const id of [...this.entries.keys()]) {
      if (!stamps.has(id)) {
        this.entries.delete(id);
        this.dirty = true;
      }
    }
    for (const [id, stamp] of stamps) {
      if (this.entries.get(id)?.stamp === stamp) continue;
      // One at a time, and nothing kept but the paid runs: this is the only place a whole conversation is read.
      const conversation = await this.ports.read(id).catch(() => null);
      if (!conversation) {
        if (this.entries.delete(id)) this.dirty = true;
        continue;
      }
      this.entries.set(id, { stamp, title: conversation.title, runs: collectPaidRuns([conversation]) });
      this.dirty = true;
    }
    if (this.dirty) this.touch();
  }

  private touch(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.persist();
    }, this.persistDelayMs);
    this.timer.unref?.();
  }

  private persist(): Promise<void> {
    this.dirty = false;
    const text = JSON.stringify({ version: LEDGER_VERSION, entries: Object.fromEntries(this.entries) });
    // Written in order, and never allowed to fail the caller: the conversations can always rebuild it.
    this.writing = this.writing.then(() => this.ports.save(text)).catch(() => undefined);
    return this.writing;
  }
}
