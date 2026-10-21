import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationRecord, UsageBudget } from '../packages/contracts/src';
import { ConversationStore } from '../packages/runtime/src';
import { UsageLedger, type UsageLedgerPorts } from '../apps/desktop/src/main/usage-ledger';
import { collectPaidRuns, summarizeUsage, summarizeUsageFromRuns } from '../apps/desktop/src/main/usage-budget';

vi.setConfig({ testTimeout: 60_000 });

const NOW = new Date(2026, 9, 21, 12, 0, 0);
const budget = (overrides: Partial<UsageBudget> = {}): UsageBudget => ({ mode: 'warn', perRunUsd: 5, perConversationUsd: 0, dailyUsd: 0, monthlyUsd: 0, providerDailyUsd: {}, ...overrides });

function conversation(id: string, costs: Array<{ usd: number; provider?: string; model?: string; hoursAgo?: number }> = []): ConversationRecord {
  return {
    schemaVersion: 1, id, projectId: null, title: `Conversation ${id}`, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    archived: false, unread: false, activeAgent: 'codex', route: 'direct', autonomy: 'ask', turns: [],
    events: costs.map((cost, index) => ({
      schemaVersion: 1, id: `evt_${id}_${index}`, taskId: id, timestamp: new Date(NOW.getTime() - (cost.hoursAgo ?? 1) * 3_600_000).toISOString(),
      type: 'cost.update', amountUsd: cost.usd, provider: cost.provider ?? 'deepseek', model: cost.model ?? 'deepseek-chat',
    })),
  } as ConversationRecord;
}

interface Disk {
  /** Conversations by id, with a stamp that changes whenever the saved version does. */
  files: Map<string, { record: ConversationRecord; version: number }>;
  reads: string[];
  stampCalls: number;
  saved: string[];
  ledgerText: string | null;
  ports: UsageLedgerPorts;
  put(record: ConversationRecord): void;
  drop(id: string): void;
  stampOf(id: string): string;
}

function disk(initial: ConversationRecord[] = []): Disk {
  const d: Disk = {
    files: new Map(initial.map((record) => [record.id, { record, version: 1 }])),
    reads: [], stampCalls: 0, saved: [], ledgerText: null,
    put(record) { const existing = d.files.get(record.id); d.files.set(record.id, { record, version: (existing?.version ?? 0) + 1 }); },
    drop(id) { d.files.delete(id); },
    stampOf: (id) => `v${d.files.get(id)?.version}`,
    ports: {
      stamps: async () => { d.stampCalls += 1; return new Map([...d.files].map(([id, file]) => [id, `v${file.version}`])); },
      read: async (id) => { d.reads.push(id); return d.files.get(id)?.record ?? null; },
      load: async () => d.ledgerText,
      save: async (text) => { d.saved.push(text); d.ledgerText = text; },
    },
  };
  return d;
}

describe('the usage ledger', () => {
  it('builds itself by reading each conversation once, then reads none of them again', async () => {
    const d = disk([conversation('a', [{ usd: 1 }]), conversation('b', [{ usd: 2 }]), conversation('c')]);
    const ledger = new UsageLedger(d.ports, 0);
    expect((await ledger.runs()).map((run) => run.usd).sort()).toEqual([1, 2]);
    expect(d.reads.sort()).toEqual(['a', 'b', 'c']);
    await ledger.runs();
    await ledger.runs();
    expect(d.reads).toHaveLength(3);
  });

  it('gives exactly the figures that summing the conversations themselves gives', async () => {
    const conversations = [
      conversation('a', [{ usd: 0.5, hoursAgo: 1 }, { usd: 0.25, provider: 'openai', model: 'gpt-6-astra', hoursAgo: 30 }]),
      conversation('b', [{ usd: 2, hoursAgo: 2 }]),
      conversation('c'),
    ];
    const ledger = new UsageLedger(disk(conversations).ports, 0);
    const fromLedger = summarizeUsageFromRuns(await ledger.runs(), budget({ dailyUsd: 5 }), NOW, 'a');
    const fromConversations = summarizeUsage(conversations, budget({ dailyUsd: 5 }), NOW, 'a');
    expect({ ...fromLedger, generatedAt: '' }).toEqual({ ...fromConversations, generatedAt: '' });
  });

  it('reads again only the conversation whose file changed since the ledger last saw it', async () => {
    const d = disk([conversation('a', [{ usd: 1 }]), conversation('b', [{ usd: 2 }])]);
    const ledger = new UsageLedger(d.ports, 0);
    await ledger.runs();
    d.reads.length = 0;
    d.put(conversation('b', [{ usd: 2 }, { usd: 3 }]));
    expect((await ledger.runs()).map((run) => run.usd).sort()).toEqual([1, 2, 3]);
    expect(d.reads).toEqual(['b']);
  });

  it('forgets a conversation whose file is gone', async () => {
    const d = disk([conversation('a', [{ usd: 1 }]), conversation('b', [{ usd: 2 }])]);
    const ledger = new UsageLedger(d.ports, 0);
    await ledger.runs();
    d.drop('b');
    expect((await ledger.runs()).map((run) => run.usd)).toEqual([1]);
  });

  it('takes a saved conversation\'s runs from the record it is handed, without reading anything', async () => {
    const d = disk([conversation('a', [{ usd: 1 }])]);
    const ledger = new UsageLedger(d.ports, 0);
    await ledger.runs();
    d.reads.length = 0;
    const updated = conversation('a', [{ usd: 1 }, { usd: 4 }]);
    d.put(updated);
    ledger.noteSaved(updated, d.stampOf('a'));
    expect((await ledger.runs()).map((run) => run.usd).sort()).toEqual([1, 4]);
    expect(d.reads).toEqual([]);
  });

  it('lets a conversation be noted as saved before the ledger has loaded, and keeps that', async () => {
    const d = disk([conversation('a', [{ usd: 1 }])]);
    d.ledgerText = JSON.stringify({ version: 1, entries: { a: { stamp: 'v1', title: 'Old', runs: [] } } });
    const ledger = new UsageLedger(d.ports, 0);
    const fresh = conversation('a', [{ usd: 9 }]);
    d.put(fresh);
    ledger.noteSaved(fresh, d.stampOf('a'));
    expect((await ledger.runs()).map((run) => run.usd)).toEqual([9]);
  });

  it('forgets a removed conversation at once', async () => {
    const d = disk([conversation('a', [{ usd: 1 }]), conversation('b', [{ usd: 2 }])]);
    const ledger = new UsageLedger(d.ports, 0);
    await ledger.runs();
    ledger.noteRemoved('b');
    d.drop('b');
    expect((await ledger.runs()).map((run) => run.usd)).toEqual([1]);
  });

  it('is written out, and a fresh start from that file reads no conversation at all', async () => {
    const d = disk([conversation('a', [{ usd: 1 }]), conversation('b', [{ usd: 2 }])]);
    const first = new UsageLedger(d.ports, 0);
    await first.runs();
    await first.flush();
    expect(d.ledgerText).toContain('"version":1');

    d.reads.length = 0;
    const second = new UsageLedger(d.ports, 0);
    expect((await second.runs()).map((run) => run.usd).sort()).toEqual([1, 2]);
    expect(d.reads).toEqual([]);
  });

  it('builds again from the conversations when its file is damaged, and says nothing about it', async () => {
    const d = disk([conversation('a', [{ usd: 1 }])]);
    d.ledgerText = '{ this is not json';
    const ledger = new UsageLedger(d.ports, 0);
    expect((await ledger.runs()).map((run) => run.usd)).toEqual([1]);
    d.ledgerText = JSON.stringify({ version: 99, entries: {} });
    expect((await new UsageLedger(d.ports, 0).runs()).map((run) => run.usd)).toEqual([1]);
  });

  it('does the catch-up once for eight runs that ask together', async () => {
    const d = disk(Array.from({ length: 20 }, (_, index) => conversation(`c${index}`, [{ usd: 1 }])));
    const ledger = new UsageLedger(d.ports, 0);
    const results = await Promise.all(Array.from({ length: 8 }, () => ledger.runs()));
    expect(results.every((runs) => runs.length === 20)).toBe(true);
    expect(d.stampCalls).toBe(1);
    expect(d.reads).toHaveLength(20);
  });

  it('is not stopped by a conversation it cannot read', async () => {
    const d = disk([conversation('a', [{ usd: 1 }]), conversation('b', [{ usd: 2 }])]);
    const read = d.ports.read;
    d.ports.read = async (id) => { if (id === 'b') throw new Error('unreadable'); return read(id); };
    expect((await new UsageLedger(d.ports, 0).runs()).map((run) => run.usd)).toEqual([1]);
  });

  it('never fails because the ledger could not be written', async () => {
    const d = disk([conversation('a', [{ usd: 1 }])]);
    d.ports.save = async () => { throw new Error('disk full'); };
    const ledger = new UsageLedger(d.ports, 0);
    await ledger.runs();
    await expect(ledger.flush()).resolves.toBeUndefined();
  });
});

describe('the conversation store, followed by the ledger', () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
  });

  async function store(): Promise<{ directory: string; store: ConversationStore }> {
    const directory = await mkdtemp(path.join(tmpdir(), 'kai-ledger-'));
    directories.push(directory);
    return { directory, store: new ConversationStore(directory) };
  }

  it('tells an observer about every save and removal, with a stamp that changes when the file does', async () => {
    const { store: conversations } = await store();
    const seen: string[] = [];
    conversations.observe({ saved: (record, stamp) => seen.push(`saved ${record.id} ${stamp}`), removed: (id) => seen.push(`removed ${id}`) });
    await conversations.save(conversation('a', [{ usd: 1 }]));
    await conversations.save(conversation('a', [{ usd: 1 }, { usd: 2 }]));
    await conversations.remove('a');
    expect(seen).toHaveLength(3);
    expect(seen[0]).toMatch(/^saved a \d+:\d+$/);
    expect(seen[1]).not.toBe(seen[0]);
    expect(seen[2]).toBe('removed a');
  });

  it('gives the stamps of every saved conversation without reading any, matching the one it told the observer', async () => {
    const { directory, store: conversations } = await store();
    let told: string | null = null;
    conversations.observe({ saved: (_record, stamp) => { told = stamp; } });
    await conversations.save(conversation('a'));
    await conversations.save(conversation('b'));
    await writeFile(path.join(directory, 'not-a-conversation.txt'), 'x');
    const stamps = await conversations.stamps();
    expect([...stamps.keys()].sort()).toEqual(['a', 'b']);
    expect(stamps.get('b')).toBe(told);
    expect(await conversations.stampOf('missing')).toBeNull();
  });

  it('keeps a ledger exact through real saves without reading a conversation back', async () => {
    const { store: conversations } = await store();
    const ledger = new UsageLedger({
      stamps: () => conversations.stamps(),
      read: (id) => conversations.get(id),
      load: async () => null,
      save: async () => undefined,
    }, 0);
    conversations.observe({ saved: (record, stamp) => ledger.noteSaved(record, stamp), removed: (id) => ledger.noteRemoved(id) });
    const reads = vi.spyOn(conversations, 'get');
    await conversations.save(conversation('a', [{ usd: 1 }]));
    await conversations.save(conversation('b', [{ usd: 2 }]));
    expect((await ledger.runs()).map((run) => run.usd).sort()).toEqual([1, 2]);
    await conversations.save(conversation('a', [{ usd: 1 }, { usd: 5 }]));
    expect((await ledger.runs()).map((run) => run.usd).sort()).toEqual([1, 2, 5]);
    await conversations.remove('b');
    expect((await ledger.runs()).map((run) => run.usd).sort()).toEqual([1, 5]);
    expect(reads).not.toHaveBeenCalled();
    expect(collectPaidRuns(await conversations.list()).map((run) => run.usd).sort()).toEqual([1, 5]);
  });
});
