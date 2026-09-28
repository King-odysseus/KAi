import { z } from 'zod';
import { interviewStateSchema, type InterviewState } from '@kai/contracts';
import { AtomicJsonStore, type NodeFileSystem } from '@kai/runtime';

const interviewCollectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    interviews: z.array(interviewStateSchema),
  })
  .strict();

type InterviewCollection = z.infer<typeof interviewCollectionSchema>;

/**
 * Where a half-answered interview lives. It is app-owned rather than a file in the project: the brief is the
 * artifact worth versioning in Git, and the working conversation is not. Keeping it out of `.kai/spec` also means
 * an interrupted interview never shows up as a change in the user's repository.
 */
export class InterviewStore {
  private readonly store: AtomicJsonStore<InterviewCollection>;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(filePath: string, fileSystem: NodeFileSystem) {
    this.store = new AtomicJsonStore({
      filePath,
      fileSystem,
      schema: interviewCollectionSchema,
      defaultValue: () => ({ schemaVersion: 1, interviews: [] }),
    });
  }

  async read(projectId: string): Promise<InterviewState | null> {
    const collection = await this.store.load();
    return collection.interviews.find((interview) => interview.projectId === projectId) ?? null;
  }

  async write(state: InterviewState): Promise<void> {
    await this.serialiseWrite(async () => {
      const collection = await this.store.load();
      const index = collection.interviews.findIndex((interview) => interview.projectId === state.projectId);
      if (index >= 0) collection.interviews[index] = state;
      else collection.interviews.push(state);
      await this.store.save(collection);
    });
  }

  async clear(projectId: string): Promise<void> {
    await this.serialiseWrite(async () => {
      const collection = await this.store.load();
      collection.interviews = collection.interviews.filter((interview) => interview.projectId !== projectId);
      await this.store.save(collection);
    });
  }

  private serialiseWrite(operation: () => Promise<void>): Promise<void> {
    const result = this.writeTail.then(operation);
    this.writeTail = result.then(() => undefined, () => undefined);
    return result;
  }
}
