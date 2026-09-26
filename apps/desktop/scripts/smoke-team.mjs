// Drives the Auto team feature end to end in the real app: five fake CLIs stand in for the agents, so the whole
// path (plan, review, approve, run each part on its own agent, stop at a blocked security review, continue) is
// exercised without a model or a network call.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { assertControlsDoNotWrap, assertTogglesCompact } from './layout-checks.mjs';
import { waitForPage } from './smoke-helpers.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(appRoot, 'test-results', 'smoke-team');
const root = await mkdtemp(path.join(tmpdir(), 'kai-team-smoke-'));
const userData = path.join(root, 'user-data');
const projectPath = path.join(root, 'project');
const binDirectory = path.join(root, 'bin');
const kimiHome = path.join(root, 'kimi-home');
const callLog = path.join(root, 'calls.jsonl');
const planFile = path.join(root, 'plan.json');
const electronExecutable = createRequire(import.meta.url)('electron');
const packagedExecutable = process.env.KAI_PACKAGED_EXECUTABLE;
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...launchEnvironment } = process.env;
const rendererErrors = [];
const goal = 'Add a login page with a matching API endpoint';
let electronApp;
// Stands in for LM Studio's local server so the provider flow is the same on every machine.
const localServer = await startFakeLmStudio();

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await createFixtures();

try {
  electronApp = await electron.launch({
    args: packagedExecutable ? [] : [appRoot],
    cwd: appRoot,
    executablePath: packagedExecutable ?? electronExecutable,
    env: {
      ...withFakeAgentsOnPath(launchEnvironment),
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      KAI_DESKTOP_USER_DATA: userData,
      KAI_DESKTOP_NOTIFICATIONS: 'off',
      KIMI_CODE_HOME: kimiHome,
      FAKE_LOG: callLog,
      FAKE_PLAN: planFile,
      FAKE_VERDICT: 'VERDICT: BLOCK - the login handler logs the raw password',
    },
    timeout: 30_000,
  });
  const page = await electronApp.firstWindow();
  page.on('pageerror', (error) => rendererErrors.push(error.stack ?? error.message));
  await page.locator('.project-picker-button').getByText('Team Smoke Project', { exact: true }).waitFor({ timeout: 20_000 });

  await verifySettingsCard(page);
  await verifyLmStudioProvider(page);
  await openWorkflows(page);
  await verifyPlan(page);
  await verifyEditingAPart(page);
  await runAndStopAtSecurityReview(page);
  await continueAndFinish(page);
  await verifyCallsMadeByTheTeam();
  await verifyCustomRoleAndProjectTeam(page);
  await verifySideBySide(page);
  await verifyNarrowWindow(page);

  if (rendererErrors.length > 0) throw new Error(`Renderer errors: ${rendererErrors.join(' | ')}`);
  console.log(`KAI team smoke passed. Screenshots: ${outputDirectory}`);
} catch (error) {
  if (rendererErrors.length > 0) console.error(`Renderer errors: ${rendererErrors.join(' | ')}`);
  const windows = electronApp?.windows() ?? [];
  for (const [index, window] of windows.entries()) {
    await window.screenshot({ path: path.join(outputDirectory, `failure-${index + 1}.png`) }).catch(() => undefined);
    console.error(`Window ${index + 1} body:\n${await window.locator('body').innerText().catch(() => '<body unavailable>')}`);
  }
  console.error(`Agent calls so far:\n${await readFile(callLog, 'utf8').catch(() => '<none>')}`);
  throw error;
} finally {
  await electronApp?.close().catch(() => undefined);
  await new Promise((resolve) => localServer.server.close(resolve));
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
}

async function verifySettingsCard(page) {
  await page.getByRole('button', { name: 'Control: Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor();
  const section = page.locator('section.settings-section[aria-label="Agent team"]');
  await section.scrollIntoViewIfNeeded();
  const roles = await section.locator('fieldset.team-role').count();
  if (roles !== 7) throw new Error(`Expected 7 built-in roles in the Agent team card, saw ${roles}.`);
  await section.getByLabel('Orchestrator agent').waitFor();
  if (await section.getByLabel('Orchestrator agent').inputValue() !== 'codex') throw new Error('The saved orchestrator choice was not shown.');
  if (await section.getByLabel('Security reviewer agent').inputValue() !== 'auto') throw new Error('Reviewer roles should default to Auto.');
  await assertControlsDoNotWrap(page, 'settings-agent-team');
  await page.screenshot({ path: path.join(outputDirectory, 'settings-agent-team.png') });

  // A change marks the card as unsaved, saves on its own, and survives a reload of the settings.
  await section.getByLabel('Team preset').selectOption('budget');
  await section.getByLabel('Docs writer agent').selectOption('kimi');
  const save = section.getByRole('button', { name: 'Save agent team' });
  await save.click();
  await page.getByText('All changes saved').waitFor({ timeout: 10_000 });
  const saved = await page.evaluate(async () => (await window.kaiDesktop.getSettings()).data.agentTeam);
  if (saved.preset !== 'budget' || saved.roles.docs.assignee !== 'kimi') throw new Error(`The team settings were not saved: ${JSON.stringify(saved)}`);
  await section.getByLabel('Team preset').selectOption('balanced');
  await section.getByLabel('Docs writer agent').selectOption('auto');
  await save.click();
  await page.getByText('All changes saved').waitFor({ timeout: 10_000 });
}

async function verifyLmStudioProvider(page) {
  const direct = page.locator('section.settings-section').filter({ has: page.getByText('Direct API', { exact: true }) });
  await direct.scrollIntoViewIfNeeded();
  await direct.locator('label.field:has(span:text-is("Provider")) > select').selectOption('lmstudio');
  await direct.getByText(/Runs on your computer, so there is no key/).waitFor();
  await direct.getByText('API key (optional)').waitFor();
  await direct.getByText('Uses the LM Studio server on this computer; no key needed').waitFor();

  // Point it at the stand-in server, clear the model, and refresh: the coding model is chosen, not the embedding one.
  await direct.locator('label.field:has(span:text-is("Base URL")) input').fill(localServer.url);
  await direct.locator('label.field:has(span:text-is("Model")) input').fill('');
  await direct.getByRole('button', { name: 'Refresh models' }).click();
  await direct.getByText('3 models on this computer.').waitFor({ timeout: 15_000 });
  const chosen = await direct.locator('label.field:has(span:text-is("Model")) input').inputValue();
  if (chosen !== 'qwen2.5-coder-7b-instruct') throw new Error(`Expected the Qwen coder model to be chosen, got "${chosen}".`);

  // Enable it and save: it works with no key stored and no vault involved, and the settings persist.
  await direct.getByRole('checkbox', { name: /Enable direct API mode/ }).check();
  await direct.getByRole('button', { name: 'Save Direct API settings' }).click();
  await page.getByText('All changes saved').waitFor({ timeout: 10_000 });
  const capability = await page.evaluate(async () => (await window.kaiDesktop.directApiCapability()).data);
  if (!capability.available || capability.provider !== 'lmstudio' || capability.credentialStored) {
    throw new Error(`LM Studio should be usable without a key: ${JSON.stringify(capability)}`);
  }
  await assertControlsDoNotWrap(page, 'settings with LM Studio selected');
  await page.screenshot({ path: path.join(outputDirectory, 'settings-lmstudio.png') });

  // Put the direct API back the way it was so the rest of the run is unaffected.
  await direct.getByRole('checkbox', { name: /Enable direct API mode/ }).uncheck();
  await direct.getByRole('button', { name: 'Save Direct API settings' }).click();
  await page.getByText('All changes saved').waitFor({ timeout: 10_000 });
}

async function startFakeLmStudio() {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ object: 'list', data: ['qwen2.5-coder-7b-instruct', 'text-embedding-nomic-embed-text-v1.5', 'llava-v1.5-7b'].map((id) => ({ id, object: 'model' })) }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/v1` };
}

async function openWorkflows(page) {
  await page.getByRole('button', { name: 'Work: Workflows', exact: true }).click();
  await page.getByRole('heading', { name: 'Workflows', level: 1 }).waitFor();
  await page.locator('section.team-panel').waitFor();
  const plan = page.getByRole('button', { name: 'Plan the job' });
  if (!(await plan.isDisabled())) throw new Error('Plan the job should be disabled until a goal is typed.');
}

async function verifyPlan(page) {
  await page.getByLabel('Goal').fill(goal);
  await page.getByRole('button', { name: 'Plan the job' }).click();
  await page.locator('.team-plan').waitFor({ timeout: 60_000 });
  await assertControlsDoNotWrap(page, 'team-plan');
  await page.screenshot({ path: path.join(outputDirectory, 'team-plan.png') });

  const titles = await page.locator('.team-part .team-part-title strong').allTextContents();
  const expected = ['Login form', 'Auth endpoint', 'Security review', 'Code review'];
  if (JSON.stringify(titles) !== JSON.stringify(expected)) throw new Error(`Unexpected plan parts: ${JSON.stringify(titles)}`);
  // Balanced + Auto with everything ready: Claude for the UI, Codex for the API, reviewers who did not write the code.
  const agentOf = (title) => page.getByLabel(`${title} agent`).inputValue();
  if (await agentOf('Login form') !== 'claude') throw new Error('Frontend should go to Claude.');
  if (await agentOf('Auth endpoint') !== 'codex') throw new Error('Backend should go to Codex.');
  for (const reviewer of ['Security review', 'Code review']) {
    const agent = await agentOf(reviewer);
    if (agent === 'claude' || agent === 'codex') throw new Error(`${reviewer} went to ${agent}, which wrote the code.`);
  }
  const notes = await page.locator('.team-warnings').innerText();
  if (!/security review because this job touches/i.test(notes)) throw new Error(`The added security review was not explained: ${notes}`);
  if (!(await page.locator('.team-billing.subscription').count())) throw new Error('Parts on a CLI account should be marked as such.');

  const calls = await readCalls();
  const planning = calls.find((call) => /orchestrator of a team/.test(call.prompt));
  if (!planning) throw new Error('The orchestrator was never asked to plan.');
  if (planning.agent !== 'codex' || !planning.args.join(' ').includes('--sandbox read-only')) {
    throw new Error(`Planning must run read-only on the chosen orchestrator: ${JSON.stringify(planning.args)}`);
  }
  if (calls.length !== 1) throw new Error(`Planning must not start any other agent, saw ${calls.length} calls.`);
}

async function verifyEditingAPart(page) {
  // The user can hand a part to a different agent before approving.
  await page.getByLabel('Check command').fill('node check.js');
  await page.getByLabel('Code review agent').selectOption('qwen');
  const reason = await page.locator('.team-part', { hasText: 'Code review' }).locator('.team-reason').innerText();
  if (!reason.includes('You chose Qwen Code')) throw new Error(`The override was not reflected: ${reason}`);
}

async function runAndStopAtSecurityReview(page) {
  await page.getByRole('button', { name: /Run team \(4 parts\)/ }).click();
  const decision = page.locator('section.team-decision');
  await decision.waitFor({ timeout: 90_000 });
  const text = await decision.innerText();
  if (!text.includes('the login handler logs the raw password')) throw new Error(`The block reason was not shown: ${text}`);
  await assertControlsDoNotWrap(page, 'team-security-stop');
  await page.screenshot({ path: path.join(outputDirectory, 'team-security-stop.png') });

  const calls = await readCalls();
  if (calls.some((call) => call.agent === 'qwen')) throw new Error('The code review ran even though the security review blocked the job.');
  if (await page.getByRole('button', { name: 'Resume' }).count()) throw new Error('A plain Resume must not bypass the security decision.');
}

async function continueAndFinish(page) {
  await page.getByRole('button', { name: 'Continue anyway' }).click();
  await page.locator('.workflow-run-list .workflow-status.completed').first().waitFor({ timeout: 90_000 });
  await page.locator('section.team-decision').waitFor({ state: 'detached' });
  await page.getByText('Security: blocked, continued by you').waitFor();
  await verifyCheckRoundTrip(page);
  await assertControlsDoNotWrap(page, 'team-finished');
  await page.screenshot({ path: path.join(outputDirectory, 'team-finished.png') });
}

async function verifyCheckRoundTrip(page) {
  // The check failed once, named src/api/login.ts, and only the backend part went back to fix it.
  const progress = page.locator('.team-check-progress');
  await progress.waitFor();
  const text = await progress.innerText();
  if (!/node check\.js/.test(text) || !/passed/.test(text) || !/fix round 1 of 2/.test(text)) throw new Error(`Unexpected check progress: ${text}`);
  const fixPrompt = await page.getByLabel('Step 5 prompt').inputValue();
  if (!fixPrompt.includes('FIX ROUND 1') || !fixPrompt.includes('src/api/login.ts')) throw new Error(`Step 5 should be the backend fix round: ${fixPrompt.slice(0, 200)}`);
  if (await page.getByLabel('Step 6 prompt').count()) throw new Error('Only one fix step should have been added.');
  await assertControlsDoNotWrap(page, 'a finished team job with a check');
}

async function verifyCallsMadeByTheTeam() {
  const calls = await readCalls();
  const byRole = (pattern) => calls.filter((call) => pattern.test(call.prompt) && !/orchestrator of a team/.test(call.prompt));
  const [ui] = byRole(/Frontend specialist/);
  const [api] = byRole(/Backend coder/);
  const [security] = byRole(/Security reviewer/);
  const [review] = byRole(/Code reviewer/);
  if (!ui || !api || !security || !review) throw new Error(`A part was never run: ${JSON.stringify(calls.map((call) => call.agent))}`);

  if (ui.agent !== 'claude' || !ui.args.join(' ').includes('--permission-mode acceptEdits')) throw new Error(`Frontend should run on Claude with edit access: ${JSON.stringify(ui.args)}`);
  if (api.agent !== 'codex' || !api.args.join(' ').includes('--sandbox workspace-write')) throw new Error(`Backend should run on Codex with write access: ${JSON.stringify(api.args)}`);
  // Reviewers only read, and they saw what the coders reported.
  if (!security.args.join(' ').includes('--approval-mode plan')) throw new Error(`The security review must be read-only: ${JSON.stringify(security.args)}`);
  if (!security.prompt.includes('Work already done by earlier parts')) throw new Error('The reviewer was not shown the earlier work.');
  if (!security.prompt.includes('Frontend specialist: Login form (claude)') || !security.prompt.includes('Backend coder: Auth endpoint (codex)')) throw new Error('The hand-off should name each earlier part and its agent.');
  if (!security.args.includes('-p') || security.args.join(' ').includes('Security reviewer')) throw new Error('Gemini/Qwen prompts belong on stdin, not in the arguments.');
  // The reviewer the user chose (Qwen) also got its whole multi-line prompt on stdin, and only read.
  if (review.agent !== 'qwen' || !review.args.join(' ').includes('--approval-mode plan')) throw new Error(`The code review should run on Qwen, read-only: ${JSON.stringify(review.args)}`);
  if (!/\n/.test(review.prompt) || !review.prompt.includes('Overall goal:')) throw new Error('A multi-line prompt must reach the agent whole.');
  // The failed check went back to the backend part's own agent, once, with what the check printed.
  const fixes = calls.filter((call) => /FIX ROUND/.test(call.prompt));
  if (fixes.length !== 1 || fixes[0].agent !== 'codex' || !fixes[0].prompt.includes('src/api/login.ts:12:5')) throw new Error(`Expected one backend fix on Codex: ${JSON.stringify(fixes.map((call) => call.agent))}`);
  // Each part starts a new agent session instead of continuing the previous agent's.
  if (calls.some((call) => call.args.includes('--resume') || call.args.includes('resume'))) throw new Error('Team parts must never resume another part\'s session.');
}

/** What the fake orchestrator answers with unless a step changes it. */
function originalPlan() {
  return {
  summary: 'Add a login page and the endpoint it calls.',
  parts: [
    { id: 'ui', title: 'Login form', role: 'frontend', prompt: 'Build the login form in src/ui.', dependsOn: [], paths: ['src/ui'] },
    { id: 'api', title: 'Auth endpoint', role: 'backend', prompt: 'Add POST /login in src/api.', dependsOn: [], paths: ['src/api'] },
  ],
  };
}

/** A team just for this project, with a role of its own: planned with, then removed and refused. */
async function verifyCustomRoleAndProjectTeam(page) {
  await page.getByRole('button', { name: 'Control: Settings', exact: true }).click();
  const card = page.locator('section.settings-section[aria-label="Agent team"]');
  await card.scrollIntoViewIfNeeded();
  await card.getByRole('tab', { name: /^Just Team Smoke Project/ }).click();
  await card.getByText(/uses the team from Settings/).waitFor();
  await card.getByRole('button', { name: 'Create a team for Team Smoke Project' }).click();
  await card.getByRole('button', { name: 'Add a role' }).click();
  await card.getByLabel('custom-new-role name').fill('Database specialist');
  await card.getByLabel('Database specialist agent').selectOption('codex');
  await assertControlsDoNotWrap(page, 'project team with a custom role');
  await page.screenshot({ path: path.join(outputDirectory, 'settings-project-team.png') });
  await card.getByRole('button', { name: 'Save the team for Team Smoke Project' }).click();
  await waitForPage(page, async () => {
    const saved = await window.kaiDesktop.getPreferences('project-team-smoke');
    return saved.ok && saved.data?.agentTeam?.custom?.length === 1;
  }, undefined, { message: 'The project team was not saved.' });

  // Plan with it: the orchestrator now sees the role and may use it, and the plan says whose team it used.
  await writeFile(planFile, JSON.stringify({
    summary: 'Add the orders table.',
    parts: [{ id: 'orders', title: 'Orders table', role: 'custom-new-role', prompt: 'Create the orders table.', dependsOn: [], paths: ['db/'] }],
  }), 'utf8');
  await openWorkflows(page);
  await page.getByLabel('Goal').fill('Add an orders table');
  await page.getByRole('button', { name: /^(Plan the job|Plan again)$/ }).click();
  await page.locator('.team-plan').waitFor({ timeout: 60_000 });
  const first = page.locator('.team-part').first();
  await first.getByText(/Database specialist/).first().waitFor();
  if (await page.getByLabel('Orders table agent').inputValue() !== 'codex') throw new Error('The custom role should run on the agent it was given.');
  await page.getByText(/this project's own team/).waitFor();
  const orchestratorCall = (await readCalls()).filter((call) => /orchestrator of a team/.test(call.prompt)).at(-1);
  if (!orchestratorCall.prompt.includes('"custom-new-role": Database specialist (edits files)')) throw new Error('The orchestrator was not told about the custom role.');
  await assertControlsDoNotWrap(page, 'a plan with a custom role');
  await page.screenshot({ path: path.join(outputDirectory, 'team-plan-custom-role.png') });

  // Remove the project team: the same plan now names a role nobody has, and is refused instead of run.
  await page.getByRole('button', { name: 'Control: Settings', exact: true }).click();
  await card.scrollIntoViewIfNeeded();
  await card.getByRole('tab', { name: /^Just Team Smoke Project/ }).click();
  await card.getByRole('button', { name: 'Use the team from Settings again' }).click();
  await waitForPage(page, async () => {
    const saved = await window.kaiDesktop.getPreferences('project-team-smoke');
    return saved.ok && !saved.data?.agentTeam;
  }, undefined, { message: 'The project team was not removed.' });
  await openWorkflows(page);
  await page.getByLabel('Goal').fill('Add an orders table');
  await page.getByRole('button', { name: /^(Plan the job|Plan again)$/ }).click();
  await page.locator('.rules-error').getByText(/not one of the team's roles/).waitFor({ timeout: 60_000 });

  await writeFile(planFile, JSON.stringify(originalPlan()), 'utf8');
}

/**
 * Two independent parts run at the same time in their own copies of a real git project, their results land in the
 * project, the review runs in the project afterwards, and no copy is left behind.
 */
async function verifySideBySide(page) {
  const gitIn = (...args) => execFileSync('git', ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Smoke', '-c', 'core.autocrlf=false', ...args], { cwd: projectPath, encoding: 'utf8' });
  gitIn('init', '-q');
  gitIn('add', '-A');
  gitIn('commit', '-q', '-m', 'smoke project');
  const goal = 'Build the profile page';
  await writeFile(planFile, JSON.stringify({
    summary: 'A profile card and the endpoint it reads.',
    parts: [
      { id: 'card', title: 'Profile card', role: 'frontend', prompt: 'Build the profile card.', dependsOn: [], paths: ['src/ui'] },
      { id: 'endpoint', title: 'Profile endpoint', role: 'backend', prompt: 'Add GET /profile.', dependsOn: [], paths: ['src/api'] },
    ],
  }), 'utf8');
  const before = (await readCalls()).length;

  await page.getByRole('button', { name: 'Work: Workflows', exact: true }).click();
  await page.locator('section.team-panel').waitFor();
  await page.getByLabel('Goal').fill(goal);
  await page.getByRole('button', { name: /^(Plan the job|Plan again)$/ }).click();
  await page.locator('.team-plan').waitFor({ timeout: 60_000 });
  await page.getByLabel('Run independent parts at the same time').check();
  const order = await page.getByLabel('Run order').innerText();
  if (order !== 'Runs in 2 steps: Profile card + Profile endpoint, then Code review.') throw new Error(`Unexpected run order: ${order}`);
  await assertControlsDoNotWrap(page, 'a plan set to run side by side');
  await assertTogglesCompact(page, 'a plan set to run side by side');
  await page.screenshot({ path: path.join(outputDirectory, 'team-plan-side-by-side.png') });
  await page.getByRole('button', { name: /^Run team/ }).click();

  const finished = await waitForPage(page, async (title) => {
    const runs = await window.kaiDesktop.listWorkflowRuns('project-team-smoke');
    const run = runs.ok ? runs.data.find((candidate) => candidate.workflow.title.includes(title)) : undefined;
    return run && ['completed', 'paused', 'aborted'].includes(run.workflow.status) ? run.workflow : null;
  }, goal, { timeoutMs: 120_000, intervalMs: 500, message: 'The side-by-side run did not finish within two minutes.' });
  if (finished.status !== 'completed') throw new Error(`The side-by-side run ended ${finished.status}: ${finished.notice ?? JSON.stringify(finished.steps.map((step) => [step.id, step.status, step.error]))}`);

  // Both parts ran in separate copies at the same time, and the review ran in the project itself afterwards.
  const calls = (await readCalls()).slice(before).filter((call) => !/orchestrator of a team/.test(call.prompt));
  const card = calls.find((call) => /Your part - Profile card/.test(call.prompt) && !/Code reviewer/.test(call.prompt));
  const endpoint = calls.find((call) => /Your part - Profile endpoint/.test(call.prompt));
  const review = calls.find((call) => /Code reviewer/.test(call.prompt));
  if (!card || !endpoint || !review) throw new Error(`A part did not run: ${JSON.stringify(calls.map((call) => call.agent))}`);
  const sameFolder = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
  if (sameFolder(card.cwd, projectPath) || sameFolder(endpoint.cwd, projectPath) || sameFolder(card.cwd, endpoint.cwd)) {
    throw new Error(`Each part should have worked in its own copy: ${card.cwd} / ${endpoint.cwd}`);
  }
  if (!(card.started < endpoint.ended && endpoint.started < card.ended)) throw new Error('The two parts did not run at the same time.');
  if (!sameFolder(review.cwd, projectPath)) throw new Error(`The review should run in the project: ${review.cwd}`);
  if (review.started < Math.max(card.ended, endpoint.ended)) throw new Error('The review started before the parts were merged.');

  // Both results are in the real project, and git's own history was not touched.
  for (const file of ['src/ui/profile.ts', 'src/api/profile.ts']) {
    const text = await readFile(path.join(projectPath, file), 'utf8');
    if (!text.includes(goal)) throw new Error(`${file} did not reach the project: ${text}`);
  }
  if (gitIn('log', '--oneline').trim().split('\n').length !== 1) throw new Error('The run committed to the user\'s branch.');
  if (gitIn('worktree', 'list').trim().split('\n').length !== 1) throw new Error('A copy of the project was left registered with git.');
  if (existsSync(path.join(tmpdir(), 'kai-parallel', `${finished.id}-wave-1`))) throw new Error('A copy of the project was left on disk.');

  const badges = await page.locator('.workflow-isolated').count();
  if (badges !== 2) throw new Error(`Expected two parts marked as run side by side, saw ${badges}.`);
  await assertControlsDoNotWrap(page, 'a finished side-by-side run');
  await page.screenshot({ path: path.join(outputDirectory, 'team-side-by-side-finished.png') });
  await writeFile(planFile, JSON.stringify(originalPlan()), 'utf8');
}

async function verifyNarrowWindow(page) {
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640));
  await page.getByLabel('Goal').fill(goal);
  await page.getByRole('button', { name: 'Plan the job' }).click();
  await page.locator('.team-plan').waitFor({ timeout: 60_000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (overflow) throw new Error('The team plan overflowed horizontally at 960px.');
  await assertControlsDoNotWrap(page, 'team-plan-960x640');
  await page.screenshot({ path: path.join(outputDirectory, 'team-plan-960x640.png') });
}

async function readCalls() {
  const text = await readFile(callLog, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function withFakeAgentsOnPath(environment) {
  const key = Object.keys(environment).find((name) => name.toLowerCase() === 'path') ?? 'PATH';
  return { ...environment, [key]: `${binDirectory}${path.delimiter}${environment[key] ?? ''}` };
}

async function createFixtures() {
  await mkdir(path.join(projectPath, 'src'), { recursive: true });
  await mkdir(path.join(kimiHome, 'credentials'), { recursive: true });
  await mkdir(binDirectory, { recursive: true });
  await mkdir(userData, { recursive: true });
  await writeFile(path.join(projectPath, 'src', 'app.ts'), 'export const app = "team smoke";\n', 'utf8');
  // The team's check: it fails, naming a backend file, until a fake agent has run a "fix round" (which drops .fixed).
  await writeFile(path.join(projectPath, 'check.js'), [
    "const fs = require('node:fs');",
    "if (fs.existsSync('.fixed')) process.exit(0);",
    "console.log('FAIL src/api/login.test.ts');",
    "console.log('    at src/api/login.ts:12:5');",
    'process.exit(1);',
  ].join('\n'), 'utf8');
  await writeFile(path.join(kimiHome, 'credentials', 'kimi-code.json'), '{}', 'utf8');
  await writeFile(planFile, JSON.stringify(originalPlan()), 'utf8');
  await writeFile(path.join(binDirectory, 'fake-cli.mjs'), fakeCliSource(), 'utf8');
  for (const agent of ['claude', 'codex', 'qwen', 'gemini', 'kimi']) {
    if (process.platform === 'win32') {
      await writeFile(path.join(binDirectory, `${agent}.cmd`), `@echo off\r\n"${process.execPath}" "${path.join(binDirectory, 'fake-cli.mjs')}" ${agent} %*\r\n`, 'utf8');
    } else {
      await writeFile(path.join(binDirectory, agent), `#!/bin/sh\nexec "${process.execPath}" "${path.join(binDirectory, 'fake-cli.mjs')}" ${agent} "$@"\n`, { mode: 0o755 });
    }
  }
  const now = new Date().toISOString();
  const project = { schemaVersion: 1, id: 'project-team-smoke', name: 'Team Smoke Project', path: projectPath, createdAt: now, lastOpenedAt: now };
  const auto = { assignee: 'auto', route: 'auto', instructions: '' };
  const settings = {
    schemaVersion: 1,
    defaultAgent: 'codex',
    defaultRoute: 'direct',
    defaultAutonomy: 'ask',
    theme: 'dark',
    activeProjectId: project.id,
    projectOrder: [project.id],
    windowBounds: null,
    logRetentionEntries: 2000,
    diagnosticsEnabled: true,
    directApi: { enabled: false, provider: 'openai', model: '', baseUrl: 'https://api.openai.com/v1', credentialId: 'provider.openai' },
    learningTutor: { enabled: false, provider: 'openai', model: 'gpt-6-astra', baseUrl: 'https://api.openai.com/v1', credentialId: 'provider.openai' },
    editor: { autoSave: false, autoSaveDelayMs: 800 },
    mcpServers: [],
    cognitive1: { enabled: false, endpoint: 'http://127.0.0.1:9876', dataPath: null },
    proxy: { enabled: false, port: 8082, targetBaseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-chat', credentialId: 'provider.deepseek' },
    agentTeam: {
      preset: 'balanced',
      roles: {
        orchestrator: { assignee: 'codex', route: 'direct', instructions: '' },
        frontend: auto,
        backend: auto,
        tests: auto,
        securityReviewer: auto,
        codeReviewer: auto,
        docs: auto,
      },
    },
    setupCompletedAt: now,
  };
  await writeFile(path.join(userData, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  await writeFile(path.join(userData, 'projects.json'), `${JSON.stringify({ schemaVersion: 1, projects: [project] }, null, 2)}\n`, 'utf8');
}

// One script stands in for all five CLIs. It answers the version and sign-in probes, records every real run
// (arguments and prompt) to FAKE_LOG, and replies in the format the real CLI would use.
function fakeCliSource() {
  return `
import fs from 'node:fs';
const [agent, ...args] = process.argv.slice(2);
const done = (text, code = 0) => { console.log(text); process.exit(code); };
if (args.includes('--version')) done('fake-' + agent + ' 1.0.0');
if (agent === 'codex' && args[0] === 'login' && args[1] === 'status') done('Logged in using ChatGPT');
if (agent === 'claude' && args[0] === 'auth' && args[1] === 'status') done(JSON.stringify({ loggedIn: true }));
if (agent === 'qwen' && args[0] === 'auth' && args[1] === 'status') done('=== Authentication Status ===\\nStatus: configured');
if (agent === 'gemini' && args[0] === '--list-sessions') done('[]');
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  const prompt = agent === 'kimi' ? (args[args.indexOf('-p') + 1] ?? '') : stdin;
  const started = Date.now();
  // The profile parts write a real file where they run, and take a moment, so running side by side is visible.
  const profileFiles = { 'Profile card': 'src/ui/profile.ts', 'Profile endpoint': 'src/api/profile.ts' };
  const part = (/Your part - ([^:\\n]*)/.exec(prompt) ?? [])[1];
  if (part && profileFiles[part] && !/Code reviewer/.test(prompt)) {
    const goal = (/Overall goal: (.*)/.exec(prompt) ?? [])[1] ?? '';
    fs.mkdirSync(profileFiles[part].split('/').slice(0, -1).join('/'), { recursive: true });
    fs.writeFileSync(profileFiles[part], '// ' + goal + '\\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  }
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ agent, args, prompt, cwd: process.cwd(), started, ended: Date.now() }) + '\\n');
  // A fix round repairs what the project's check was complaining about.
  if (/FIX ROUND/.test(prompt)) fs.writeFileSync('.fixed', '1');
  let reply;
  if (/orchestrator of a team|previous reply could not be used/.test(prompt)) reply = fs.readFileSync(process.env.FAKE_PLAN, 'utf8');
  else if (/Security reviewer/.test(prompt)) reply = 'Reviewed every change.\\n' + process.env.FAKE_VERDICT;
  else if (/Code reviewer/.test(prompt)) reply = 'Looks correct.';
  else reply = 'Done: ' + ((/Your part - ([^:\\n]*)/.exec(prompt) ?? [])[1] ?? 'the task');
  const line = (value) => console.log(JSON.stringify(value));
  if (agent === 'codex') {
    line({ type: 'thread.started', thread_id: 'fake-thread' });
    line({ type: 'item.completed', item: { type: 'agent_message', text: reply } });
  } else if (agent === 'claude') {
    line({ type: 'result', result: reply, session_id: 'fake-claude' });
  } else if (agent === 'qwen') {
    line({ type: 'assistant', session_id: 'fake-qwen', message: { content: [{ type: 'text', text: reply }] } });
    line({ type: 'result', session_id: 'fake-qwen', result: reply });
  } else if (agent === 'gemini') {
    line({ type: 'init', session_id: 'fake-gemini' });
    line({ type: 'message', role: 'assistant', content: reply, delta: true });
    line({ type: 'result', status: 'success' });
  } else {
    line({ role: 'assistant', content: reply });
  }
});
`;
}
