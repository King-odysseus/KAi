import { type AppSettings, type SettingsPort, appSettingsV1Schema, createDefaultSettings } from '@kai/contracts';
import { AtomicJsonStore } from './atomic-json-store';
import { type NodeFileSystem } from './node-file-system';
import { migrateSettings } from '@kai/contracts';

function migrateUnavailableCodexModel(model: string): string {
  if (model === 'gpt-6-sol') return 'gpt-5.6-sol';
  if (model === 'gpt-6-luna') return 'gpt-5.6-luna';
  return model;
}

function migrateCodexSettings(settings: AppSettings): { settings: AppSettings; changed: boolean } {
  let changed = false;
  const agentModels = { ...settings.agentModels };
  const model = agentModels.codex;
  if (model) {
    const migrated = migrateUnavailableCodexModel(model);
    if (migrated !== model) {
      agentModels.codex = migrated;
      changed = true;
    }
  }
  const codexTiers = settings.autoModel.tiers.codex;
  const tiers = codexTiers ? { ...codexTiers } : undefined;
  if (tiers) {
    for (const level of ['light', 'standard', 'heavy'] as const) {
      const previous = tiers[level];
      if (!previous) continue;
      const migrated = migrateUnavailableCodexModel(previous);
      if (migrated !== previous) {
        tiers[level] = migrated;
        changed = true;
      }
    }
  }
  return {
    settings: changed
      ? { ...settings, agentModels, autoModel: { ...settings.autoModel, tiers: { ...settings.autoModel.tiers, ...(tiers ? { codex: tiers } : {}) } } }
      : settings,
    changed,
  };
}

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
    return this.store.load().then(async (settings) => {
      const migrated = migrateCodexSettings(settings);
      if (migrated.changed) await this.store.save(migrated.settings);
      return migrated.settings;
    });
  }

  save(settings: AppSettings): Promise<void> {
    const write = this.writeTail.then(() => this.store.save(settings));
    this.writeTail = write.catch(() => undefined);
    return write;
  }

  /** Serializes read-modify-write updates so two windows cannot overwrite each other's settings change. */
  update(mutator: (current: AppSettings) => AppSettings | Promise<AppSettings>): Promise<AppSettings> {
    const write = this.writeTail.then(async () => {
      const loaded = await this.store.load();
      const migration = migrateCodexSettings(loaded);
      const current = migration.settings;
      if (migration.changed) await this.store.save(current);
      const next = await mutator(current);
      await this.store.save(next);
      return next;
    });
    this.writeTail = write.then(() => undefined, () => undefined);
    return write;
  }
}
