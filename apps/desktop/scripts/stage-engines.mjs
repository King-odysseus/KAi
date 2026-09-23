import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(appRoot, '..', '..');
const workspaceRoot = path.resolve(projectRoot, '..');
const resourcesRoot = path.join(appRoot, 'resources', 'engines');
const engines = [
  {
    name: 'cognitive1',
    packageName: 'cognitive1',
    version: '1.0.0',
    commit: '51f6797740c16d1b3df5ddcb24393eb6197c2ce4',
    directoryNames: ['cognitive1'],
    environmentVariable: 'KAI_COGNITIVE1_ENGINE_ROOT',
    include: ['out', 'templates', 'agents', 'package.json', 'LICENSE'],
  },
  {
    name: 'universal-agent-proxy',
    packageName: 'universal-agent-proxy',
    version: '1.9.0',
    commit: 'a8c2443dee3e9c8d268475fe6387cc25fd67a0bb',
    directoryNames: ['universal-agent-proxy', 'ClaudeCode-Proxy'],
    environmentVariable: 'KAI_UAP_ENGINE_ROOT',
    include: ['out', 'package.json', 'LICENSE'],
  },
];

await assertSafeTarget();
await rm(resourcesRoot, { recursive: true, force: true });
await mkdir(resourcesRoot, { recursive: true });

for (const engine of engines) {
  const sourceRoot = await findEngineRoot(engine);
  const destinationRoot = path.join(resourcesRoot, engine.name);
  await mkdir(destinationRoot, { recursive: true });

  for (const entry of engine.include) {
    await cp(path.join(sourceRoot, entry), path.join(destinationRoot, entry), {
      recursive: true,
      force: true,
      dereference: true,
    });
  }
  await stageDependencies(sourceRoot, destinationRoot);
  await removeTests(path.join(destinationRoot, 'out'));
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
  const dirtyFiles = execFileSync('git', ['status', '--short'], { cwd: sourceRoot, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
  await writeFile(
    path.join(destinationRoot, 'KAI_ENGINE_MANIFEST.json'),
    `${JSON.stringify({ ...engine, sourceCommit, dirtyFiles, sourceRoot, stagedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(`Staged ${engine.packageName} ${engine.version} from ${sourceRoot}\n`);
}

async function findEngineRoot(engine) {
  const candidates = [];
  if (process.env[engine.environmentVariable]) candidates.push(path.resolve(process.env[engine.environmentVariable]));
  for (const directoryName of engine.directoryNames) {
    candidates.push(path.join(workspaceRoot, directoryName));
  }

  for (const candidate of candidates) {
    try {
      const packageJson = JSON.parse(await readFile(path.join(candidate, 'package.json'), 'utf8'));
      if (packageJson.name !== engine.packageName) continue;
      if (packageJson.version !== engine.version) {
        throw new Error(`expected ${engine.version}, found ${packageJson.version}`);
      }
      const actualCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: candidate, encoding: 'utf8' }).trim();
      if (actualCommit !== engine.commit && process.env.KAI_ENGINE_STRICT_COMMIT === '1') {
        throw new Error(`expected audited commit ${engine.commit}, found ${actualCommit}`);
      }
      if (actualCommit !== engine.commit) {
        process.stderr.write(`Warning: ${engine.packageName} advanced from audited commit ${engine.commit} to ${actualCommit}.\n`);
      }
      return candidate;
    } catch (error) {
      if (candidate === candidates.at(-1)) throw error;
    }
  }
  throw new Error(`Could not locate ${engine.packageName}. Set ${engine.environmentVariable}.`);
}

async function stageDependencies(sourceRoot, destinationRoot) {
  const output = runNpm(['ls', '--omit=dev', '--all', '--parseable'], sourceRoot);
  const sourceNodeModules = path.join(sourceRoot, 'node_modules');
  const destinationNodeModules = path.join(destinationRoot, 'node_modules');
  const packages = output.split(/\r?\n/).filter(Boolean);

  for (const packagePath of packages) {
    const relative = path.relative(sourceNodeModules, packagePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    await cp(packagePath, path.join(destinationNodeModules, relative), {
      recursive: true,
      force: true,
      dereference: true,
    });
  }
}

async function removeTests(root) {
  let entries;
  try {
    entries = await readDirRecursive(root);
  } catch {
    return;
  }
  const tests = entries.filter((entry) => path.basename(entry) === '__tests__');
  for (const directory of tests) {
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(`${resourcesRoot}${path.sep}`)) {
      throw new Error(`Refusing to remove path outside engine staging: ${resolved}`);
    }
    await rm(resolved, { recursive: true, force: true });
  }
}

async function readDirRecursive(root) {
  const { readdir } = await import('node:fs/promises');
  const result = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        result.push(fullPath);
        pending.push(fullPath);
      }
    }
  }
  return result;
}

async function assertSafeTarget() {
  const expected = path.join(appRoot, 'resources', 'engines');
  if (path.resolve(resourcesRoot) !== path.resolve(expected)) {
    throw new Error(`Refusing to stage engines outside ${expected}.`);
  }
}

function runNpm(args, cwd) {
  const npmCli = process.env.npm_execpath;
  if (npmCli && existsSync(npmCli)) {
    return execFileSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8' });
  }
  return execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
}
