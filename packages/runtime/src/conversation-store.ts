import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import {
  conversationRecordV1Schema,
  type ConversationRecord,
  type ConversationStorePort,
} from '@kai/contracts';
import { AtomicJsonStore } from './atomic-json-store';
import { NodeFileSystem } from './node-file-system';

/** Conversation files read at the same time when listing them all. */
const LIST_BATCH = 16;
/** Conversation files looked at (not read) at the same time when taking their stamps. */
const STAMP_BATCH = 32;

/** Follows the conversations as they are saved and removed. */
export interface ConversationObserver {
  saved?(conversation: ConversationRecord, stamp: string | null): void;
  removed?(id: string): void;
}

function stampFor(info: { mtimeMs: number; size: number }): string {
  return `${Math.trunc(info.mtimeMs)}:${info.size}`;
}

export class ConversationStore implements ConversationStorePort {
  private readonly fileSystem: NodeFileSystem;
  private readonly writeTails = new Map<string, Promise<void>>();
  private readonly observers: ConversationObserver[] = [];

  constructor(private readonly directory: string, fileSystem: NodeFileSystem = new NodeFileSystem()) {
    this.fileSystem = fileSystem;
  }

  async list(): Promise<ConversationRecord[]> {
    const entries = (await this.fileSystem.list(this.directory).catch(() => [])).filter((entry) => entry.endsWith('.json'));
    // A few files at a time. Reading all of them at once held every file's raw text and its parsed copy in memory
    // together, which for a long history is several times the size of the result and was enough to run the app out.
    const conversations: Array<ConversationRecord | null> = [];
    for (let start = 0; start < entries.length; start += LIST_BATCH) {
      conversations.push(...await Promise.all(
        entries.slice(start, start + LIST_BATCH).map((entry) => this.get(path.basename(entry, '.json'))),
      ));
    }
    return conversations
      .filter((conversation): conversation is ConversationRecord => conversation !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<ConversationRecord | null> {
    const store = this.storeFor(id);
    try {
      return await store.load();
    } catch (error) {
      if (!(await this.fileSystem.exists(storePath(this.directory, id)))) return null;
      throw error;
    }
  }

  async save(conversation: ConversationRecord): Promise<void> {
    await this.serialiseWrite(conversation.id, async () => {
      await this.storeFor(conversation.id).save(conversation);
      // Told inside the ordered write, so a later save of the same conversation is always told after this one.
      if (this.observers.length > 0) {
        const stamp = await this.stampOf(conversation.id);
        for (const observer of this.observers) {
          try { observer.saved?.(conversation, stamp); } catch { /* an observer must never fail a save */ }
        }
      }
    });
  }

  async remove(id: string): Promise<void> {
    await this.serialiseWrite(id, async () => {
      const target = storePath(this.directory, id);
      if (await this.fileSystem.exists(target)) await this.fileSystem.remove(target);
      for (const observer of this.observers) {
        try { observer.removed?.(id); } catch { /* an observer must never fail a removal */ }
      }
    });
  }

  /** Called after every save and removal, so something derived from the conversations can follow them without reading them all. */
  observe(observer: ConversationObserver): void {
    this.observers.push(observer);
  }

  /**
   * A cheap fingerprint of one saved conversation: when its file was last written and how big it is. Null when there
   * is no such file. It changes whenever the file does, which is what lets a derived index notice a change it was not
   * told about, such as one made by an older build, without reading the file.
   */
  async stampOf(id: string): Promise<string | null> {
    try {
      return stampFor(await stat(storePath(this.directory, id)));
    } catch {
      return null;
    }
  }

  /** The stamp of every saved conversation, by id, from the file system alone: nothing is opened or parsed. */
  async stamps(): Promise<Map<string, string>> {
    const entries = (await this.fileSystem.list(this.directory).catch(() => [])).filter((entry) => entry.endsWith('.json'));
    const stamps = new Map<string, string>();
    for (let start = 0; start < entries.length; start += STAMP_BATCH) {
      await Promise.all(entries.slice(start, start + STAMP_BATCH).map(async (entry) => {
        try {
          stamps.set(path.basename(entry, '.json'), stampFor(await stat(path.join(this.directory, path.basename(entry)))));
        } catch {
          // Gone between the listing and now: it simply is not in the answer.
        }
      }));
    }
    return stamps;
  }

  private serialiseWrite(id: string, operation: () => Promise<void>): Promise<void> {
    // Writes for one conversation are ordered by call. Concurrent windows therefore have last-writer-wins
    // semantics instead of racing atomic file replacements and randomly dropping one update.
    const previous = this.writeTails.get(id) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.writeTails.set(id, tail);
    void tail.finally(() => {
      if (this.writeTails.get(id) === tail) this.writeTails.delete(id);
    });
    return result;
  }

  private storeFor(id: string): AtomicJsonStore<ConversationRecord> {
    return new AtomicJsonStore({
      filePath: storePath(this.directory, id),
      fileSystem: this.fileSystem,
      schema: conversationRecordV1Schema,
      defaultValue: () => {
        throw new Error(`Conversation ${id} does not exist.`);
      },
    });
  }
}

function storePath(directory: string, id: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid conversation id.');
  return path.join(directory, `${id}.json`);
}
