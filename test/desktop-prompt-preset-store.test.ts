import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeFileSystem } from '../packages/runtime/src';
import { PromptPresetStore } from '../apps/desktop/src/main/prompt-preset-store';

const directories: string[] = [];

async function store(existingDir?: string): Promise<{ dir: string; store: PromptPresetStore }> {
  const dir = existingDir ?? await fs.mkdtemp(path.join(os.tmpdir(), 'kai-presets-'));
  if (!existingDir) directories.push(dir);
  return { dir, store: new PromptPresetStore(path.join(dir, 'prompt-presets.json'), new NodeFileSystem()) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })));
});

describe('prompt presets', () => {
  it('starts empty', async () => {
    const { store: presets } = await store();
    expect(await presets.list()).toEqual([]);
  });

  it('saves a preset into a slot and lists it back in slot order', async () => {
    const { store: presets } = await store();
    await presets.save({ slot: 3, label: 'Write tests', text: 'Add unit tests for the file I have open.' });
    await presets.save({ slot: 1, label: 'Review', text: 'Review my latest changes for bugs.' });
    expect(await presets.list()).toEqual([
      { slot: 1, label: 'Review', text: 'Review my latest changes for bugs.' },
      { slot: 3, label: 'Write tests', text: 'Add unit tests for the file I have open.' },
    ]);
  });

  it('replaces whatever already occupied a slot', async () => {
    const { store: presets } = await store();
    await presets.save({ slot: 2, label: 'First', text: 'First prompt.' });
    await presets.save({ slot: 2, label: 'Second', text: 'Second prompt.' });
    expect(await presets.list()).toEqual([{ slot: 2, label: 'Second', text: 'Second prompt.' }]);
  });

  it('deletes a slot without disturbing the others', async () => {
    const { store: presets } = await store();
    await presets.save({ slot: 1, label: 'A', text: 'A' });
    await presets.save({ slot: 2, label: 'B', text: 'B' });
    await presets.delete(1);
    expect(await presets.list()).toEqual([{ slot: 2, label: 'B', text: 'B' }]);
  });

  it('survives a restart', async () => {
    const first = await store();
    await first.store.save({ slot: 5, label: 'Persisted', text: 'Still here.' });
    const second = await store(first.dir);
    expect(await second.store.list()).toEqual([{ slot: 5, label: 'Persisted', text: 'Still here.' }]);
  });
});
