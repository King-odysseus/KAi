#!/usr/bin/env node
/**
 * Puts the latest local build into the installed copy of KAI, safely.
 *
 * "Install" for local work means copying `release/win-unpacked` over `%LOCALAPPDATA%\Programs\KAI` (the NSIS installer
 * is only for the update feed and for sharing). Doing that by hand went wrong in four ways, each of which this handles:
 *
 *  - KAI was open, so the copy hit locked files and the window kept running the old build. KAI must be closed first,
 *    and this refuses to close it unless told to (`--close`), and refuses outright when a conversation was saved in the
 *    last two minutes (`--force` overrides) because closing it would cut a run off.
 *  - Copying 9,000 files one by one through antivirus took minutes. Only files that differ are copied, in parallel, and a
 *    locked one is retried instead of failing the run.
 *  - A copy that "succeeded" was not proof. Every file is hashed against the build afterwards, and any difference is a
 *    failure with its name on it.
 *  - Launching from a shell that has `ELECTRON_RUN_AS_NODE` set makes the app exit silently, which looks like a broken
 *    build. The relaunch clears it, then checks that the app really came up.
 *
 *   node apps/desktop/scripts/install-local.mjs --close
 *   node apps/desktop/scripts/install-local.mjs --from <build dir> --to <install dir> --no-launch
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A conversation saved this recently means a run is probably live. */
export const RECENT_ACTIVITY_MS = 120_000;
/** Errors that mean another process has the file open, which is worth waiting out. */
const LOCKED = new Set(['EBUSY', 'EPERM', 'EACCES', 'UNKNOWN']);

export async function sha256(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', resolve).on('error', reject);
  });
  return hash.digest('hex');
}

/** Every file under a directory, as paths relative to it with forward slashes. */
export async function listFiles(root, base = root) {
  const entries = await readdir(root, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...await listFiles(full, base));
    else if (entry.isFile()) found.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return found;
}

async function exists(file) {
  return stat(file).then((info) => info, () => null);
}

/** Runs async work over a list with a bounded number going at once. */
export async function pool(items, limit, work) {
  let next = 0;
  const run = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await work(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/** Which build files are missing from the install or differ from it. Same size and same hash means identical. */
export async function changedFiles(from, to, { concurrency = 16 } = {}) {
  const files = await listFiles(from);
  const changed = [];
  await pool(files, concurrency, async (relative) => {
    const source = path.join(from, relative);
    const target = path.join(to, relative);
    const [sourceInfo, targetInfo] = await Promise.all([stat(source), exists(target)]);
    if (!targetInfo || targetInfo.size !== sourceInfo.size) { changed.push(relative); return; }
    const [a, b] = await Promise.all([sha256(source), sha256(target)]);
    if (a !== b) changed.push(relative);
  });
  return changed.sort();
}

/** Copies one file, retrying while something has it locked. */
export async function copyWithRetry(source, target, { attempts = 6, delayMs = 1_000, copy = copyFile, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  await mkdir(path.dirname(target), { recursive: true });
  for (let attempt = 1; ; attempt += 1) {
    try {
      await copy(source, target);
      return attempt;
    } catch (error) {
      const code = /** @type {{ code?: string }} */ (error).code ?? '';
      if (!LOCKED.has(code) || attempt >= attempts) {
        throw new Error(`Could not copy ${path.basename(source)}${LOCKED.has(code) ? ' (still locked after retries: is KAI closed?)' : ''}: ${error instanceof Error ? error.message : String(error)}`);
      }
      await sleep(delayMs * attempt);
    }
  }
}

/** Copies the changed files, then proves the install matches the build. Returns what was copied and any mismatch. */
export async function syncTree(from, to, options = {}) {
  const concurrency = options.concurrency ?? 12;
  const todo = options.only ?? await changedFiles(from, to, { concurrency });
  await pool(todo, concurrency, (relative) => copyWithRetry(path.join(from, relative), path.join(to, relative), options.retry));
  // The proof: every file in the build, hashed against the install.
  const files = await listFiles(from);
  const mismatched = [];
  await pool(files, 16, async (relative) => {
    const target = path.join(to, relative);
    const info = await exists(target);
    if (!info) { mismatched.push(`${relative} (missing)`); return; }
    if ((await sha256(path.join(from, relative))) !== (await sha256(target))) mismatched.push(relative);
  });
  return { checked: files.length, copied: todo.length, mismatched: mismatched.sort() };
}

function tasklistCount(image) {
  if (process.platform !== 'win32') return 0;
  const out = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/NH'], { encoding: 'utf8' }).stdout ?? '';
  return out.split(/\r?\n/).filter((line) => line.toLowerCase().includes(image.toLowerCase())).length;
}

/** The newest conversation save, in ms since the epoch, or 0 when there are none. */
export async function newestConversationSave(dataDirectory) {
  const folder = path.join(dataDirectory, 'conversations');
  const names = await readdir(folder).catch(() => []);
  let newest = 0;
  for (const name of names) {
    const info = await exists(path.join(folder, name));
    if (info && info.mtimeMs > newest) newest = info.mtimeMs;
  }
  return newest;
}

/** Decides whether it is safe to go on. Pure, so the rules can be tested without a running app. */
export function installDecision({ running, newestSaveMs, nowMs, close, force }) {
  const recent = newestSaveMs > 0 && nowMs - newestSaveMs < RECENT_ACTIVITY_MS;
  if (recent && !force) return { ok: false, reason: `A conversation was saved ${Math.round((nowMs - newestSaveMs) / 1000)} seconds ago, so a run may be live. Let it finish, or pass --force.` };
  if (running && !close) return { ok: false, reason: 'KAI is running. Pass --close to stop it first; it has to be closed for the files to be replaced.' };
  return { ok: true, reason: running ? 'KAI will be closed.' : 'KAI is not running.' };
}

function parseArgs(argv) {
  const args = { close: false, force: false, launch: true, from: path.join(appRoot, 'release', 'win-unpacked'), to: path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'KAI') };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--close') args.close = true;
    else if (arg === '--force') args.force = true;
    else if (arg === '--no-launch') args.launch = false;
    else if (arg === '--from') args.from = path.resolve(argv[++i] ?? '');
    else if (arg === '--to') args.to = path.resolve(argv[++i] ?? '');
    else throw new Error(`Unknown option ${arg}.`);
  }
  return args;
}

export async function main(argv) {
  const args = parseArgs(argv);
  const dataDirectory = process.env.KAI_DESKTOP_USER_DATA ?? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'KAI');
  if (!(await exists(path.join(args.from, 'resources', 'app.asar')))) {
    throw new Error(`No build at ${args.from} (resources/app.asar is missing). Run the desktop package step first.`);
  }
  const running = tasklistCount('KAI.exe') > 0;
  const decision = installDecision({ running, newestSaveMs: await newestConversationSave(dataDirectory), nowMs: Date.now(), close: args.close, force: args.force });
  console.log(decision.reason);
  if (!decision.ok) { process.exitCode = 1; return; }

  if (running) {
    spawnSync('taskkill', ['/F', '/IM', 'KAI.exe'], { stdio: 'ignore' });
    for (let wait = 0; wait < 20 && tasklistCount('KAI.exe') > 0; wait += 1) await new Promise((r) => setTimeout(r, 500));
    if (tasklistCount('KAI.exe') > 0) throw new Error('KAI would not close, so nothing was copied.');
  }

  const started = Date.now();
  const result = await syncTree(args.from, args.to);
  console.log(`Copied ${result.copied} of ${result.checked} files in ${Math.round((Date.now() - started) / 1000)}s.`);
  if (result.mismatched.length > 0) {
    console.error(`${result.mismatched.length} file(s) do not match the build:\n${result.mismatched.slice(0, 20).map((file) => `  ${file}`).join('\n')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Verified: all ${result.checked} files match the build byte for byte.`);

  if (!args.launch) return;
  const { ELECTRON_RUN_AS_NODE: _runAsNode, NODE_OPTIONS: _nodeOptions, ...environment } = process.env;
  spawn(path.join(args.to, 'KAI.exe'), [], { detached: true, stdio: 'ignore', env: environment }).unref();
  await new Promise((r) => setTimeout(r, 12_000));
  const processes = tasklistCount('KAI.exe');
  if (processes === 0) throw new Error('KAI did not start (no KAI.exe processes after 12 seconds). The files are installed; check the log in %APPDATA%\\KAI\\logs.');
  console.log(`KAI is running (${processes} processes) from ${args.to}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
