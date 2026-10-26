import { promptPresetStoreSchema, type PromptPreset, type PromptPresetList } from '@kai/contracts';
import { AtomicJsonStore, type NodeFileSystem } from '@kai/runtime';

/** The person's saved prompts, kept in up to nine numbered slots so they can be reached for by number, like a hotbar. */
export class PromptPresetStore {
  private readonly store: AtomicJsonStore<{ version: 1; presets: PromptPresetList }>;
  private mutation = Promise.resolve();

  constructor(filePath: string, fileSystem: NodeFileSystem) {
    this.store = new AtomicJsonStore({
      filePath,
      fileSystem,
      schema: promptPresetStoreSchema,
      defaultValue: () => ({ version: 1 as const, presets: [] }),
    });
  }

  async list(): Promise<PromptPresetList> {
    const { presets } = await this.store.load();
    return [...presets].sort((a, b) => a.slot - b.slot);
  }

  async save(preset: PromptPreset): Promise<PromptPresetList> {
    return this.serial(async () => {
      const { presets } = await this.store.load();
      const next = [...presets.filter((entry) => entry.slot !== preset.slot), preset].sort((a, b) => a.slot - b.slot);
      await this.store.save({ version: 1, presets: next });
      return next;
    });
  }

  async delete(slot: number): Promise<PromptPresetList> {
    return this.serial(async () => {
      const { presets } = await this.store.load();
      const next = presets.filter((entry) => entry.slot !== slot);
      await this.store.save({ version: 1, presets: next });
      return next;
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(work, work);
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }
}
