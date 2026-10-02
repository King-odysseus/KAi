import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AtomicFileSystemPort } from '../packages/contracts/src';
import { AtomicJsonStore } from '../packages/runtime/src/atomic-json-store';

const schema = z.object({ count: z.number(), note: z.string() });
const TARGET = 'C:/data/record.json';

function failure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
}

/** A filesystem in a Map, so a rename can be made to fail the way Windows makes it fail. */
function memoryFileSystem() {
  const files = new Map<string, string>();
  // A plain function rather than a method, so a test can hold the working rename while replacing the port's.
  const renameInMemory = (from: string, to: string): Promise<void> => {
    const content = files.get(from);
    if (content === undefined) return Promise.reject(new Error(`ENOENT: no such file, rename '${from}'`));
    files.delete(from);
    files.set(to, content);
    return Promise.resolve();
  };
  const fileSystem: AtomicFileSystemPort = {
    mkdir: vi.fn(() => Promise.resolve()),
    readText: vi.fn((file: string) => Promise.resolve(files.get(file) ?? '')),
    writeText: vi.fn((file: string, content: string) => {
      files.set(file, content);
      return Promise.resolve();
    }),
    rename: vi.fn(renameInMemory),
    exists: vi.fn((file: string) => Promise.resolve(files.has(file))),
    remove: vi.fn((file: string) => {
      files.delete(file);
      return Promise.resolve();
    }),
    list: vi.fn(() => Promise.resolve([...files.keys()])),
  };
  return { fileSystem, files, renameInMemory };
}

function storeOn(fileSystem: AtomicFileSystemPort) {
  return new AtomicJsonStore({
    filePath: TARGET,
    fileSystem,
    schema,
    defaultValue: () => ({ count: 0, note: 'empty' }),
  });
}

describe('atomic json store', () => {
  it('writes the record when the first rename is refused by something holding the file open', async () => {
    const { fileSystem, files, renameInMemory } = memoryFileSystem();
    let refusals = 2;
    const attempt = vi.fn(async (from: string, to: string) => {
      if (refusals > 0) {
        refusals -= 1;
        throw failure('EPERM');
      }
      return renameInMemory(from, to);
    });
    fileSystem.rename = attempt;

    await storeOn(fileSystem).save({ count: 7, note: 'survived a scanner' });

    // The save landed rather than being reported as lost, and the temporary is not left behind.
    expect(JSON.parse(files.get(TARGET) ?? 'null')).toEqual({ count: 7, note: 'survived a scanner' });
    expect([...files.keys()].filter((file) => file.endsWith('.tmp'))).toEqual([]);
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('does not retry a failure that is not a transient refusal, and leaves no half-written record', async () => {
    const { fileSystem, files } = memoryFileSystem();
    const refuse = vi.fn(() => Promise.reject(failure('ENOSPC')));
    fileSystem.rename = refuse;

    await expect(storeOn(fileSystem).save({ count: 1, note: 'doomed' })).rejects.toThrow('ENOSPC');

    expect(refuse).toHaveBeenCalledTimes(1);
    expect(files.has(TARGET)).toBe(false);
    // The temporary is cleaned up: left there it reads exactly like the record that never landed.
    expect([...files.keys()].filter((file) => file.endsWith('.tmp'))).toEqual([]);
  });

  it('writes one file at a time, so two saves cannot race for the same record', async () => {
    const { fileSystem, files, renameInMemory } = memoryFileSystem();
    let inFlight = 0;
    let overlapped = false;
    fileSystem.rename = vi.fn(async (from: string, to: string) => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return renameInMemory(from, to);
    });

    const store = storeOn(fileSystem);
    await Promise.all([
      store.save({ count: 1, note: 'first' }),
      store.save({ count: 2, note: 'second' }),
      store.save({ count: 3, note: 'third' }),
    ]);

    expect(overlapped).toBe(false);
    // Queued in call order, so the last asked for is the one on disk.
    expect(JSON.parse(files.get(TARGET) ?? 'null')).toEqual({ count: 3, note: 'third' });
    expect([...files.keys()].filter((file) => file.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps saving after a save fails, instead of wedging the record', async () => {
    const { fileSystem, files, renameInMemory } = memoryFileSystem();
    let refuseNext = true;
    fileSystem.rename = vi.fn((from: string, to: string) => {
      if (refuseNext) {
        refuseNext = false;
        return Promise.reject(failure('ENOSPC'));
      }
      return renameInMemory(from, to);
    });

    const store = storeOn(fileSystem);
    await expect(store.save({ count: 1, note: 'lost' })).rejects.toThrow('ENOSPC');
    await store.save({ count: 2, note: 'kept' });

    expect(JSON.parse(files.get(TARGET) ?? 'null')).toEqual({ count: 2, note: 'kept' });
  });
});
