import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  STUDIO_STYLE_REFERENCES_DIR,
  STUDIO_STYLE_REFERENCE_NOTES_PATH,
  type AppSettings,
  type StudioStyleReferences,
} from '@kai/contracts';
import type { ProviderConnection } from './learning-tutor';
import { resolveInside } from './project-files';
import { SPEC_ROOT, type SpecStore } from './spec-store';

/**
 * Reference images for the look of a project. They live under `.kai/spec/design/references`, next to the tokens, so
 * an agent that opens the project sees them, and a model that can read images turns them into a written style
 * description (`design/style-reference.md`) that the style guide and the tokens are then written from.
 */

export const STYLE_REFERENCE_MAX_BYTES = 4_000_000;
export const STYLE_REFERENCE_MAX_FILES = 4;
/** Images larger than this are listed without a preview, so opening the Design tab stays light. */
const PREVIEW_MAX_BYTES = 1_500_000;

const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const NAMES = { feature: 'style reference', card: 'Project Studio' };

export interface StyleReferencePorts {
  settings(): Promise<AppSettings>;
  projectRoot(projectId: string): Promise<string>;
  spec: SpecStore;
  vision: {
    describeImages(
      connection: ProviderConnection,
      names: { feature: string; card: string },
      prompt: { system: string; user: string },
      images: ReadonlyArray<{ mediaType: string; base64: string }>,
    ): Promise<string>;
  };
}

/** A file name safe to keep on disk: no folders, no odd characters, and an image extension. */
export function safeReferenceName(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/')).replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^\.+/, '').slice(-80);
  const extension = path.extname(base).toLowerCase();
  if (!MEDIA_TYPES[extension]) throw new Error('Use a PNG, JPEG or WebP image.');
  return base;
}

export class StudioStyleReferenceStore {
  constructor(private readonly ports: StyleReferencePorts) {}

  async list(projectId: string): Promise<StudioStyleReferences> {
    const root = await this.ports.projectRoot(projectId);
    const directory = await this.directory(root);
    let names: string[] = [];
    try {
      names = (await fs.readdir(directory)).filter((name) => MEDIA_TYPES[path.extname(name).toLowerCase()]).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const images = await Promise.all(names.map(async (name) => {
      const file = path.join(directory, name);
      const size = (await fs.stat(file)).size;
      const preview = size <= PREVIEW_MAX_BYTES
        ? `data:${MEDIA_TYPES[path.extname(name).toLowerCase()]};base64,${(await fs.readFile(file)).toString('base64')}`
        : null;
      return { name, size, preview };
    }));
    return { images, notes: await this.ports.spec.read(root, STUDIO_STYLE_REFERENCE_NOTES_PATH) };
  }

  async add(projectId: string, name: string, base64: string): Promise<StudioStyleReferences> {
    const fileName = safeReferenceName(name);
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length === 0) throw new Error('That image is empty.');
    if (bytes.length > STYLE_REFERENCE_MAX_BYTES) throw new Error(`Use an image under ${Math.round(STYLE_REFERENCE_MAX_BYTES / 1_000_000)} MB.`);
    const root = await this.ports.projectRoot(projectId);
    const directory = await this.directory(root);
    const existing = (await this.list(projectId)).images.map((image) => image.name);
    if (!existing.includes(fileName) && existing.length >= STYLE_REFERENCE_MAX_FILES) {
      throw new Error(`Keep at most ${STYLE_REFERENCE_MAX_FILES} reference images. Remove one first.`);
    }
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, fileName), bytes);
    return this.list(projectId);
  }

  async remove(projectId: string, name: string): Promise<StudioStyleReferences> {
    const fileName = safeReferenceName(name);
    const directory = await this.directory(await this.ports.projectRoot(projectId));
    await fs.rm(path.join(directory, fileName), { force: true });
    return this.list(projectId);
  }

  /** Has a model that can read images describe the references, and keeps the description for the style guide. */
  async describe(projectId: string): Promise<StudioStyleReferences> {
    const root = await this.ports.projectRoot(projectId);
    const directory = await this.directory(root);
    const { images } = await this.list(projectId);
    if (images.length === 0) throw new Error('Add at least one reference image first.');
    const settings = await this.ports.settings();
    const loaded = await Promise.all(images.map(async (image) => ({
      mediaType: MEDIA_TYPES[path.extname(image.name).toLowerCase()]!,
      base64: (await fs.readFile(path.join(directory, image.name))).toString('base64'),
    })));
    const text = await this.ports.vision.describeImages(
      settings.promptGuide,
      NAMES,
      {
        system: 'You describe the visual style of reference images for a software project, so a designer can write a style guide from your description. Be concrete and brief: no more than 250 words of markdown bullets.',
        user: `Describe the style the ${loaded.length === 1 ? 'image shows' : `${loaded.length} images share`}: the colour palette (give approximate hex values and which are background, text and accent), the feel of the type, how dense or airy the layout is, the shape language (corners, borders, shadows), the imagery and icon style, and the mood. Finish with two short lists: what to copy, and what to avoid.`,
      },
      loaded,
    );
    if (!text.trim()) throw new Error('The model returned no description. Try again, or describe the style in words in the brief.');
    await this.ports.spec.write(root, STUDIO_STYLE_REFERENCE_NOTES_PATH, `# Style reference\n\n_Described from: ${images.map((image) => image.name).join(', ')}._\n\n${text.trim()}\n`);
    return this.list(projectId);
  }

  private async directory(root: string): Promise<string> {
    return resolveInside(root, path.join(SPEC_ROOT, STUDIO_STYLE_REFERENCES_DIR));
  }
}
