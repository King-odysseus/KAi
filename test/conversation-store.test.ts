import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ConversationStore } from '../src/panel/conversation-store';
import type { WorkbenchEvent } from '../src/core/events';

describe('ConversationStore', () => {
  let dir: string;
  let store: ConversationStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-conv-store-'));
    store = new ConversationStore(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates a conversation with a title derived from the first prompt', () => {
    const conv = store.create('  Fix the proxy bug please  ');
    expect(conv.title).toBe('Fix the proxy bug please');
    expect(conv.events).toEqual([]);
    expect(conv.archived).toBe(false);
  });

  it('falls back to a default title for an empty prompt', () => {
    expect(store.create('   ').title).toBe('Untitled conversation');
  });

  it('saves and lists a conversation, newest first', async () => {
    const a = store.create('first');
    await store.save(a);
    await new Promise((r) => setTimeout(r, 5));
    const b = store.create('second');
    await store.save(b);

    const list = await store.list();
    expect(list.map((m) => m.id)).toEqual([b.id, a.id]);
  });

  it('round-trips a conversation with events through get()', async () => {
    const conv = store.create('hello');
    conv.events.push({ id: 'e1', type: 'text.delta', taskId: 't1', timestamp: '2026-01-01T00:00:00Z', agent: 'claude', channel: 'assistant', text: 'hi there' } as WorkbenchEvent);
    conv.agents = ['claude'];
    conv.costUsd = 0.01;
    await store.save(conv);

    const loaded = await store.get(conv.id);
    expect(loaded?.events).toHaveLength(1);
    expect(loaded?.agents).toEqual(['claude']);
    expect(loaded?.costUsd).toBe(0.01);
  });

  it('round-trips an active goal with the conversation', async () => {
    const conv = store.create('goal task');
    conv.goal = {
      id: 'goal_1', outcome: 'Ship it', constraints: '', verification: 'Tests pass',
      status: 'running', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', startedAt: '2026-01-01T00:00:00Z',
    };
    await store.save(conv);
    expect((await store.get(conv.id))?.goal?.outcome).toBe('Ship it');
  });

  it('round-trips native agent sessions and route context', async () => {
    const conv = store.create('resume this');
    conv.activeAgent = 'codex';
    conv.route = 'proxy';
    conv.autonomy = 'autoEdit';
    conv.agentSessions = {
      codex: { sessionId: 'thread-123', route: 'proxy', projectPath: '/repo' },
    };
    await store.save(conv);

    const loaded = await store.get(conv.id);
    expect(loaded?.activeAgent).toBe('codex');
    expect(loaded?.route).toBe('proxy');
    expect(loaded?.autonomy).toBe('autoEdit');
    expect(loaded?.agentSessions?.codex?.sessionId).toBe('thread-123');
  });

  it('returns undefined for a conversation that does not exist', async () => {
    expect(await store.get('nope')).toBeUndefined();
  });

  it('renames a conversation', async () => {
    const conv = store.create('original');
    await store.save(conv);
    await store.rename(conv.id, 'renamed');
    expect((await store.get(conv.id))?.title).toBe('renamed');
    expect((await store.list())[0].title).toBe('renamed');
  });

  it('archives and unarchives a conversation', async () => {
    const conv = store.create('archive me');
    await store.save(conv);
    await store.setArchived(conv.id, true);
    expect((await store.get(conv.id))?.archived).toBe(true);
    await store.setArchived(conv.id, false);
    expect((await store.get(conv.id))?.archived).toBe(false);
  });

  it('forks a conversation into a new one with copied events', async () => {
    const conv = store.create('original');
    conv.events.push({ id: 'e1', type: 'text.delta', taskId: 't1', timestamp: '2026-01-01T00:00:00Z', agent: 'claude', channel: 'assistant', text: 'hi' } as WorkbenchEvent);
    conv.agentSessions = { claude: { sessionId: 'session-1', route: 'direct' } };
    await store.save(conv);

    const forked = await store.fork(conv.id);
    expect(forked).toBeDefined();
    expect(forked?.id).not.toBe(conv.id);
    expect(forked?.title).toContain('copy');
    expect(forked?.events).toHaveLength(1);
    expect(forked?.agentSessions).toEqual({});

    const list = await store.list();
    expect(list).toHaveLength(2);
  });

  it('searches by title', async () => {
    const a = store.create('fix the proxy bug');
    await store.save(a);
    const b = store.create('write a poem');
    await store.save(b);

    const results = await store.search('proxy');
    expect(results.map((m) => m.id)).toEqual([a.id]);
  });

  it('searches by event text content, not just the title', async () => {
    const conv = store.create('generic title');
    conv.events.push({ id: 'e1', type: 'text.delta', taskId: 't1', timestamp: '2026-01-01T00:00:00Z', agent: 'claude', channel: 'assistant', text: 'the deepseek proxy fix worked' } as WorkbenchEvent);
    await store.save(conv);

    const results = await store.search('deepseek');
    expect(results.map((m) => m.id)).toEqual([conv.id]);
  });

  it('an empty search query returns everything', async () => {
    await store.save(store.create('a'));
    await store.save(store.create('b'));
    expect(await store.search('')).toHaveLength(2);
  });
});
