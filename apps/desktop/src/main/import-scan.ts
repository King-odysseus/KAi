import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ImportFinding, ImportReport } from '@kai/contracts';
import { detect, snapshotProject, type ProjectSnapshot } from './conventions-scan';
import { projectScripts } from './project-knowledge';

/**
 * Reads an existing repository and says what it is, what it lacks, and what a first backlog could be. Pure rules over
 * the folder: no model call, nothing written. Each finding carries the card that would fix it, so picking findings and
 * adding cards are the same act.
 */

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript',
  '.py': 'Python', '.rs': 'Rust', '.go': 'Go', '.rb': 'Ruby', '.php': 'PHP', '.java': 'Java', '.kt': 'Kotlin',
  '.cs': 'C#', '.swift': 'Swift', '.vue': 'Vue', '.svelte': 'Svelte', '.css': 'CSS', '.html': 'HTML',
};
const SOURCE_EXTENSIONS = new Set(Object.keys(LANGUAGE_BY_EXTENSION).filter((ext) => !['.css', '.html'].includes(ext)));
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'poetry.lock', 'Pipfile.lock', 'Cargo.lock', 'go.sum', 'composer.lock', 'Gemfile.lock'];
const MANIFEST_FILES = ['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'composer.json', 'Gemfile'];
/** A source file this big is hard to review or change safely. */
const LARGE_FILE_BYTES = 80_000;
const MAX_STATS = 600;
const SNAPSHOT_FILE_LIMIT = 1_500;

const isTestPath = (file: string): boolean => {
  const lower = file.toLowerCase();
  return /(^|\/)(test|tests|__tests__|spec)\//.test(lower) || /\.(test|spec)\.[a-z0-9]+$/.test(lower) || /(^|\/)test_[^/]+\.py$/.test(lower);
};

const baseName = (file: string): string => file.slice(file.lastIndexOf('/') + 1);

function languagesOf(files: readonly string[]): Array<{ name: string; files: number }> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const name = LANGUAGE_BY_EXTENSION[path.extname(file).toLowerCase()];
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, files: count })).sort((a, b) => b.files - a.files).slice(0, 6);
}

/** The command that best proves work: the project's own test script, else its typecheck, else a build. */
export function suggestCheck(scripts: readonly string[]): string | null {
  for (const preferred of ['npm run test', 'npm run typecheck', 'npm run build', 'npm run lint']) {
    if (scripts.includes(preferred)) return preferred;
  }
  return null;
}

interface Facts {
  snapshot: ProjectSnapshot;
  scripts: string[];
  gitAvailable: boolean;
  gitignore: string;
  largeFiles: string[];
  testFileCount: number;
  sourceFileCount: number;
}

/** Turns the facts into findings. Exported so the rules can be tested without a folder. */
export function findingsFor(facts: Facts): ImportFinding[] {
  const files = facts.snapshot.files;
  const has = (pattern: RegExp): boolean => files.some((file) => pattern.test(file));
  const out: ImportFinding[] = [];
  const add = (finding: ImportFinding): void => { out.push(finding); };
  const hasManifest = files.some((file) => MANIFEST_FILES.includes(file));

  if (facts.sourceFileCount > 0 && facts.testFileCount === 0) {
    add({
      id: 'no-tests', severity: 'high', title: 'No tests found',
      detail: `${facts.sourceFileCount} source files and nothing that looks like a test. Agents cannot prove their changes here, so every change is a guess.`,
      files: [],
      card: {
        title: 'Add a first test suite for the core behaviour', kind: 'chore',
        acceptance: ['A test command exists and runs with one command.', 'At least one test covers the main user-facing behaviour.', 'The tests pass on a clean checkout.'],
        story: 'Without tests, neither people nor agents can tell a good change from a breaking one.',
      },
    });
  }
  if (hasManifest && !facts.scripts.some((script) => script === 'npm run test' || script === 'npm run typecheck' || script === 'npm run build') && has(/(^|\/)package\.json$/)) {
    add({
      id: 'no-check-command', severity: 'high', title: 'No test, typecheck or build script',
      detail: 'package.json defines none of test, typecheck or build, so there is no single command that says "this works".',
      files: ['package.json'],
      card: {
        title: 'Define one check command (test, typecheck or build)', kind: 'chore',
        acceptance: ['package.json has a script that fails when the project is broken.', 'The script exits 0 on the current main branch.'],
        story: 'The board and the crew need one command to prove work against.',
      },
    });
  }
  if (!facts.gitAvailable) {
    add({
      id: 'no-git', severity: 'high', title: 'Not a Git repository',
      detail: 'Without Git, KAI cannot checkpoint a turn, show a diff, or restore a file an agent got wrong.',
      files: [],
      card: { title: 'Put the project under Git with a first commit', kind: 'chore', acceptance: ['The folder is a Git repository.', 'A .gitignore keeps dependencies and secrets out.', 'The current state is committed.'], story: 'Review and undo depend on version control.' },
    });
  }
  const envFiles = files.filter((file) => /(^|\/)\.env(\.[a-z]+)?$/i.test(file) && !/\.(example|sample|template)$/i.test(file));
  if (envFiles.length > 0 && !/(^|\n)\s*\/?\*{0,2}\/?\.env/.test(facts.gitignore)) {
    add({
      id: 'env-not-ignored', severity: 'high', title: 'Secrets file may be committed',
      detail: `${envFiles.join(', ')} ${envFiles.length === 1 ? 'is' : 'are'} in the project and .gitignore does not mention .env.`,
      files: envFiles.slice(0, 8),
      card: { title: 'Keep .env files out of Git and rotate anything exposed', kind: 'chore', acceptance: ['.gitignore lists .env files.', 'A .env.example documents the variables without values.', 'Any key that was committed has been rotated.'], story: 'A committed secret is a leaked secret.' },
    });
  }
  if (!has(/^\.github\/workflows\//) && !has(/(^|\/)(\.gitlab-ci\.yml|azure-pipelines\.yml|\.circleci\/)/) && facts.sourceFileCount > 0) {
    add({
      id: 'no-ci', severity: 'medium', title: 'No continuous integration',
      detail: 'Nothing runs the checks when code is pushed, so a break is found by whoever pulls next.',
      files: [],
      card: { title: 'Run the check command on every push', kind: 'chore', acceptance: ['A CI workflow runs the project check on push and pull request.', 'The workflow passes on the main branch.'], story: 'Checks only protect the project if they run without being asked.' },
    });
  }
  if (!has(/^readme(\.[a-z]+)?$/i)) {
    add({
      id: 'no-readme', severity: 'medium', title: 'No README',
      detail: 'A new person, or a new agent, has no starting point for what this is or how to run it.',
      files: [],
      card: { title: 'Write a README: what it is, how to run it, how to test it', kind: 'chore', acceptance: ['The README says what the project does.', 'It lists the commands to install, run and test.'], story: 'The first thing anyone reads should get them running.' },
    });
  }
  if (hasManifest && !files.some((file) => LOCKFILES.includes(baseName(file)))) {
    add({
      id: 'no-lockfile', severity: 'medium', title: 'No lockfile',
      detail: 'Dependency versions are not pinned, so two installs can behave differently.',
      files: [],
      card: { title: 'Commit a lockfile so installs are repeatable', kind: 'chore', acceptance: ['A lockfile is committed.', 'A clean install from it passes the check command.'], story: 'Repeatable installs make failures reproducible.' },
    });
  }
  if (facts.largeFiles.length > 0) {
    add({
      id: 'large-files', severity: 'low', title: `${facts.largeFiles.length} very large source ${facts.largeFiles.length === 1 ? 'file' : 'files'}`,
      detail: `Over ${Math.round(LARGE_FILE_BYTES / 1000)} KB each. Big files are hard to review and the likeliest place for an agent to break something unrelated.`,
      files: facts.largeFiles.slice(0, 8),
      card: { title: `Split the largest source file: ${baseName(facts.largeFiles[0]!)}`, kind: 'chore', acceptance: ['The file is split along clear responsibilities.', 'The check command passes before and after, with no behaviour change.'], story: 'Smaller files are safer to change and cheaper to give to an agent.' },
    });
  }
  return out;
}

/** Scans a project folder. `onBoard` is filled by the caller, which knows what the board already holds. */
export async function scanForImport(projectId: string, root: string, name: string, now: Date = new Date()): Promise<ImportReport> {
  const snapshot = await snapshotProject(root, name);
  const scripts = await projectScripts(root);
  const gitAvailable = await fs.stat(path.join(root, '.git')).then(() => true, () => false);
  const gitignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8').catch(() => '');

  const sources = snapshot.files.filter((file) => SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()) && !isTestPath(file));
  const largeFiles: string[] = [];
  for (const file of sources.slice(0, MAX_STATS)) {
    const size = await fs.stat(path.join(root, file)).then((stat) => stat.size, () => 0);
    if (size > LARGE_FILE_BYTES) largeFiles.push(file);
  }
  const testFileCount = snapshot.files.filter(isTestPath).length;
  const facts: Facts = { snapshot, scripts, gitAvailable, gitignore, largeFiles, testFileCount, sourceFileCount: sources.length };

  return {
    projectId,
    name,
    scannedAt: now.toISOString(),
    fileCount: snapshot.files.length,
    truncated: snapshot.files.length >= SNAPSHOT_FILE_LIMIT,
    stack: detect(snapshot),
    languages: languagesOf(snapshot.files),
    testFileCount,
    scripts,
    suggestedCheck: suggestCheck(scripts),
    gitAvailable,
    findings: findingsFor(facts).sort((a, b) => ['high', 'medium', 'low'].indexOf(a.severity) - ['high', 'medium', 'low'].indexOf(b.severity)),
    onBoard: [],
  };
}

/** The id a finding's card gets on the board, so a second import adds nothing twice. */
export const importCardId = (findingId: string): string => `import-${findingId}`;
