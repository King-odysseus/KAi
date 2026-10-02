import { access } from 'node:fs/promises';
import * as path from 'node:path';

/**
 * What a check can honestly confirm about what a run changed.
 *
 * A passing check is the sentence KAI closes on, and it has been a sentence it could not always stand behind: a task
 * about going through every page was closed by `npm run lint` passing, which says the files parse and nothing about
 * the pages. This does not invent checks — it says plainly which of them are only static, and which changed files
 * nothing in the project is named for, so the close reads as what it is.
 */

const CODE_FILE = /\.(?:tsx?|jsx?|mjs|cjs|vue|svelte|py|rb|go|rs|php|java|cs|kt|swift)$/i;
const TEST_FILE = /[._-](?:test|spec)\.[a-z]+$|(?:^|[\\/])(?:__tests__|tests?|e2e)[\\/][^\\/]+$/i;

/** A changed file a check could confirm — source code, not documentation, config, or a test itself. */
export function isSourceNeedingCoverage(file: string): boolean {
  const normalized = file.replace(/\\/g, '/');
  if (normalized.startsWith('.kai/')) return false;
  return CODE_FILE.test(normalized) && !TEST_FILE.test(normalized);
}

/** Which of the three kinds of check a command is, which decides what it can confirm. */
export function classifyCheck(command: string): 'tests' | 'static' | 'other' {
  // A test runner first: `npm run test` also reads like a script call, and it is the stronger claim of the two.
  if (/(?:^|\s)(?:vitest|jest|mocha|pytest|phpunit|rspec|playwright|cypress)\b/i.test(command)) return 'tests';
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|spec|e2e)\b/i.test(command)) return 'tests';
  if (/\b(?:cargo\s+test|go\s+test|dotnet\s+test|mvn\s+(?:test|verify)|gradle\s+test|python\s+-m\s+unittest)\b/i.test(command)) return 'tests';
  // Whole words only, so a person's own `check-pages.mjs` is not read as a static check KAI can speak for.
  if (/(?:^|\s)(?:lint|eslint|ruff|mypy|clippy|typecheck|tsc|vet)(?:\s|$)/i.test(command)) return 'static';
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?check(?:\s|$)/i.test(command)) return 'static';
  return 'other';
}

function nameFiles(files: readonly string[]): string {
  if (files.length <= 3) return files.join(', ');
  return `${files.slice(0, 3).join(', ')} and ${files.length - 3} more`;
}

/**
 * One sentence about what the passing check does not confirm, or null when there is nothing worth saying.
 *
 * Silent when a test runner covers every changed source file, and for a command KAI cannot classify — a check the
 * person wrote themselves is not KAI's to second-guess.
 */
export function coverageNote(
  command: string,
  changed: readonly string[],
  testsFor: (file: string) => boolean,
): string | null {
  const sources = changed.filter(isSourceNeedingCoverage);
  if (sources.length === 0) return null;
  const untested = sources.filter((file) => !testsFor(file));
  const kind = classifyCheck(command);

  if (kind === 'tests') {
    if (untested.length === 0) return null;
    return untested.length === sources.length
      ? `\`${command}\` is the project's test command, but no test is named for what this run changed (${nameFiles(untested)}), so passing does not confirm it.`
      : `\`${command}\` passed, but no test is named for ${nameFiles(untested)}, so it does not confirm that part of the change.`;
  }
  if (kind === 'static') {
    const base = `\`${command}\` is a static check: it confirms the files parse and type-check, not that the change works.`;
    return untested.length === 0 ? base : `${base} No test is named for ${nameFiles(untested)}.`;
  }
  return null;
}

/**
 * Whether a test file is named for this one, in the places a project usually keeps it. Deliberately a name check
 * rather than a search through every test's contents: it is cheap, it is honest about what it looked for, and the
 * sentence it produces says "named for" rather than claiming to know what any test covers.
 */
export async function testNamedFor(root: string, file: string): Promise<boolean> {
  const normalized = file.replace(/\\/g, '/');
  const directory = path.posix.dirname(normalized);
  const name = path.posix.basename(normalized);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  const candidates = [
    `${directory}/${stem}.test${extension}`,
    `${directory}/${stem}.spec${extension}`,
    `${directory}/__tests__/${stem}${extension}`,
    `${directory}/__tests__/${stem}.test${extension}`,
    `tests/${stem}${extension}`,
    `tests/${stem}.test${extension}`,
    `test/${stem}${extension}`,
    `${stem}.test${extension}`,
    `${stem}.spec${extension}`,
  ];
  for (const candidate of candidates) {
    // A candidate that is the file itself is not a test named for it.
    if (candidate === normalized) continue;
    const found = await access(path.join(root, candidate)).then(() => true, () => false);
    if (found) return true;
  }
  return false;
}
