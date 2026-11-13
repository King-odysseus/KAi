#!/usr/bin/env node
/**
 * A real run of the Architect / Implementer split, end to end, in an isolated copy of the app.
 *
 * The test suite drives the loop with scripted agents; this uses the real CLIs. It starts the built app with a throwaway
 * profile (so nothing of the person's is touched), opens a throwaway git project that has one deliberate bug and a test
 * that fails, sends the split through the same IPC channel the composer uses, and then judges the result from the
 * project, not from what the agents said: did the test file stay untouched, and does `npm test` now pass?
 *
 *   npm run build --workspace @kai/desktop   (once, so out/ is current)
 *   node apps/desktop/scripts/trial-architect.mjs [--architect claude] [--implementer codex] [--minutes 10]
 *
 * It spends real tokens on whichever agents are chosen, a few cents for this task. Exit code 0 only when the run
 * finished and the project's own test passes.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronExecutable = createRequire(import.meta.url)('electron');

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const architectAgent = option('architect', 'claude');
const implementerAgent = option('implementer', 'codex');
const architectModel = option('architect-model', architectAgent === 'claude' ? 'sonnet' : undefined);
const minutes = Number(option('minutes', '10'));

const userData = await mkdtemp(path.join(tmpdir(), 'kai-trial-profile-'));
const projectPath = await mkdtemp(path.join(tmpdir(), 'kai-trial-project-'));

const TEST_FILE = [
  "const assert = require('node:assert');",
  "const { add, double } = require('./math');",
  "assert.strictEqual(add(2, 3), 5, 'add(2, 3) should be 5');",
  "assert.strictEqual(add(-1, 1), 0, 'add(-1, 1) should be 0');",
  "assert.strictEqual(double(4), 8, 'double(4) should be 8');",
  "console.log('all tests passed');",
  '',
].join('\n');

async function makeProject() {
  await mkdir(projectPath, { recursive: true });
  // One real bug (add subtracts) and one missing feature (double is not written), so there is something to plan.
  await writeFile(path.join(projectPath, 'math.js'), 'function add(a, b) {\n  return a - b;\n}\n\nmodule.exports = { add };\n', 'utf8');
  await writeFile(path.join(projectPath, 'test.js'), TEST_FILE, 'utf8');
  await writeFile(path.join(projectPath, 'package.json'), `${JSON.stringify({ name: 'architect-trial', version: '1.0.0', scripts: { test: 'node test.js' } }, null, 2)}\n`, 'utf8');
  const git = (...args) => spawnSync('git', ['-c', 'user.email=trial@example.com', '-c', 'user.name=Trial', ...args], { cwd: projectPath, encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'Start of the trial project');
}

async function writeProfile() {
  const now = new Date().toISOString();
  const project = { schemaVersion: 1, id: 'project-architect-trial', name: 'Architect Trial', path: projectPath, createdAt: now, lastOpenedAt: now };
  const settings = {
    schemaVersion: 1,
    defaultAgent: architectAgent,
    defaultRoute: 'direct',
    defaultAutonomy: 'full',
    theme: 'dark',
    activeProjectId: project.id,
    projectOrder: [project.id],
    windowBounds: null,
    logRetentionEntries: 2000,
    diagnosticsEnabled: true,
    directApi: { enabled: false, provider: 'openai', model: '', baseUrl: 'https://api.openai.com/v1', credentialId: 'provider.openai' },
    mcpServers: [],
    cognitive1: { enabled: false, endpoint: 'http://127.0.0.1:9876', dataPath: null },
    proxy: { enabled: false, port: 8082, targetBaseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-flash', credentialId: 'provider.deepseek' },
  };
  await writeFile(path.join(userData, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  await writeFile(path.join(userData, 'projects.json'), `${JSON.stringify({ schemaVersion: 1, projects: [project] }, null, 2)}\n`, 'utf8');
  return project;
}

const TERMINAL = new Set(['finished', 'failed', 'stopped']);
let app;
let exitCode = 1;
try {
  await makeProject();
  const project = await writeProfile();
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...environment } = process.env;
  app = await electron.launch({
    args: [appRoot],
    cwd: appRoot,
    executablePath: electronExecutable,
    env: { ...environment, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true', KAI_DESKTOP_USER_DATA: userData, KAI_DESKTOP_NOTIFICATIONS: 'off' },
    timeout: 30_000,
  });
  const page = await app.firstWindow();
  await page.locator('.project-picker-button').getByText(project.name, { exact: true }).waitFor({ timeout: 30_000 });

  const split = {
    enabled: true,
    architect: { execution: 'cli', agent: architectAgent, ...(architectModel ? { model: architectModel } : {}) },
    implementer: { execution: 'cli', agent: implementerAgent },
    fallback: null,
  };
  for (const [role, target] of [['Architect', split.architect], ['Implementer', split.implementer]]) {
    const ready = await page.evaluate((t) => window.kaiDesktop.architectReady(t), target);
    console.log(`${role}: ${ready.ok ? `${ready.data.label} - ${ready.data.ready ? 'ready' : `NOT READY (${ready.data.reason})`}` : ready.error.message}`);
    if (!ready.ok || !ready.data.ready) throw new Error(`The ${role} is not available here, so there is nothing to trial.`);
  }

  const prompt = 'math.js has a bug and a missing function. Make `npm test` pass: fix add so it adds, and add a double function. Do not edit test.js.';
  const started = await page.evaluate((input) => window.kaiDesktop.runArchitect(input), {
    projectId: project.id,
    prompt,
    split,
    route: 'direct',
    autonomy: 'full',
    agent: architectAgent,
    execution: 'cli',
  });
  if (!started.ok) throw new Error(`The run did not start: ${started.error.message}`);
  const conversationId = started.data.conversationId;
  console.log(`Started in conversation ${conversationId}. Waiting up to ${minutes} minutes.`);

  const deadline = Date.now() + minutes * 60_000;
  let seen = 0;
  let status = started.data;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const response = await page.evaluate((id) => window.kaiDesktop.architectStatus({ conversationId: id }), conversationId);
    if (!response.ok || !response.data) continue;
    status = response.data;
    for (const entry of status.log.slice(seen)) console.log(`  [${entry.role ?? 'run'}] ${entry.text}`);
    seen = status.log.length;
    if (status.phase === 'waiting-for-you') {
      console.log('  The run asked whether to continue; finishing here.');
      await page.evaluate((id) => window.kaiDesktop.answerArchitect({ conversationId: id, carryOn: false }), conversationId);
    }
    if (TERMINAL.has(status.phase)) break;
  }
  console.log(`Run ended: ${status.phase}. ${status.message}`);
  console.log(`Rounds: ${status.round}. Cost: Architect $${status.architectCostUsd.toFixed(3)}, Implementer $${status.implementerCostUsd.toFixed(3)}.`);

  // Judged from the project, not from what anyone said.
  const testUntouched = (await readFile(path.join(projectPath, 'test.js'), 'utf8')) === TEST_FILE;
  const run = spawnSync('npm', ['test', '--silent'], { cwd: projectPath, encoding: 'utf8', shell: true });
  const math = await readFile(path.join(projectPath, 'math.js'), 'utf8');
  console.log('--- math.js after the run');
  console.log(math.trim());
  console.log(`--- test.js untouched: ${testUntouched}`);
  console.log(`--- npm test: ${run.status === 0 ? 'PASSES' : `FAILS (exit ${run.status})`} ${(run.stdout + run.stderr).trim().slice(-200)}`);

  const conversation = await page.evaluate((id) => window.kaiDesktop.getConversation ? window.kaiDesktop.getConversation(id) : null, conversationId).catch(() => null);
  if (conversation?.ok) {
    const roles = (conversation.data.turns ?? []).filter((turn) => turn.role === 'user').map((turn) => String(turn.text).slice(0, 60).replace(/\s+/g, ' '));
    console.log(`--- the transcript has ${conversation.data.turns.length} turns; prompts sent: ${roles.join(' | ')}`);
    console.log(`--- the conversation is recorded as: agent ${conversation.data.activeAgent}, ${conversation.data.execution}`);
  }

  // What KAI remembered about the project's runs. It must name the person's request, once, for the build: not the
  // Architect's runs (which change nothing) and not the roles' own prompts, which are KAI's wording.
  await new Promise((resolve) => setTimeout(resolve, 4_000));
  const findRuns = (value) => {
    if (!value || typeof value !== 'object') return [];
    if (Array.isArray(value.runs)) return value.runs;
    return Object.values(value).flatMap(findRuns);
  };
  const knowledgeDirectory = path.join(userData, 'knowledge');
  const notes = [];
  for (const name of await readdir(knowledgeDirectory).catch(() => [])) {
    try { notes.push(...findRuns(JSON.parse(await readFile(path.join(knowledgeDirectory, name), 'utf8')))); } catch { /* an unreadable file is no notes */ }
  }
  console.log(`--- project memory holds ${notes.length} run note(s): ${notes.map((note) => JSON.stringify(String(note.task).slice(0, 70))).join(' | ')}`);
  const memoryOk = notes.length >= 1 && notes.every((note) => note.task === prompt);
  console.log(`--- notes name the request, not a role prompt: ${memoryOk}`);

  exitCode = status.phase === 'finished' && testUntouched && run.status === 0 && memoryOk ? 0 : 1;
  console.log(exitCode === 0 ? 'TRIAL PASSED' : 'TRIAL FAILED');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  await app?.close().catch(() => undefined);
  await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  await rm(projectPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  process.exit(exitCode);
}
