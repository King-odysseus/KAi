import { z } from 'zod';
import { projectRecordV1Schema, type ProjectRecord } from '@kai/contracts';
import { AtomicJsonStore, type NodeFileSystem } from '@kai/runtime';

const projectCollectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    projects: z.array(projectRecordV1Schema),
  })
  .strict();

type ProjectCollection = z.infer<typeof projectCollectionSchema>;

export class ProjectStore {
  private readonly store: AtomicJsonStore<ProjectCollection>;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(filePath: string, fileSystem: NodeFileSystem) {
    this.store = new AtomicJsonStore({
      filePath,
      fileSystem,
      schema: projectCollectionSchema,
      defaultValue: () => ({ schemaVersion: 1, projects: [] }),
    });
  }

  async list(): Promise<ProjectRecord[]> {
    const collection = await this.store.load();
    return [...collection.projects].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
  }

  async upsert(project: ProjectRecord): Promise<void> {
    await this.serialiseWrite(async () => {
      const collection = await this.store.load();
      const index = collection.projects.findIndex((item) => item.id === project.id);
      if (index >= 0) collection.projects[index] = project;
      else collection.projects.push(project);
      await this.store.save(collection);
    });
  }

  async remove(id: string): Promise<void> {
    await this.serialiseWrite(async () => {
      const collection = await this.store.load();
      collection.projects = collection.projects.filter((project) => project.id !== id);
      await this.store.save(collection);
    });
  }

  private serialiseWrite(operation: () => Promise<void>): Promise<void> {
    const result = this.writeTail.then(operation);
    this.writeTail = result.then(() => undefined, () => undefined);
    return result;
  }
}
