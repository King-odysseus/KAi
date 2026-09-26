import { z } from 'zod';
import { teamRecordEntrySchema, type TeamRecordEntry, type WorkflowRun } from '@kai/contracts';
import { AtomicJsonStore, type NodeFileSystem } from '@kai/runtime';
import { recordsForRun } from './team-record';

const collectionSchema = z.object({ schemaVersion: z.literal(1), entries: z.array(teamRecordEntrySchema).max(5_000) }).strict();

export class TeamRecordStore {
  private readonly store: AtomicJsonStore<z.infer<typeof collectionSchema>>;
  private tail: Promise<void> = Promise.resolve();

  constructor(filePath: string, fileSystem: NodeFileSystem) {
    this.store = new AtomicJsonStore({ filePath, fileSystem, schema: collectionSchema, defaultValue: () => ({ schemaVersion: 1, entries: [] }) });
  }

  async list(): Promise<TeamRecordEntry[]> {
    await this.tail;
    return this.read();
  }

  record(run: WorkflowRun): Promise<void> {
    return this.upsert(recordsForRun(run));
  }

  upsert(entries: readonly TeamRecordEntry[]): Promise<void> {
    return this.write(async () => {
      const byId = new Map((await this.read()).map((entry) => [entry.id, entry]));
      for (const entry of entries) byId.set(entry.id, teamRecordEntrySchema.parse(entry));
      const recent = [...byId.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id)).slice(-5_000);
      await this.store.save({ schemaVersion: 1, entries: recent });
    });
  }

  clear(): Promise<void> {
    return this.write(() => this.store.save({ schemaVersion: 1, entries: [] }));
  }

  private async read(): Promise<TeamRecordEntry[]> {
    // A broken optional history must not prevent a project from opening or a team from working.
    return (await this.store.load().catch(() => ({ schemaVersion: 1 as const, entries: [] }))).entries;
  }

  private write(operation: () => Promise<void>): Promise<void> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
