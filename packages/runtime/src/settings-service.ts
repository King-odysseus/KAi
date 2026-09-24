import { type AppSettings, type SettingsPort, appSettingsV1Schema, createDefaultSettings } from '@kai/contracts';
import { AtomicJsonStore } from './atomic-json-store';
import { type NodeFileSystem } from './node-file-system';
import { migrateSettings } from '@kai/contracts';

export class SettingsService implements SettingsPort {
  private readonly store: AtomicJsonStore<AppSettings>;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(filePath: string, fileSystem: NodeFileSystem) {
    this.store = new AtomicJsonStore({
      filePath,
      fileSystem,
      schema: appSettingsV1Schema,
      defaultValue: createDefaultSettings,
      migrate: migrateSettings,
    });
  }

  load(): Promise<AppSettings> {
    return this.store.load();
  }

  save(settings: AppSettings): Promise<void> {
    const write = this.writeTail.then(() => this.store.save(settings));
    this.writeTail = write.catch(() => undefined);
    return write;
  }

  /** Serializes read-modify-write updates so two windows cannot overwrite each other's settings change. */
  update(mutator: (current: AppSettings) => AppSettings | Promise<AppSettings>): Promise<AppSettings> {
    const write = this.writeTail.then(async () => {
      const current = await this.store.load();
      const next = await mutator(current);
      await this.store.save(next);
      return next;
    });
    this.writeTail = write.then(() => undefined, () => undefined);
    return write;
  }
}
