import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * The one-stylesheet rule, as a check rather than a request.
 *
 * The rule in the briefing asks an agent to keep every style in the project's own stylesheet. An agent can ignore it,
 * and until now nothing noticed. This counts the stylesheets a card added, and is deliberately narrow: it only holds a
 * project that began with none or one, because a project with several stylesheets already has a convention of its own
 * (CSS modules, a theme folder) and adding a file there is not a fault. The rule says to follow that convention.
 */

/** Extensions counted as stylesheets. `.module.css` is caught by `.css`, and the preprocessor forms count too. */
const STYLESHEET = /\.(?:css|scss|sass|less)$/i;

/**
 * Folders that never hold the project's own styles: dependencies, build output, history. Walking them would count a
 * library's stylesheets and blame the card for something it did not write.
 */
const SKIPPED = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.svelte-kit', 'vendor', '.kai']);

/** How many files in a folder tree KAI walks before it stops, so a stray link or a huge folder cannot hang a run. */
const MAX_ENTRIES = 20_000;

export function isStylesheet(file: string): boolean {
  return STYLESHEET.test(file);
}

/**
 * Every stylesheet under `root`, as relative paths with forward slashes so two listings compare cleanly across runs.
 *
 * Read failures are swallowed: a folder that cannot be read is treated as holding nothing, which can only make the
 * check miss a violation, never invent one.
 */
export async function listStylesheets(root: string): Promise<string[]> {
  const found: string[] = [];
  let seen = 0;

  const walk = async (folder: string, relative: string): Promise<void> => {
    if (seen >= MAX_ENTRIES) return;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await fs.readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      seen += 1;
      if (seen >= MAX_ENTRIES) return;
      const name = entry.name;
      const next = relative ? `${relative}/${name}` : name;
      if (entry.isDirectory()) {
        if (!SKIPPED.has(name)) await walk(path.join(folder, name), next);
      } else if (entry.isFile() && isStylesheet(name)) {
        found.push(next);
      }
    }
  };

  await walk(root, '');
  return found.sort();
}

export interface StylesheetVerdict {
  /** False when the check does not apply: the project already used more than one stylesheet. */
  enforced: boolean;
  /** The stylesheets that were not there before the card. */
  added: string[];
  /** The stylesheets the project already had, which is where the new styles belong. */
  existing: string[];
  /** What to tell the agent and the log. Empty when the card kept to the rule. */
  message: string;
}

/**
 * Compares the stylesheets a project had before a card with the ones it has after.
 *
 * The rule allows exactly one stylesheet in a project that had none, and no new ones anywhere else. A project that
 * already had two or more is left alone: it has a convention of its own, and the rule tells the agent to follow it
 * rather than to collapse it. A card that changed nothing is never a fault.
 */
export function stylesheetVerdict(before: readonly string[], after: readonly string[]): StylesheetVerdict {
  const had = new Set(before);
  const added = after.filter((file) => !had.has(file)).sort();
  const enforced = before.length <= 1;
  if (!enforced || added.length === 0) return { enforced, added, existing: [...before], message: '' };

  const allowed = before.length === 0 ? 1 : 0;
  if (added.length <= allowed) return { enforced, added, existing: [...before], message: '' };

  const names = added.join(', ');
  const message = before.length === 0
    ? `The project had no stylesheet, so this card may create exactly one; it created ${added.length}: ${names}. Keep one file and move the rest of the styles into it.`
    : `The project keeps its styles in ${before[0]}, and this card added ${added.length} stylesheet${added.length === 1 ? '' : 's'}: ${names}. Move those styles into ${before[0]} and delete the new file${added.length === 1 ? '' : 's'}. The project keeps one stylesheet.`;
  return { enforced, added, existing: [...before], message };
}
