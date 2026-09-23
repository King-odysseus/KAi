import { z } from 'zod';
import {
  projectPreferencesV1Schema,
  type ProjectPreferences,
} from '@kai/contracts';
import { AtomicJsonStore, type NodeFileSystem } from '@kai/runtime';

const preferenceCollectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    preferences: z.array(projectPreferencesV1Schema),
  })
  .strict();

type PreferenceCollection = z.infer<typeof preferenceCollectionSchema>;

export class ProjectPreferenceStore {
  private readonly store: AtomicJsonStore<PreferenceCollection>;

  constructor(filePath: string, fileSystem: NodeFileSystem) {
    this.store = new AtomicJsonStore({
      filePath,
      fileSystem,
      schema: preferenceCollectionSchema,
      defaultValue: () => ({ schemaVersion: 1, preferences: [] }),
    });
  }

  async get(projectId: string): Promise<ProjectPreferences | null> {
    const collection = await this.store.load();
    return collection.preferences.find((preference) => preference.projectId === projectId) ?? null;
  }

  async upsert(preferences: ProjectPreferences): Promise<void> {
    const collection = await this.store.load();
    const index = collection.preferences.findIndex(
      (preference) => preference.projectId === preferences.projectId,
    );
    if (index >= 0) collection.preferences[index] = preferences;
    else collection.preferences.push(preferences);
    await this.store.save(collection);
  }

  async remove(projectId: string): Promise<void> {
    const collection = await this.store.load();
    collection.preferences = collection.preferences.filter(
      (preference) => preference.projectId !== projectId,
    );
    await this.store.save(collection);
  }
}
