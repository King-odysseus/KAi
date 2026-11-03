// Drives KAI Remote the way a phone would: a real browser against the real gateway, over the built
// phone bundle, paired with the token the desktop mints. The seeded conversation is a workflow that
// is mid-run, so the console has something true to show rather than an empty state.
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, chromium } from '@playwright/test';
import { waitForPage } from './smoke-helpers.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(appRoot, 'test-results', 'smoke-mobile');
const mobileBundle = path.join(appRoot, 'out', 'renderer', 'mobile', 'index.html');
const userData = await mkdtemp(path.join(tmpdir(), 'kai-mobile-smoke-'));
const conversationsDirectory = path.join(userData, 'conversations');
const projectPath = path.join(userData, 'sample-project');
const projectId = 'project-mobile-smoke';
const runTitle = 'Ship the onboarding flow';
const runId = 'workflow-mobile-smoke';
const secondRunTitle = 'Tidy the test fixtures';
/** The seeded conversation, as the Workspace list and the thread screen know it. */
const conversationTitle = `Workflow: ${runTitle}`;
const firstTurnText = 'Rewrite the onboarding flow as three steps.';
const lastTurnText = 'Read the onboarding component and mapped it onto three steps.';
/** A ready card, so the phone has something it is allowed to hold, and a card behind it. */
const readyCardTitle = 'Build the onboarding page';
const readyCardId = 'card-onboarding-page';
const backlogCardTitle = 'Wire the invite email';
const electronExecutable = createRequire(import.meta.url)('electron');
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...launchEnvironment } = process.env;
const desktopErrors = [];
const phoneErrors = [];
let electronApp;
let browser;

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

if (!(await exists(mobileBundle))) {
  throw new Error(`The phone bundle is missing. Run \`npm run desktop:build\` first (looked for ${mobileBundle}).`);
}

const port = await freePort();
await seedDesktop();

try {
  electronApp = await electron.launch({
    args: [appRoot],
    cwd: appRoot,
    executablePath: electronExecutable,
    env: { ...launchEnvironment, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true', KAI_DESKTOP_USER_DATA: userData, KAI_DESKTOP_NOTIFICATIONS: 'off' },
    timeout: 30_000,
  });
  const desktop = await electronApp.firstWindow();
  desktop.on('pageerror', (error) => desktopErrors.push(error.stack ?? error.message));

  const status = await gatewayStatus(desktop, port);
  const token = await pairingToken(desktop, status.urls);
  console.log(`KAI Remote is listening on ${status.urls[0]} with ${status.connectedClients} phone(s) attached.`);

  browser = await chromium.launch();
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }).then((context) => context.newPage());
  phone.on('pageerror', (error) => phoneErrors.push(error.stack ?? error.message));

  const origin = `http://127.0.0.1:${port}`;
  await verifyPairingGate(phone, origin);
  await verifyTokenEntry(phone, origin, token);
  await verifyConsole(phone, origin, token);
  await verifyPushesReachThePhone(phone, origin, token, desktop);
  await verifyRunDetail(phone);
  await verifyWorkflowsTab(phone);
  await verifyWorkspaceTab(phone);
  await verifyProjectsTab(phone);
  await verifyStudioTab(phone);
  await verifyTasksTab(phone);
  await verifyThemeSwitch(phone);
  await verifyGatewayRefusals(phone, token);

  await phone.screenshot({ path: path.join(outputDirectory, 'phone-needs-you.png') });
  if (desktopErrors.length > 0) throw new Error(`Desktop renderer errors: ${desktopErrors.join(' | ')}`);
  if (phoneErrors.length > 0) throw new Error(`Phone renderer errors: ${phoneErrors.join(' | ')}`);
  console.log(`KAI mobile smoke passed. Screenshots: ${outputDirectory}`);
} catch (error) {
  if (desktopErrors.length > 0) console.error(`Desktop renderer errors: ${desktopErrors.join(' | ')}`);
  if (phoneErrors.length > 0) console.error(`Phone renderer errors: ${phoneErrors.join(' | ')}`);
  for (const [index, page] of [...(electronApp?.windows() ?? []), ...(browser?.contexts().flatMap((context) => context.pages()) ?? [])].entries()) {
    await page.screenshot({ path: path.join(outputDirectory, `failure-${index + 1}.png`) }).catch(() => undefined);
    console.error(`Page ${index + 1} (${page.url()}) body:\n${await page.locator('body').innerText().catch(() => '<body unavailable>')}`);
  }
  throw error;
} finally {
  await browser?.close().catch(() => undefined);
  await electronApp?.close().catch(() => undefined);
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
}

/** The gateway reports itself the way Settings shows it, so a phone and the desktop agree on the facts. */
async function gatewayStatus(desktop, expectedPort) {
  // The window exists before the preload bridge does, so a call placed too early has nothing to call.
  await waitForPage(desktop, () => Boolean(window.kaiDesktop), undefined, { message: 'The desktop preload bridge never appeared.' });
  return waitForPage(
    desktop,
    async (parsedPort) => {
      const response = await window.kaiDesktop.remoteStatus();
      // A port already in use leaves the setting saved and the gateway down; retrying would never help.
      if (response.ok && response.data.lastError) throw new Error(`KAI Remote did not listen: ${response.data.lastError}`);
      if (!response.ok || !response.data.running) return null;
      return response.data;
    },
    expectedPort,
    { message: 'KAI Remote never started listening.' },
  ).then((status) => {
    if (status.port !== expectedPort) throw new Error(`KAI Remote bound port ${status.port}, not ${expectedPort}.`);
    if (status.lanEnabled) throw new Error('Loopback-only is the default; the smoke never asked for LAN.');
    if (status.urls[0] !== `http://127.0.0.1:${expectedPort}`) throw new Error(`Unexpected remote URL: ${status.urls[0]}`);
    // The panel shows this so the user can read the address to type on the phone, so it has to be the
    // private address and never the loopback one the gateway is bound to here.
    if (status.lanUrl !== null && !/^http:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(status.lanUrl)) {
      throw new Error(`The phone address is not a private network address: ${status.lanUrl}`);
    }
    if (!status.tokenSet) throw new Error('The gateway started without minting a token.');
    return status;
  });
}

/** Pairs the way the user does: the desktop gives this phone its own token, naming it as it goes. */
async function pairingToken(desktop, urls) {
  const paired = await desktop.evaluate(async () => window.kaiDesktop.pairRemoteDevice('Smoke phone'));
  if (!paired.ok || !paired.data.token) throw new Error(`Could not pair a device: ${JSON.stringify(paired)}`);
  if (paired.data.token.length < 16) throw new Error('The pairing token is too short to be the real thing.');
  if (paired.data.urls[0] !== urls[0]) throw new Error('The pairing link and the status disagree about the address.');
  // The device list is what the Settings panel shows, so it has to know about the phone just paired.
  const devices = await desktop.evaluate(async () => window.kaiDesktop.remoteDevices());
  if (!devices.ok || !devices.data.some((device) => device.label === 'Smoke phone')) {
    throw new Error(`The paired device is not listed: ${JSON.stringify(devices)}`);
  }
  return paired.data.token;
}

/** Without the token the console must refuse to show anything, rather than half-render stale data. */
async function verifyPairingGate(phone, origin) {
  await phone.goto(`${origin}/mobile/`, { waitUntil: 'domcontentloaded' });
  await phone.getByRole('heading', { name: 'Pair this phone' }).waitFor({ timeout: 15_000 });
  if (await phone.getByRole('heading', { name: 'Needs you' }).count() > 0) {
    throw new Error('The console rendered its data without a pairing token.');
  }
}

/**
 * An installed app opens at `/mobile/` with no token and no address bar, and its own storage — so the
 * link it was paired from in a browser is not something it can be opened *with*. Pasting is that way in.
 */
async function verifyTokenEntry(phone, origin, token) {
  await phone.goto(`${origin}/mobile/`, { waitUntil: 'domcontentloaded' });
  await phone.getByRole('heading', { name: 'Pair this phone' }).waitFor({ timeout: 15_000 });

  const field = phone.getByPlaceholder('Paste the pairing link or token');
  // Rubbish is refused rather than stored, so a bad paste cannot look like a rejected token.
  await field.fill('not a pairing link');
  await phone.getByRole('button', { name: 'Pair', exact: true }).click();
  await phone.getByText('That is not a pairing link or token.', { exact: false }).waitFor();
  if (await phone.getByRole('heading', { name: 'Needs you' }).count() > 0) {
    throw new Error('A non-token paired the phone.');
  }

  // The real link, pasted instead of opened: the page stores it and reloads into the console.
  await field.fill(`${origin}/mobile/?token=${token}`);
  await phone.getByRole('button', { name: 'Pair', exact: true }).click();
  await phone.getByRole('heading', { name: 'Needs you' }).waitFor({ timeout: 15_000 });
  await phone.screenshot({ path: path.join(outputDirectory, 'phone-paired-by-paste.png') });
}

async function verifyConsole(phone, origin, token) {
  await phone.goto(`${origin}/mobile/?token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' });
  await phone.getByRole('heading', { name: 'Needs you' }).waitFor({ timeout: 15_000 });

  // The token is taken out of the address bar as soon as it is read, so it does not linger in history.
  const address = new URL(phone.url());
  if (address.searchParams.has('token')) throw new Error(`The pairing token stayed in the address bar: ${phone.url()}`);
  if (address.pathname !== '/mobile/') throw new Error(`The phone did not land on its own page: ${phone.url()}`);

  // Traffic goes to the same origin the page came from, so a phone cannot pair and then talk elsewhere.
  await phone.getByText('Desktop', { exact: true }).waitFor({ timeout: 15_000 });

  await phone.getByText(runTitle, { exact: true }).waitFor();
  await phone.getByText('Sample Project · codex · step 2 of 3', { exact: true }).waitFor();
  await phone.locator('.chip.run', { hasText: 'Running' }).first().waitFor();
  if (await phone.getByText('Waiting on you').count() > 0) throw new Error('A running workflow was listed as waiting on the user.');
  if ((await phone.locator('.tab .badge').count()) > 0) throw new Error('An alert badge appeared with nothing to alert about.');
  // The card carries a plain progress bar; the segmented per-step bar belongs to the detail screen.
  const progress = await phone.locator('.card.live .bar > i').first().getAttribute('style');
  if (!/width:\s*33/.test(progress ?? '')) throw new Error(`One finished step of three did not read as a third: ${progress}`);
  await phone.screenshot({ path: path.join(outputDirectory, 'phone-runs-list.png') });
}

/**
 * The point of the live stream, in the app's own terms: a workflow the phone did not know about, and
 * the phone only learns of it when the desktop pushes. A 20s poll would eventually find it too, so the
 * checks run early — well before the first tick — and the same frame is also read off a raw
 * `EventSource`, which is what proves the delivery rather than the refresh that followed it.
 */
async function verifyPushesReachThePhone(phone, origin, token, desktop) {
  await phone.evaluate((streamToken) => {
    window.__kaiFrames = [];
    const source = new EventSource(`/api/events?token=${encodeURIComponent(streamToken)}`);
    source.addEventListener('app:shared-state', (event) => window.__kaiFrames.push(JSON.parse(event.data)));
    window.__kaiStream = source;
  }, token);

  await writeFile(path.join(conversationsDirectory, 'conv-mobile-smoke-second.json'), `${JSON.stringify(seedSecondRun(), null, 2)}\n`, 'utf8');
  if (await phone.getByText(secondRunTitle).count() > 0) {
    throw new Error('The phone showed a run that was only on disk, before any push told it to look.');
  }

  const saved = await desktop.evaluate(async () => {
    const current = await window.kaiDesktop.bootstrap();
    if (!current.ok) throw new Error(current.error.message);
    return window.kaiDesktop.updateSettings({ logRetentionEntries: current.data.settings.logRetentionEntries + 1 });
  });
  if (!saved.ok) throw new Error(`The desktop could not save a setting: ${saved.error.message}`);

  const frame = await waitForPage(
    phone,
    () => window.__kaiFrames[0] ?? null,
    undefined,
    { message: 'No app:shared-state frame reached the browser over the live stream.' },
  );
  // A settings save is addressed to every window, so the phone sees it with no window of its own.
  if (frame.windowId !== null) throw new Error(`A broadcast frame carried window ${frame.windowId}.`);
  if (typeof frame.seq !== 'number') throw new Error(`A stream frame arrived without a sequence: ${JSON.stringify(frame)}`);
  const projects = frame.payload?.projects;
  if (!Array.isArray(projects) || !projects.some((project) => project.id === projectId)) {
    throw new Error(`The pushed shared state did not carry the projects: ${JSON.stringify(frame.payload)}`);
  }

  // The same push made the console re-read: a run it had never seen is now on the screen.
  await phone.getByText(secondRunTitle).waitFor({ timeout: 15_000 });
  await phone.getByText(runTitle).waitFor();
  await phone.screenshot({ path: path.join(outputDirectory, 'phone-after-push.png') });
}

async function verifyRunDetail(phone) {
  await phone.getByText(runTitle, { exact: true }).click();
  await phone.getByRole('heading', { name: runTitle }).waitFor();
  await phone.getByText('2 / 3', { exact: true }).waitFor();
  await phone.getByText('Survey', { exact: true }).waitFor();
  await phone.getByText('Rewrite', { exact: true }).waitFor();
  await phone.getByText('Verify', { exact: true }).waitFor();
  const dots = await phone.locator('.step-dot').evaluateAll((nodes) => nodes.map((node) => node.className));
  if (dots.join(',') !== 'step-dot completed,step-dot running,step-dot pending') {
    throw new Error(`The step list does not show the run's real steps: ${dots.join(',')}`);
  }
  const segments = await phone.locator('.detail-head .steps > i').evaluateAll((nodes) => nodes.map((node) => node.className));
  if (segments.join(',') !== 'done,now,') throw new Error(`The step bar does not show the run's progress: ${segments.join(',')}`);
  await phone.getByText('Copied the onboarding component into notes.', { exact: true }).waitFor();
  // The composer is a bar on the detail screen, not a screen of its own, and it is the only way to send
  // work from the phone — so its absence is worth failing over, quietly, here.
  await phone.locator('.composer .send input').waitFor();
  await phone.locator('.composer .verb', { hasText: 'Retry the last step' }).waitFor();
  await phone.screenshot({ path: path.join(outputDirectory, 'phone-run-detail.png') });

  // The run was opened from Needs you, so the back label has to name that section and land there — the
  // label is read off the tab, not guessed from the run.
  await phone.getByRole('button', { name: '‹ Needs you' }).click();
  await phone.getByRole('heading', { name: 'Needs you' }).waitFor();
}

async function verifyWorkflowsTab(phone) {
  await phone.locator('.tab', { hasText: 'Workflows' }).click();
  await phone.getByRole('heading', { name: 'Workflows' }).waitFor();
  await phone.getByRole('button', { name: 'All projects' }).waitFor();
  if (!(await phone.getByRole('button', { name: 'All projects' }).getAttribute('class'))?.includes('on')) {
    throw new Error('The Workflows screen did not start on every project.');
  }
  await phone.getByRole('button', { name: 'Sample Project', exact: true }).click();
  await phone.getByText(runTitle, { exact: true }).waitFor();
  await phone.getByText(secondRunTitle, { exact: true }).waitFor();
  await phone.screenshot({ path: path.join(outputDirectory, 'phone-workflows-tab.png') });
}

/**
 * The Workspace, which is the desktop's workspace as a phone can hold it: the threads, and one opened so
 * a turn can be sent into it. The list and the thread are both asserted, because the thread's composer is
 * the only way to continue a conversation that is not a run.
 */
async function verifyWorkspaceTab(phone) {
  await phone.locator('.tab', { hasText: 'Workspace' }).click();
  await phone.getByRole('heading', { name: 'Workspace' }).waitFor({ timeout: 15_000 });
  await phone.getByText(conversationTitle, { exact: true }).waitFor({ timeout: 15_000 });
  // The list read is a summary (it deliberately omits turns), so the row points into the thread rather than
  // pretending to quote a last line it does not have.
  // More than one history row can share the summary line; either proves the list renders.
  await phone.getByText('Open to read thread', { exact: true }).first().waitFor();
  await phone.screenshot({ path: path.join(outputDirectory, 'phone-workspace.png') });

  await phone.getByText(conversationTitle, { exact: true }).click();
  await phone.getByRole('heading', { name: conversationTitle }).waitFor({ timeout: 15_000 });
  await phone.getByText(firstTurnText, { exact: true }).waitFor();
  await phone.getByText(lastTurnText, { exact: true }).waitFor();
  // A conversation that is a run links to the run, and the composer is here either way.
  await phone.getByText('Open the run', { exact: true }).waitFor();
  await phone.locator('.composer .send input').waitFor();
  await phone.getByRole('button', { name: '‹ Workspace' }).click();
  await phone.getByRole('heading', { name: 'Workspace' }).waitFor();
}

/** The project list, and the one thing a project card does: open that project's Studio board. */
async function verifyProjectsTab(phone) {
  await phone.locator('.tab', { hasText: 'Projects' }).click();
  await phone.getByRole('heading', { name: 'Projects' }).waitFor({ timeout: 15_000 });
  await phone.getByText('Sample Project', { exact: true }).waitFor();
  await phone.getByText(projectPath, { exact: true }).waitFor();
  await phone.screenshot({ path: path.join(outputDirectory, 'phone-projects.png') });

  await phone.getByText('Sample Project', { exact: true }).click();
  await phone.getByRole('heading', { name: 'Studio' }).waitFor();
  // The card, not the column count: which column it sits in changes when the Studio check claims it.
  await phone.getByText(readyCardTitle, { exact: true }).waitFor({ timeout: 15_000 });
}

/**
 * Tasks come from the C1 brain, and the smoke's brain is deliberately off — so this is the failure path
 * asserted, not the happy one: the section has to say what is wrong rather than crash or hang. The
 * channel behind it is checked for real in the gateway probe, which is where being refused would show up.
 */
async function verifyTasksTab(phone) {
  await phone.locator('.tab', { hasText: 'Tasks' }).click();
  await phone.getByRole('heading', { name: 'Tasks' }).waitFor({ timeout: 15_000 });
  await phone.getByText('Could not read the task board', { exact: true }).waitFor({ timeout: 15_000 });
  await phone.screenshot({ path: path.join(outputDirectory, 'phone-tasks.png') });
}

/**
 * The theme switch, which every section's top bar carries. It is a real setting: tapping it recolours
 * the page, and the choice is the phone's own, so it has to outlive a reload the way the token does.
 */
async function verifyThemeSwitch(phone) {
  const started = await phone.evaluate(() => document.documentElement.dataset.theme);
  if (started !== 'purple') throw new Error(`The console did not start on its default theme (got ${started}).`);
  const before = await phone.evaluate(() => getComputedStyle(document.body).backgroundColor);

  await phone.getByRole('button', { name: /^Theme:/ }).click();
  await phone.getByRole('button', { name: /^Theme: Light/ }).waitFor({ timeout: 5_000 });
  const cycled = await phone.evaluate(() => document.documentElement.dataset.theme);
  if (cycled !== 'light') throw new Error(`Tapping the theme switch did not change the theme (got ${cycled}).`);
  const after = await phone.evaluate(() => getComputedStyle(document.body).backgroundColor);
  if (after === before) throw new Error('The theme changed its name but not the page colour.');
  await phone.screenshot({ path: path.join(outputDirectory, 'phone-theme-light.png') });

  // A reload is the whole reconnect; the theme has to come back with the token, or it is not a setting.
  await phone.reload();
  await phone.locator('.tabs').waitFor({ timeout: 15_000 });
  const kept = await phone.evaluate(() => document.documentElement.dataset.theme);
  if (kept !== 'light') throw new Error(`The theme did not survive a reload (got ${kept}).`);

  // Leave it as it ships, so the screenshots taken after this read the default.
  await phone.evaluate(() => window.localStorage.removeItem('kai-remote-theme'));
  await phone.reload();
  await phone.locator('.tabs').waitFor({ timeout: 15_000 });
  const reset = await phone.evaluate(() => document.documentElement.dataset.theme);
  if (reset !== 'purple') throw new Error(`Removing the stored theme did not fall back to the default (got ${reset}).`);
}

/**
 * The Studio tab, and the one write the phone has on it. Holding a card is the whole write surface here, so
 * it is done for real: the assertion is that the card the desktop reads afterwards is the one the phone
 * moved, not merely that the screen redrew.
 */
async function verifyStudioTab(phone) {
  // Named by its tab rather than by role name: a run card can carry the word "Studio" in its text.
  await phone.locator('.tab', { hasText: 'Studio' }).click();
  await phone.getByRole('heading', { name: 'Studio' }).waitFor({ timeout: 15_000 });
  await phone.getByText('Ready · 1', { exact: true }).waitFor({ timeout: 15_000 });
  await phone.getByText('Backlog · 1', { exact: true }).waitFor();

  // A column's cards sit inside one wrapper, so the column itself has to space them. Measured off the
  // page: the head and the first card must not be touching, or the cards ran together the way Tasks did.
  const columnGap = await phone.evaluate(() => {
    const stack = document.querySelector('.stack');
    const children = stack ? [...stack.children] : [];
    if (children.length < 2) return null;
    return Math.round(children[1].getBoundingClientRect().top - children[0].getBoundingClientRect().bottom);
  });
  if (columnGap === null || columnGap < 8) {
    throw new Error(`Cards in a board column are not spaced apart (gap ${columnGap}px).`);
  }
  // A card the phone is not allowed to hold is shown without the hold button, so the rule is visible.
  await phone.getByText(backlogCardTitle, { exact: true }).click();
  await phone.getByRole('heading', { name: backlogCardTitle }).waitFor();
  if (await phone.getByRole('button', { name: /^Hold for / }).count() > 0) {
    throw new Error('A backlog card offered to be held; only a ready card may be claimed.');
  }
  await phone.getByRole('button', { name: 'Close' }).click();

  await phone.getByText(readyCardTitle, { exact: true }).click();
  await phone.getByRole('heading', { name: readyCardTitle }).waitFor();
  await phone.getByRole('button', { name: 'Hold for codex' }).click();
  await phone.getByRole('heading', { name: readyCardTitle }).waitFor({ state: 'detached' });
  await phone.getByText('In progress · 1', { exact: true }).waitFor({ timeout: 15_000 });
  await phone.getByText('Held by codex', { exact: true }).waitFor();
  await phone.screenshot({ path: path.join(outputDirectory, 'phone-board.png') });

  await phone.locator('.tab', { hasText: 'Needs you' }).click();
  await phone.getByRole('heading', { name: 'Needs you' }).waitFor();
}

/** Default-deny, checked from the phone's own origin rather than from a unit test's fake request. */
async function verifyGatewayRefusals(phone, token) {
  const probes = await phone.evaluate(async (streamToken) => {
    const call = (channel, extra = {}) => fetch('/api/ipc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${streamToken}` },
      body: JSON.stringify({ channel, input: { ...extra } }),
    });
    const status = await fetch(`/api/status?token=${encodeURIComponent(streamToken)}`);
    // A valid token and a channel that is not on the allowlist: this is the deny the whole design turns on.
    const denied = await call('terminal:start', { projectId: 'x' });
    const deniedWrite = await call('files:write', { path: 'x', content: '' });
    // The generic brain door is the one the phone's task board deliberately does not use, so a stolen
    // token must not reach it even though its narrow read is allowed.
    const deniedBrain = await call('cognitive1:operation', { operation: 'tasks', payload: {} });
    const deniedPrune = await call('cognitive1:operation', { operation: 'brain-prune', payload: { execute: true } });
    // The narrow read itself, which the Tasks section depends on: refused here would be a 403, not a
    // failure to reach the brain, and the two are indistinguishable from the screen alone.
    const tasksStatus = (await call('remote:tasks', {})).status;
    // No token at all, so the gate has to refuse before it looks at the channel.
    const unauthenticated = await fetch('/api/ipc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'services:status', input: {} }),
    });
    const nonGet = await fetch('/api/ipc', { headers: { authorization: `Bearer ${streamToken}` } });
    // A traversal that survives URL normalisation: the separator stays percent-encoded.
    const traversal = await fetch('/mobile/..%2f..%2fpackage.json');
    const body = await traversal.text();
    const workbench = await fetch('/index.html');
    return {
      queryTokenStatus: status.status,
      deniedStatus: denied.status,
      deniedWriteStatus: deniedWrite.status,
      deniedBrainStatus: deniedBrain.status,
      deniedPruneStatus: deniedPrune.status,
      tasksStatus,
      unauthenticatedStatus: unauthenticated.status,
      nonGetStatus: nonGet.status,
      traversalStatus: traversal.status,
      traversalBody: body.slice(0, 200),
      workbenchStatus: workbench.status,
    };
  }, token);

  // The query token is accepted on the event stream only, because EventSource cannot set a header.
  if (probes.queryTokenStatus !== 401) throw new Error(`A query token was accepted on /api/status (${probes.queryTokenStatus}).`);
  if (probes.deniedStatus !== 403) throw new Error(`A channel off the allowlist answered ${probes.deniedStatus}, not 403.`);
  if (probes.deniedWriteStatus !== 403) throw new Error(`A write off the allowlist answered ${probes.deniedWriteStatus}, not 403.`);
  // The phone's task board is a narrow read of the brain, not the generic operation door it is built on.
  if (probes.deniedBrainStatus !== 403) throw new Error(`The generic brain operation answered ${probes.deniedBrainStatus}, not 403.`);
  if (probes.deniedPruneStatus !== 403) throw new Error(`brain-prune answered ${probes.deniedPruneStatus}, not 403.`);
  // 403 is the one answer that means the channel itself is missing; the brain being off is a 200 with an
  // error inside it, which is what this smoke's desktop has.
  if (probes.tasksStatus === 403) throw new Error('The phone\'s task read is not on the allowlist.');
  if (probes.unauthenticatedStatus !== 401) throw new Error(`A request with no token answered ${probes.unauthenticatedStatus}, not 401.`);
  if (probes.nonGetStatus !== 404) throw new Error(`A bodyless GET on /api/ipc answered ${probes.nonGetStatus}, not 404.`);
  if (probes.traversalStatus !== 404) throw new Error(`A path traversal answered ${probes.traversalStatus}, not 404.`);
  if (probes.traversalBody.includes('"name"')) throw new Error('A path traversal handed back a file outside the published bundle.');
  // The desktop's own page lives in the same build directory and must not be published with the phone.
  if (probes.workbenchStatus !== 404) throw new Error(`The desktop page was served to the phone (${probes.workbenchStatus}).`);
}

async function seedDesktop() {
  await mkdir(path.join(projectPath, 'src'), { recursive: true });
  await mkdir(conversationsDirectory, { recursive: true });
  await writeFile(path.join(projectPath, 'src', 'onboarding.tsx'), 'export const steps = [];\r\n', 'utf8');
  const now = new Date().toISOString();
  const project = { schemaVersion: 1, id: projectId, name: 'Sample Project', path: projectPath, createdAt: now, lastOpenedAt: now };
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
    remote: { enabled: true, lanEnabled: false, port },
    setupCompletedAt: now,
  };
  await writeFile(path.join(userData, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  await writeFile(path.join(userData, 'projects.json'), `${JSON.stringify({ schemaVersion: 1, projects: [project] }, null, 2)}\n`, 'utf8');
  await writeFile(path.join(conversationsDirectory, 'conv-mobile-smoke.json'), `${JSON.stringify(seedRun(), null, 2)}\n`, 'utf8');
  const spec = path.join(projectPath, '.kai', 'spec');
  await mkdir(spec, { recursive: true });
  await writeFile(path.join(spec, 'board.json'), `${JSON.stringify(seedBoard(), null, 2)}\n`, 'utf8');
}

/** A board with one card the phone may hold and one it may not, so a claim is a real rule and not a formality. */
function seedBoard() {
  return {
    schemaVersion: 1,
    cards: [
      card(readyCardId, readyCardTitle, { status: 'ready', acceptance: ['Three steps, no dead ends'] }),
      card('card-invite-email', backlogCardTitle, { status: 'backlog' }),
    ],
  };
}

function card(id, title, extra) {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  return {
    id,
    title,
    kind: 'page',
    story: '',
    acceptance: [],
    prompt: '',
    designRef: null,
    route: '',
    dependsOn: [],
    needsArtifacts: [],
    status: 'backlog',
    checks: [],
    check: null,
    runs: [],
    notes: '',
    stale: false,
    staleReason: null,
    claimedBy: null,
    createdAt: at,
    updatedAt: at,
    ...extra,
  };
}

/** A workflow mid-run: one step done, one running, one still to come. */
function seedRun() {
  const base = Date.now() - 600_000;
  const at = (offset) => new Date(base + offset).toISOString();
  return {
    schemaVersion: 1,
    id: 'conv-mobile-smoke',
    projectId,
    title: `Workflow: ${runTitle}`,
    createdAt: at(0),
    updatedAt: at(599_000),
    archived: false,
    unread: false,
    activeAgent: 'codex',
    route: 'direct',
    autonomy: 'ask',
    // Two turns, so the Workspace list has a real last line to read and the thread has something to open.
    turns: [
      { id: 'turn-mobile-smoke-1', role: 'user', text: 'Rewrite the onboarding flow as three steps.', createdAt: at(0) },
      { id: 'turn-mobile-smoke-2', role: 'assistant', text: 'Read the onboarding component and mapped it onto three steps.', createdAt: at(150_000) },
    ],
    events: [],
    workflow: {
      id: runId,
      title: runTitle,
      steps: [
        step('step-survey', 'claude', 'Survey', 'Read the current onboarding code and list what it does.', {
          status: 'completed',
          output: 'Copied the onboarding component into notes.',
          startedAt: at(0),
          completedAt: at(180_000),
        }),
        step('step-rewrite', 'codex', 'Rewrite', 'Rewrite the onboarding flow as three steps.', {
          status: 'running',
          startedAt: at(180_000),
        }),
        step('step-verify', 'claude', 'Verify', 'Run the test suite and report what fails.', { status: 'pending' }),
      ],
      execution: 'cli',
      route: 'direct',
      autonomy: 'ask',
      loop: { enabled: false, maxRounds: 3, maxCostUsd: 0, maxDurationMinutes: 30, checkCommand: '' },
      status: 'running',
      currentStepIndex: 1,
      createdAt: at(0),
    },
  };
}

/** A second, finished run, written to disk while the phone is already open. */
function seedSecondRun() {
  const base = Date.now() - 3_600_000;
  const at = (offset) => new Date(base + offset).toISOString();
  return {
    schemaVersion: 1,
    id: 'conv-mobile-smoke-second',
    projectId,
    title: `Workflow: ${secondRunTitle}`,
    createdAt: at(0),
    updatedAt: at(900_000),
    archived: false,
    unread: false,
    activeAgent: 'claude',
    route: 'direct',
    autonomy: 'plan',
    turns: [],
    events: [],
    workflow: {
      id: 'workflow-mobile-smoke-second',
      title: secondRunTitle,
      steps: [step('step-tidy', 'claude', 'Tidy', 'Group the fixtures by feature.', { status: 'completed', output: 'Fixtures grouped.', startedAt: at(0), completedAt: at(900_000) })],
      execution: 'cli',
      route: 'direct',
      autonomy: 'plan',
      loop: { enabled: false, maxRounds: 3, maxCostUsd: 0, maxDurationMinutes: 30, checkCommand: '' },
      status: 'completed',
      currentStepIndex: 0,
      createdAt: at(0),
      completedAt: at(900_000),
    },
  };
}

function step(id, agent, label, prompt, extra) {
  return { id, agent, label, prompt, execution: 'cli', route: 'direct', autonomy: 'ask', ...extra };
}

/** Binds port 0 and keeps what the OS handed out, so the smoke never fights a running gateway. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('No port was assigned.'))));
    });
  });
}

async function exists(target) {
  return stat(target).then((info) => info.isFile(), () => false);
}
