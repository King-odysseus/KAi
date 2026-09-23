import { type AppSettings, type SettingsPort, appSettingsV1Schema, createDefaultSettings } from '@kai/contracts';
import { AtomicJsonStore } from './atomic-json-store';
import { type NodeFileSystem } from './node-file-system';
import { migrateSettings } from '@kai/contracts';

export class SettingsService implements SettingsPort {
  private readonly store: AtomicJsonStore<AppSettings>;

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
    return this.store.save(settings);
  }
}
