import { z } from 'zod';
import { AtomicJsonStore, type NodeFileSystem } from '@kai/runtime';

const blockerSchema = z.object({
  key: z.string().min(1).max(120),
  note: z.string().min(1).max(800),
  learnedAt: z.string().min(1),
}).strict();

const collectionSchema = z.object({
  schemaVersion: z.literal(1),
  projects: z.record(z.array(blockerSchema).max(30)),
}).strict();

type Collection = z.infer<typeof collectionSchema>;

/**
 * What crews have learned about getting past a project's blockers (a commit hook that rejects a word, say), kept per
 * project so the next crew on it starts knowing instead of meeting the same wall as if it were the first.
 */
export class CrewBlockerStore {
  private readonly store: AtomicJsonStore<Collection>;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(filePath: string, fileSystem: NodeFileSystem, private readonly now: () => string = () => new Date().toISOString()) {
    this.store = new AtomicJsonStore({
      filePath,
      fileSystem,
      schema: collectionSchema,
      defaultValue: () => ({ schemaVersion: 1, projects: {} }),
    });
  }

  async load(projectId: string): Promise<Array<{ key: string; note: string }>> {
    const collection = await this.store.load();
    return (collection.projects[projectId] ?? []).map(({ key, note }) => ({ key, note }));
  }

  async save(projectId: string, item: { key: string; note: string }): Promise<void> {
    const run = async (): Promise<void> => {
      const collection = await this.store.load();
      const known = collection.projects[projectId] ?? [];
      if (known.some((entry) => entry.key === item.key)) return;
      collection.projects[projectId] = [...known, { key: item.key, note: item.note.slice(0, 800), learnedAt: this.now() }].slice(-30);
      await this.store.save(collection);
    };
    const result = this.writeTail.then(run);
    this.writeTail = result.then(() => undefined, () => undefined);
    return result;
  }
}
