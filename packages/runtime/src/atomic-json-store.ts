import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
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
  /** The save in progress per file, and everything queued behind it. */
  private readonly saveQueues = new Map<string, Promise<void>>();

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
    // One write of a given record at a time. Two saves of the same file used to be left to the rename to sort
    // out, and on Windows the loser does not overwrite the winner, it fails outright.
    await this.enqueue(filePath, async () => {
      await fileSystem.mkdir(path.dirname(filePath));
      const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
      await fileSystem.writeText(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`);
      try {
        await renameOnto(fileSystem, temporaryPath, filePath);
      } catch (error) {
        // A rename that failed leaves the temporary behind looking exactly like the record it never became.
        await fileSystem.remove(temporaryPath).catch(() => undefined);
        throw error;
      }
    });
  }

  /** Runs `work` after whatever is already queued for the same file, and forgets the queue once it drains. */
  private async enqueue<R>(filePath: string, work: () => Promise<R>): Promise<R> {
    const previous = this.saveQueues.get(filePath) ?? Promise.resolve();
    // Chained with both handlers so one save failing does not cancel the saves queued behind it.
    const settled = previous.then(work, work);
    const tail = settled.then(() => undefined, () => undefined);
    this.saveQueues.set(filePath, tail);
    try {
      return await settled;
    } finally {
      // Only the last waiter clears the entry, so a save still queued is not orphaned.
      if (this.saveQueues.get(filePath) === tail) this.saveQueues.delete(filePath);
    }
  }
}

/**
 * Renames onto the target, retrying the refusals that only mean "not this instant".
 *
 * Windows will not replace a file that anything else has open, and it reports that as EPERM or EACCES rather
 * than waiting for it. Here those codes are usually not about permissions at all: a virus scanner reading the
 * file it just watched being written, a search indexer, a backup, a sync client. The write itself is sound and
 * the same call succeeds a moment later, so the first refusal is retried instead of losing the save.
 */
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);
const RENAME_ATTEMPTS = 6;
const RENAME_BACKOFF_MS = 20;

async function renameOnto(fileSystem: AtomicFileSystemPort, from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fileSystem.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (attempt >= RENAME_ATTEMPTS || !code || !RETRYABLE_RENAME_CODES.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * RENAME_BACKOFF_MS));
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
