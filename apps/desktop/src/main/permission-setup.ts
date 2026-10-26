import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { PermissionRule } from '@kai/contracts';

/**
 * Proposes permission rules from what a project actually is, instead of leaving Auto mode's rule list blank until
 * someone hits the same "ask" prompt enough times to bother writing one.
 *
 * Every suggestion is `allow`, and only for the project's own declared checks and builds — never `push`, `publish`,
 * `deploy` or anything else that leaves the machine, which stays behind the existing ask. The person still reviews
 * and saves each one; nothing here writes a rule on its own.
 */

async function readText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function exists(filePath: string): Promise<boolean> {
  return (await readText(filePath)) !== null;
}

/** A script name worth trusting without asking: it checks or builds the project and nothing else. Starting a server, publishing, deploying or releasing is left alone on purpose. */
const SAFE_SCRIPT_NAMES = /^(test|tests?:unit|lint|lint:fix|format|format:check|typecheck|type-check|build|check|verify)$/i;

function suggestion(effect: 'allow', command: string, note: string): PermissionRule {
  return {
    id: `suggested-${command.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 80)}`,
    effect,
    tools: [],
    commands: [command],
    paths: [],
    note,
  };
}

async function fromNodeProject(root: string): Promise<PermissionRule[]> {
  const raw = await readText(path.join(root, 'package.json'));
  if (!raw) return [];
  let scripts: Record<string, unknown>;
  try {
    scripts = (JSON.parse(raw) as { scripts?: Record<string, unknown> }).scripts ?? {};
  } catch {
    return [];
  }
  const manager = (await exists(path.join(root, 'pnpm-lock.yaml'))) ? 'pnpm'
    : (await exists(path.join(root, 'yarn.lock'))) ? 'yarn'
      : 'npm';
  const runPrefix = manager === 'yarn' ? 'yarn' : `${manager} run`;
  return Object.keys(scripts)
    .filter((name) => SAFE_SCRIPT_NAMES.test(name))
    .map((name) => {
      // `npm test` and `yarn test` are the idiomatic forms for the one script every package.json names "test";
      // every other script is run explicitly.
      const command = name === 'test' && manager !== 'pnpm' ? `${manager} test` : `${runPrefix} ${name}`;
      return suggestion('allow', command, `Runs this project's own "${name}" script. Allow it so KAI does not have to ask every time.`);
    });
}

async function fromCargoProject(root: string): Promise<PermissionRule[]> {
  if (!(await exists(path.join(root, 'Cargo.toml')))) return [];
  return [
    suggestion('allow', 'cargo test', 'Runs this project\'s Rust tests.'),
    suggestion('allow', 'cargo build', 'Builds this Rust project.'),
    suggestion('allow', 'cargo clippy', 'Lints this Rust project.'),
    suggestion('allow', 'cargo fmt --check', 'Checks Rust formatting without changing anything.'),
  ];
}

async function fromGoProject(root: string): Promise<PermissionRule[]> {
  if (!(await exists(path.join(root, 'go.mod')))) return [];
  return [
    suggestion('allow', 'go test', 'Runs this project\'s Go tests.'),
    suggestion('allow', 'go build', 'Builds this Go project.'),
    suggestion('allow', 'go vet', 'Checks this Go project for likely mistakes.'),
  ];
}

async function fromPythonProject(root: string): Promise<PermissionRule[]> {
  const hasProject = (await exists(path.join(root, 'pyproject.toml'))) || (await exists(path.join(root, 'requirements.txt'))) || (await exists(path.join(root, 'setup.py')));
  if (!hasProject) return [];
  return [
    suggestion('allow', 'pytest', 'Runs this project\'s Python tests.'),
    suggestion('allow', 'python -m pytest', 'Runs this project\'s Python tests.'),
  ];
}

/** `make <target>` for whichever safe-looking target names the Makefile actually declares. */
async function fromMakefile(root: string): Promise<PermissionRule[]> {
  const raw = (await readText(path.join(root, 'Makefile'))) ?? (await readText(path.join(root, 'makefile')));
  if (!raw) return [];
  const targets = [...raw.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)/gm)].map((match) => match[1]!);
  return [...new Set(targets)]
    .filter((name) => SAFE_SCRIPT_NAMES.test(name))
    .map((name) => suggestion('allow', `make ${name}`, `Runs this project's own "${name}" Makefile target.`));
}

/**
 * What a project's own files say is safe to run without asking every time: its declared test, lint, build and
 * check commands, across whichever of these ecosystems the project actually uses. Never anything that starts a
 * server, publishes, deploys or leaves the machine — those keep the existing ask.
 */
export async function suggestPermissionRules(root: string): Promise<PermissionRule[]> {
  const found = await Promise.all([
    fromNodeProject(root),
    fromCargoProject(root),
    fromGoProject(root),
    fromPythonProject(root),
    fromMakefile(root),
  ]);
  // Several ecosystems can agree on the same command (`cargo fmt --check` from one source, nothing from another);
  // de-duplicated by the exact command text, first source wins.
  const seen = new Set<string>();
  const rules: PermissionRule[] = [];
  for (const rule of found.flat()) {
    const command = rule.commands[0]!;
    if (seen.has(command)) continue;
    seen.add(command);
    rules.push(rule);
  }
  return rules;
}
