import * as path from 'node:path';
import type { ZodType, ZodTypeDef } from 'zod';
import type { AtomicFileSystemPort } from '@kai/contracts';

export interface JsonStoreOptions<T> {
  filePath: string;
  fileSystem: AtomicFileSystemPort;
  schema: ZodType<T, ZodTypeDef, unknown>;
  defaultValue: () => T;
  migrate?: (value: unknown) => T;
}

export class AtomicJsonStore<T> {
  constructor(private readonly options: JsonStoreOptions<T>) {}

  async load(): Promise<T> {
    const { filePath, fileSystem, schema, defaultValue, migrate } = this.options;
    if (!(await fileSystem.exists(filePath))) return defaultValue();

    let parsed: unknown;
    try {
      parsed = JSON.parse(await fileSystem.readText(filePath));
    } catch (error) {
      throw new Error(`Could not parse ${path.basename(filePath)}: ${messageOf(error)}`);
    }

    const direct = schema.safeParse(parsed);
    if (direct.success) return direct.data;
    if (migrate) return schema.parse(migrate(parsed));
    throw new Error(`Persisted data at ${filePath} does not match schema version 1.`);
  }

  async save(value: T): Promise<void> {
    const { filePath, fileSystem } = this.options;
    const validated = this.options.schema.parse(value);
    await fileSystem.mkdir(path.dirname(filePath));
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fileSystem.writeText(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`);
    await fileSystem.rename(temporaryPath, filePath);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
