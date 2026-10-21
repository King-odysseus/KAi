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

export class ConversationStore implements ConversationStorePort {
  private readonly fileSystem: NodeFileSystem;
  private readonly writeTails = new Map<string, Promise<void>>();

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
    await this.serialiseWrite(conversation.id, () => this.storeFor(conversation.id).save(conversation));
  }

  async remove(id: string): Promise<void> {
    await this.serialiseWrite(id, async () => {
      const target = storePath(this.directory, id);
      if (await this.fileSystem.exists(target)) await this.fileSystem.remove(target);
    });
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
