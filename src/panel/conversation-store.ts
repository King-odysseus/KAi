import * as fs from 'fs/promises';
import * as path from 'path';
import type { WorkbenchEvent } from '../core/events';
import type { AgentId } from '../core/types';
import type { WorkbenchGoal } from '../core/goal';

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  agents: AgentId[];
  costUsd: number;
  archived: boolean;
  /** Set when a run finished while no webview was visible — cleared once
   * the conversation is opened. */
  unread: boolean;
}

export interface Conversation extends ConversationMeta {
  events: WorkbenchEvent[];
  /** Goal state survives reopening the conversation and is cleared only when
   * the user clears it or starts a new chat. */
  goal?: WorkbenchGoal | null;
}

/**
 * Persists chat transcripts as one JSON file per conversation under
 * `<storageDir>/conversations/`, plus an `index.json` for fast listing
 * without loading every transcript. Simple JSON-per-file rather than a
 * database — conversation counts here are small (dozens to low hundreds),
 * not the scale that would need one.
 */
export class ConversationStore {
  private readonly dir: string;
  private readonly indexPath: string;
  private index: ConversationMeta[] | null = null;

  constructor(storageDir: string) {
    this.dir = path.join(storageDir, 'conversations');
    this.indexPath = path.join(this.dir, 'index.json');
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  private async loadIndex(): Promise<ConversationMeta[]> {
    if (this.index) return this.index;
    try {
      const raw = await fs.readFile(this.indexPath, 'utf8');
      this.index = JSON.parse(raw) as ConversationMeta[];
    } catch {
      this.index = [];
    }
    return this.index;
  }

  private async saveIndex(): Promise<void> {
    await this.ensureDir();
    await fs.writeFile(this.indexPath, JSON.stringify(this.index ?? [], null, 2), 'utf8');
  }

  private conversationPath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  async list(): Promise<ConversationMeta[]> {
    const index = await this.loadIndex();
    return [...index].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<Conversation | undefined> {
    try {
      const raw = await fs.readFile(this.conversationPath(id), 'utf8');
      return JSON.parse(raw) as Conversation;
    } catch {
      return undefined;
    }
  }

  create(firstPromptText: string): Conversation {
    const now = new Date().toISOString();
    return {
      id: `conv_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      title: firstPromptText.trim().slice(0, 60) || 'Untitled conversation',
      createdAt: now,
      updatedAt: now,
      agents: [],
      costUsd: 0,
      archived: false,
      unread: false,
      goal: null,
      events: [],
    };
  }

  /** Persists a conversation and updates the index. Called after each event
   * — writes are small JSON files, cheap enough for one per turn-ish event. */
  async save(conversation: Conversation): Promise<void> {
    await this.ensureDir();
    await fs.writeFile(this.conversationPath(conversation.id), JSON.stringify(conversation), 'utf8');

    const index = await this.loadIndex();
    const meta: ConversationMeta = {
      id: conversation.id, title: conversation.title, createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt, agents: conversation.agents, costUsd: conversation.costUsd,
      archived: conversation.archived, unread: conversation.unread,
    };
    const i = index.findIndex((m) => m.id === conversation.id);
    if (i >= 0) index[i] = meta; else index.push(meta);
    await this.saveIndex();
  }

  async rename(id: string, title: string): Promise<void> {
    const conversation = await this.get(id);
    if (!conversation) return;
    conversation.title = title.trim() || conversation.title;
    conversation.updatedAt = new Date().toISOString();
    await this.save(conversation);
  }

  async setArchived(id: string, archived: boolean): Promise<void> {
    const conversation = await this.get(id);
    if (!conversation) return;
    conversation.archived = archived;
    await this.save(conversation);
  }

  async setUnread(id: string, unread: boolean): Promise<void> {
    const conversation = await this.get(id);
    if (!conversation) return;
    conversation.unread = unread;
    await this.save(conversation);
  }

  /** Copies a conversation's transcript into a new one — "fork". */
  async fork(id: string): Promise<Conversation | undefined> {
    const source = await this.get(id);
    if (!source) return undefined;
    const now = new Date().toISOString();
    const forked: Conversation = {
      ...source,
      id: `conv_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      title: `${source.title} (copy)`,
      createdAt: now,
      updatedAt: now,
      unread: false,
    };
    await this.save(forked);
    return forked;
  }

  async search(query: string): Promise<ConversationMeta[]> {
    const q = query.trim().toLowerCase();
    const all = await this.list();
    if (!q) return all;
    const results: ConversationMeta[] = [];
    for (const meta of all) {
      if (meta.title.toLowerCase().includes(q)) { results.push(meta); continue; }
      const full = await this.get(meta.id);
      if (full && full.events.some((e) => eventMatchesQuery(e, q))) results.push(meta);
    }
    return results;
  }
}

function eventMatchesQuery(event: WorkbenchEvent, query: string): boolean {
  if (event.type === 'text.delta') return event.text.toLowerCase().includes(query);
  if (event.type === 'tool.call') return event.name.toLowerCase().includes(query);
  return false;
}
