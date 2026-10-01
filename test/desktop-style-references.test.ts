import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultSettings, STUDIO_STYLE_REFERENCE_NOTES_PATH } from '../packages/contracts/src';
import { SpecStore } from '../apps/desktop/src/main/spec-store';
import { safeReferenceName, StudioStyleReferenceStore, type StyleReferencePorts } from '../apps/desktop/src/main/style-references';

let root = '';
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-style-refs-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64').toString('base64');

function store(over: Partial<StyleReferencePorts['vision']> = {}): { store: StudioStyleReferenceStore; seen: Array<{ count: number; user: string }> } {
  const seen: Array<{ count: number; user: string }> = [];
  const settings = createDefaultSettings();
  const instance = new StudioStyleReferenceStore({
    settings: async () => settings,
    projectRoot: async () => root,
    spec: new SpecStore(),
    vision: {
      describeImages: async (_connection, _names, prompt, images) => {
        seen.push({ count: images.length, user: prompt.user });
        return '- Palette: deep navy background (#0b1220), mint accent (#3ee6b6)\n- Airy layout';
      },
      ...over,
    },
  });
  return { store: instance, seen };
}

describe('style reference images', () => {
  it('keeps only safe names with an image extension', () => {
    expect(safeReferenceName('../../My Mood Board.PNG')).toBe('My-Mood-Board.PNG');
    expect(() => safeReferenceName('notes.txt')).toThrow(/PNG, JPEG or WebP/);
  });

  it('stores an image under the spec folder, lists it with a preview, and removes it', async () => {
    const { store: refs } = store();
    const added = await refs.add('p1', 'mood.png', PNG);
    expect(added.images.map((image) => image.name)).toEqual(['mood.png']);
    expect(added.images[0]?.preview).toMatch(/^data:image\/png;base64,/);
    expect(fs.existsSync(path.join(root, '.kai', 'spec', 'design', 'references', 'mood.png'))).toBe(true);
    const removed = await refs.remove('p1', 'mood.png');
    expect(removed.images).toEqual([]);
  });

  it('refuses a fifth image, and an empty one', async () => {
    const { store: refs } = store();
    for (const name of ['a.png', 'b.png', 'c.png', 'd.png']) await refs.add('p1', name, PNG);
    await expect(refs.add('p1', 'e.png', PNG)).rejects.toThrow(/at most 4/);
    await expect(refs.add('p1', 'a.png', '')).rejects.toThrow();
    // Replacing one that exists is fine at the limit.
    await expect(refs.add('p1', 'a.png', PNG)).resolves.toBeTruthy();
  });

  it('has the model describe the images and keeps the description for the style guide', async () => {
    const { store: refs, seen } = store();
    await refs.add('p1', 'mood.png', PNG);
    await refs.add('p1', 'dark.webp', PNG);
    const described = await refs.describe('p1');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.count).toBe(2);
    expect(described.notes).toContain('mint accent');
    expect(await new SpecStore().read(root, STUDIO_STYLE_REFERENCE_NOTES_PATH)).toContain('Described from: dark.webp, mood.png');
  });

  it('says what to do when there is nothing to describe, or the model returns nothing', async () => {
    const { store: empty } = store();
    await expect(empty.describe('p1')).rejects.toThrow(/Add at least one reference image/);
    const { store: silent } = store({ describeImages: async () => '  ' });
    await silent.add('p1', 'mood.png', PNG);
    await expect(silent.describe('p1')).rejects.toThrow(/returned no description/);
  });
});
