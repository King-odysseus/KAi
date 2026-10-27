import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { conversationRecordV1Schema } from '@kai/contracts';
import { ConversationStore } from '../packages/runtime/src/conversation-store';

describe('desktop conversation summaries', () => {
  let directory: string | null = null;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = null;
  });

  it('lists long histories from their headers and preserves the full record for opening', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'kai-summaries-'));
    const store = new ConversationStore(directory);
    const title = `${'a'.repeat(16_380)}🧠`; // crosses the header read boundary
    const conversation = conversationRecordV1Schema.parse({
      schemaVersion: 1,
      id: 'conv_large',
      projectId: null,
      title,
      createdAt: '2026-10-25T12:00:00.000Z',
      updatedAt: '2026-10-25T12:00:00.000Z',
      archived: false,
      unread: true,
      activeAgent: 'codex',
      route: 'direct',
      autonomy: 'ask',
      turns: [{ id: 'turn_1', createdAt: '2026-10-25T12:00:00.000Z', role: 'user', text: 'x'.repeat(1_000_000) }],
      events: [],
    });
    await store.save(conversation);
    const get = vi.spyOn(store, 'get');

    const summaries = await store.listSummaries();
    expect(get).not.toHaveBeenCalled();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ id: conversation.id, title, activeAgent: 'codex', __summary: true, turns: [], events: [] });

    get.mockRestore();
    expect((await store.get(conversation.id))?.turns[0]?.text).toHaveLength(1_000_000);
  });
});
