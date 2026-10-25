import type { ComposerQueue, QueuedPrompt } from '@kai/contracts';
import { composerQueueStoreSchema } from '@kai/contracts';
import { AtomicJsonStore, type NodeFileSystem } from '@kai/runtime';

export class ComposerQueueStore {
  private readonly store: AtomicJsonStore<{ version: 1; queues: ComposerQueue }>;
  private mutation = Promise.resolve();

  constructor(private readonly path: string, private readonly fileSystem: NodeFileSystem) {
    this.store = new AtomicJsonStore({
      filePath: path,
      fileSystem,
      schema: composerQueueStoreSchema,
      defaultValue: () => ({ version: 1 as const, queues: {} }),
    });
  }

  async loadOrMigrate(legacy: ComposerQueue = {}): Promise<ComposerQueue> {
    return this.serial(async () => {
      const existed = await this.fileSystem.exists(this.path);
      const queues = existed ? (await this.store.load()).queues : legacy;
      const recovered = recoverSending(stripEphemeralImages(queues));
      await this.store.save({ version: 1, queues: recovered });
      return recovered;
    });
  }

  async add(item: QueuedPrompt, first = false): Promise<ComposerQueue> {
    const durableItem = stripEphemeralImages({ [item.conversationId]: [item] })[item.conversationId][0]!;
    return this.change((queues) => {
      const items = queues[durableItem.conversationId] ?? [];
      if (items.some((entry) => entry.id === durableItem.id)) return;
      queues[durableItem.conversationId] = first ? [durableItem, ...items] : [...items, durableItem];
    });
  }

  async claim(conversationId: string, id: string): Promise<{ claimed: boolean; queue: ComposerQueue }> {
    return this.serial(async () => {
      const { queues } = await this.store.load();
      const next = structuredClone(queues);
      const items = next[conversationId] ?? [];
      const item = items[0];
      const claimed = Boolean(item?.id === id && item.status === 'queued');
      if (claimed) items[0] = { ...item!, status: 'sending' };
      if (claimed) await this.store.save({ version: 1, queues: next });
      return { claimed, queue: next };
    });
  }

  async update(conversationId: string, id: string, action: 'remove' | 'retry' | 'promote' | 'sending' | 'accepted' | 'block', error?: string): Promise<ComposerQueue> {
    return this.change((queues) => {
      const items = queues[conversationId] ?? [];
      const item = items.find((entry) => entry.id === id);
      if (!item) return;
      if (action === 'remove' || action === 'accepted') {
        const remaining = items.filter((entry) => entry.id !== id);
        if (remaining.length) queues[conversationId] = remaining;
        else delete queues[conversationId];
        return;
      }
      const updated = { ...item };
      if (action === 'retry' || action === 'promote') { updated.status = 'queued'; delete updated.error; }
      if (action === 'sending') { updated.status = 'sending'; delete updated.error; }
      if (action === 'block') { updated.status = 'blocked'; updated.error = error ?? 'Delivery stopped. Retry when you are ready.'; }
      const remaining = items.filter((entry) => entry.id !== id);
      queues[conversationId] = action === 'promote' ? [updated, ...remaining] : items.map((entry) => entry.id === id ? updated : entry);
    });
  }

  async holdAll(error: string): Promise<ComposerQueue> {
    return this.change((queues) => {
      for (const [conversationId, items] of Object.entries(queues)) {
        queues[conversationId] = items.map((item) => item.status === 'blocked' ? item : { ...item, status: 'blocked', error });
      }
    });
  }

  async removeConversation(conversationId: string): Promise<ComposerQueue> {
    return this.change((queues) => { delete queues[conversationId]; });
  }

  private async change(mutator: (queues: ComposerQueue) => void): Promise<ComposerQueue> {
    return this.serial(async () => {
      const { queues } = await this.store.load();
      const next = structuredClone(queues);
      mutator(next);
      await this.store.save({ version: 1, queues: next });
      return next;
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(work, work);
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }
}

function recoverSending(queues: ComposerQueue): ComposerQueue {
  return Object.fromEntries(Object.entries(queues).map(([conversationId, items]) => [
    conversationId,
    items.map((item) => item.status === 'sending' ? { ...item, status: 'queued' as const } : item),
  ]));
}

function stripEphemeralImages(queues: ComposerQueue): ComposerQueue {
  return Object.fromEntries(Object.entries(queues).map(([conversationId, items]) => [conversationId, items.map((item) => ({
    ...item,
    options: {
      ...item.options,
      contextChips: item.options.contextChips?.map((chip) => chip.type === 'image' ? (({ dataUrl: _dataUrl, ...image }) => image)(chip) : chip),
    },
  }))]));
}
