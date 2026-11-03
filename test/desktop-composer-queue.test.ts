import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ConversationRecord, QueuedPrompt } from '@kai/contracts';
import { NodeFileSystem } from '../packages/runtime/src';
import { ComposerQueueStore } from '../apps/desktop/src/main/composer-queue-store';
import { QUEUE_KEY, loadComposerQueue, queuedPromptWasAccepted } from '../apps/desktop/src/renderer/src/components/composer-queue';

const item: QueuedPrompt = {
  id: 'queued-1', conversationId: 'conversation-a', text: 'Check the tests',
  options: { agent: 'codex', execution: 'cli', route: 'direct', autonomy: 'ask' },
  status: 'queued',
};

let directory: string | null = null;

async function makeStore(): Promise<ComposerQueueStore> {
  directory = await mkdtemp(path.join(tmpdir(), 'kai-composer-queue-'));
  return new ComposerQueueStore(path.join(directory, 'queue.json'), new NodeFileSystem());
}

afterEach(async () => {
  vi.unstubAllGlobals();
  if (directory) {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    directory = null;
  }
});

describe('conversation-owned composer queue', () => {
  it('recovers a sending item and keeps conversations separate', async () => {
    const store = await makeStore();
    const recovered = await store.loadOrMigrate({
      'conversation-a': [{ ...item, status: 'sending' }],
      'conversation-b': [{ ...item, id: 'queued-2', conversationId: 'conversation-b', text: 'Another task', status: 'blocked' }],
    });
    expect(recovered['conversation-a']).toMatchObject([{ id: 'queued-1', status: 'queued' }]);
    expect(recovered['conversation-b']).toMatchObject([{ id: 'queued-2', status: 'blocked' }]);
  });

  it('persists an image path without writing its data URL to disk', async () => {
    const store = await makeStore();
    await store.add({
      ...item,
      options: { ...item.options, contextChips: [{ type: 'image', name: 'shot.png', path: 'C:/images/shot.png', dataUrl: 'data:image/png;base64,AAAA' }] },
    });
    const loaded = JSON.stringify(await store.loadOrMigrate());
    expect(loaded).toContain('C:/images/shot.png');
    expect(loaded).not.toContain('base64');
  });

  it('claims only the first queued item and can promote another', async () => {
    const store = await makeStore();
    await store.add(item);
    await store.add({ ...item, id: 'queued-2', text: 'Second' });
    const claim = await store.claim('conversation-a', 'queued-1');
    expect(claim.claimed).toBe(true);
    expect(claim.queue['conversation-a']?.map((entry) => entry.status)).toEqual(['sending', 'queued']);
    const promoted = await store.update('conversation-a', 'queued-2', 'promote');
    expect(promoted['conversation-a']?.[0]).toMatchObject({ id: 'queued-2', status: 'queued' });
  });

  it('reads a legacy localStorage queue and normalizes a sending item', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    } });
    values.set(QUEUE_KEY, JSON.stringify({ 'conversation-a': [{ ...item, status: 'sending' }] }));
    expect(loadComposerQueue()['conversation-a']).toMatchObject([{ id: 'queued-1', status: 'queued' }]);
  });

  it('recognizes the committed user turn by ID even when prompts have identical text', () => {
    const conversation = { turns: [
      { id: 'turn-1', role: 'user', text: item.text, clientMessageId: 'queued-1' },
    ] } as ConversationRecord;
    expect(queuedPromptWasAccepted(conversation, 'queued-1')).toBe(true);
    expect(queuedPromptWasAccepted(conversation, 'queued-2')).toBe(false);
  });
});
