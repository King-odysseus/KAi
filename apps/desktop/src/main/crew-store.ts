import { z } from 'zod';
import { crewRunSchema, type CrewRun } from '@kai/contracts';
import { AtomicJsonStore, type NodeFileSystem } from '@kai/runtime';

const collectionSchema = z.object({ schemaVersion: z.literal(1), runs: z.array(crewRunSchema).max(200) }).strict();
const KEEP = 100;

/** Crew runs on disk, newest first. A run that fails to load is skipped, never fatal: the rest still open. */
export class CrewRunStore {
  private readonly store: AtomicJsonStore<z.infer<typeof collectionSchema>>;
  private tail: Promise<void> = Promise.resolve();

  constructor(filePath: string, fileSystem: NodeFileSystem) {
    this.store = new AtomicJsonStore({ filePath, fileSystem, schema: collectionSchema, defaultValue: () => ({ schemaVersion: 1, runs: [] }) });
  }

  async list(projectId?: string): Promise<CrewRun[]> {
    await this.tail;
    const runs = await this.read();
    return (projectId ? runs.filter((run) => run.projectId === projectId) : runs).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async get(id: string): Promise<CrewRun | null> {
    return (await this.list()).find((run) => run.id === id) ?? null;
  }

  save(run: CrewRun): Promise<void> {
    return this.write(async () => {
      const parsed = crewRunSchema.parse(run);
      const others = (await this.read()).filter((item) => item.id !== parsed.id);
      const kept = [...others, parsed].sort((a, b) => a.startedAt.localeCompare(b.startedAt)).slice(-KEEP);
      await this.store.save({ schemaVersion: 1, runs: kept });
    });
  }

  private async read(): Promise<CrewRun[]> {
    return (await this.store.load().catch(() => ({ schemaVersion: 1 as const, runs: [] }))).runs;
  }

  private write(operation: () => Promise<void>): Promise<void> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
