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

/**
 * A folder's identity for comparison. Windows does not distinguish case or slash direction in a path, so neither
 * should this: \ZuriIAI and \zuriAI are one folder, and a duplicate that only differs that way is the one most
 * worth catching.
 */
export function pathKey(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

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

  /**
   * Adds a project, or updates the one already recorded for that folder.
   *
   * The match is on the folder as well as the id. It used to be the id alone, and since opening a folder mints a fresh
   * id, opening the same folder twice added it twice — three entries for one folder, which is how a person ends up
   * unsure which of three "ZuriIAI" they are looking at. Worse, anything keyed to a project id then points at a
   * different entry than the one in front of them: a Studio plan linked to one of them stops looking connected.
   *
   * Comparison is case-insensitive and separator-insensitive because Windows treats \ZuriIAI and \zuriAI as the same
   * folder, so a textual comparison would miss the duplicate it most needs to catch.
   */
  async upsert(project: ProjectRecord): Promise<ProjectRecord> {
    return this.serialiseWrite(async () => {
      const collection = await this.store.load();
      const key = pathKey(project.path);
      const index = collection.projects.findIndex((item) => item.id === project.id || pathKey(item.path) === key);
      // The existing id wins: preferences, Studio links and conversations are keyed to it, and changing it would
      // orphan every one of them.
      //
      // The record that survived is returned, and callers must use it rather than the one they passed in. A caller
      // that keeps its own id would go on to key something — a Studio plan's link, for instance — to an id this store
      // has just discarded, which is worse than the duplicate it was trying to avoid.
      const stored: ProjectRecord = index >= 0
        ? { ...project, id: collection.projects[index]!.id }
        : project;
      if (index >= 0) collection.projects[index] = stored;
      else collection.projects.push(stored);
      await this.store.save(collection);
      return stored;
    });
  }

  async remove(id: string): Promise<void> {
    await this.serialiseWrite(async () => {
      const collection = await this.store.load();
      collection.projects = collection.projects.filter((project) => project.id !== id);
      await this.store.save(collection);
    });
  }

  /**
   * Forgets every project in the list. The folders themselves are untouched — this is the list KAI keeps, and a
   * folder that is opened again comes back. It exists because the list collects what a person no longer wants:
   * folders renamed since, a duplicate of the same folder under another spelling, projects finished with.
   */
  async clear(): Promise<void> {
    await this.serialiseWrite(async () => {
      await this.store.save({ schemaVersion: 1, projects: [] });
    });
  }

  /** Runs one write after the last, whatever it returns, so two windows cannot interleave a read and a write. */
  private serialiseWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(operation);
    this.writeTail = result.then(() => undefined, () => undefined);
    return result;
  }
}
