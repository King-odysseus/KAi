import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(appRoot, '..', '..');
const workspaceRoot = path.resolve(projectRoot, '..');
const resourcesRoot = path.join(appRoot, 'resources', 'engines');
const stagingRoot = path.join(appRoot, 'resources', `.engines-staging-${process.pid}`);
const previousRoot = path.join(appRoot, 'resources', `.engines-previous-${process.pid}`);
const stagingLock = path.join(appRoot, 'resources', '.engines-staging.lock');
const agentRulesRoot = path.join(appRoot, 'resources', 'agent-rules');
const engines = [
  {
    name: 'cognitive1',
    packageName: 'cognitive1',
    version: '1.0.0',
    commit: '51f6797740c16d1b3df5ddcb24393eb6197c2ce4',
    directoryNames: ['cognitive1'],
    environmentVariable: 'KAI_COGNITIVE1_ENGINE_ROOT',
    include: ['out', 'templates', 'agents', 'package.json', 'LICENSE'],
    requiredSourceFiles: ['Instruct.md'],
    // Compiled from source before it is copied. Copying `out/` as found shipped whatever the last
    // manual build happened to leave there, which could be older than the source beside it.
    buildScript: 'build',
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
await mkdir(path.dirname(stagingLock), { recursive: true });
await acquireStagingLock();

try {
  await rm(stagingRoot, { recursive: true, force: true });
  await rm(previousRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });

  for (const engine of engines) {
    const sourceRoot = await findEngineRoot(engine);
    await validateSourceFiles(engine, sourceRoot);
    const destinationRoot = path.join(stagingRoot, engine.name);
    await mkdir(destinationRoot, { recursive: true });

    if (engine.buildScript) {
      process.stdout.write(`Building ${engine.packageName} from source in ${sourceRoot}\n`);
      try {
        runNpm(['run', engine.buildScript], sourceRoot, { stdio: 'inherit' });
      } catch {
        throw new Error(`${engine.packageName} failed to build. Fix the build in ${sourceRoot}, then stage again.`);
      }
    }

    for (const entry of engine.include) {
      await cp(path.join(sourceRoot, entry), path.join(destinationRoot, entry), {
        recursive: true,
        force: true,
        dereference: true,
      });
    }
    await stageDependencies(sourceRoot, destinationRoot);
    await removeTests(path.join(destinationRoot, 'out'));
    await validateEngine(engine, destinationRoot);
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
    const dirtyFiles = execFileSync('git', ['status', '--short'], { cwd: sourceRoot, encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean);
    await writeFile(
      path.join(destinationRoot, 'KAI_ENGINE_MANIFEST.json'),
      `${JSON.stringify({ ...engine, sourceCommit, dirtyFiles, sourceRoot, stagedAt: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    );
    process.stdout.write(`Prepared ${engine.packageName} ${engine.version} from ${sourceRoot}\n`);
  }

  await publishStagedEngines();

  const cognitive1Root = await findEngineRoot(engines[0]);
  await mkdir(agentRulesRoot, { recursive: true });
  await cp(path.join(cognitive1Root, 'Instruct.md'), path.join(agentRulesRoot, 'Cognitive1-Rules.md'), { force: true });
  process.stdout.write(`Staged authoritative Cognitive1 rules from ${cognitive1Root}\n`);
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
  await rm(previousRoot, { recursive: true, force: true });
  await rm(stagingLock, { recursive: true, force: true });
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
    if (!resolved.startsWith(`${stagingRoot}${path.sep}`)) {
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
  if (path.dirname(stagingRoot) !== path.dirname(resourcesRoot)) {
    throw new Error('Refusing to use an engine staging directory outside the resources directory.');
  }
}

async function validateEngine(engine, destinationRoot) {
  for (const entry of engine.include) {
    const stagedPath = path.join(destinationRoot, entry);
    if (!existsSync(stagedPath)) {
      throw new Error(`${engine.packageName} staging is incomplete: ${stagedPath} is missing.`);
    }
  }
  const entryPoint = path.join(destinationRoot, engine.name === 'cognitive1' ? 'out/index.js' : 'out/proxy.js');
  if (!existsSync(entryPoint)) {
    throw new Error(`${engine.packageName} staging is incomplete: ${entryPoint} is missing.`);
  }
}

async function validateSourceFiles(engine, sourceRoot) {
  for (const entry of engine.requiredSourceFiles ?? []) {
    if (!existsSync(path.join(sourceRoot, entry))) {
      throw new Error(`${engine.packageName} source is incomplete: ${path.join(sourceRoot, entry)} is missing.`);
    }
  }
}

async function publishStagedEngines() {
  const hadPrevious = existsSync(resourcesRoot);
  if (hadPrevious) await rename(resourcesRoot, previousRoot);
  try {
    await rename(stagingRoot, resourcesRoot);
  } catch (error) {
    if (hadPrevious && !existsSync(resourcesRoot)) await rename(previousRoot, resourcesRoot);
    throw error;
  }
  await rm(previousRoot, { recursive: true, force: true });
}

async function acquireStagingLock() {
  try {
    // mkdir is atomic, so two packaging jobs cannot erase or publish each other's half-built engines.
    await mkdir(stagingLock);
    await writeFile(path.join(stagingLock, 'pid'), String(process.pid), 'utf8');
    return;
  } catch {
    const owner = Number(await readFile(path.join(stagingLock, 'pid'), 'utf8').catch(() => '0'));
    if (owner > 0 && processIsRunning(owner)) {
      throw new Error(`Another engine staging run is already active (process ${owner}). Wait for it to finish and retry.`);
    }
    await rm(stagingLock, { recursive: true, force: true });
    await mkdir(stagingLock);
    await writeFile(path.join(stagingLock, 'pid'), String(process.pid), 'utf8');
  }
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runNpm(args, cwd, options = {}) {
  const npmCli = process.env.npm_execpath;
  if (npmCli && existsSync(npmCli)) {
    return execFileSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8', ...options });
  }
  return execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...options,
  });
}
