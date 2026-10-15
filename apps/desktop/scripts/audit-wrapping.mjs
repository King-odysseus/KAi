// Layout audit: opens the real desktop UI, visits every page in the navigation rail plus the panels that hang off
// them, and reports every piece of text that runs past a box which hides it (see findClippedText in
// layout-checks.mjs). The narrow sizes matter most: compact windows are where a laid-out row runs out of room.
// Run it after touching CSS that lays text out: `node scripts/audit-wrapping.mjs`.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { findClippedText } from './layout-checks.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The repository itself is the fixture: a real project fills in the pages that are nothing but empty states
// otherwise (files, graph, git, studio).
const projectRoot = path.resolve(appRoot, '..', '..');
const userDataDirectory = await mkdtemp(path.join(tmpdir(), 'kai-wrap-audit-'));
const electronExecutable = createRequire(import.meta.url)('electron');
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...launchEnvironment } = process.env;
const sizes = [
  [445, 900],
  [640, 800],
  [960, 640],
  [1440, 920],
];
const findings = [];

const now = new Date().toISOString();
const project = { schemaVersion: 1, id: 'project-wrap-audit', name: 'KAi', path: projectRoot, createdAt: now, lastOpenedAt: now };
await writeFile(
  path.join(userDataDirectory, 'settings.json'),
  `${JSON.stringify({
    schemaVersion: 1,
    theme: 'dark',
    setupCompletedAt: now,
    activeProjectId: project.id,
    projectOrder: [project.id],
    diagnosticsEnabled: false,
    cognitive1: { enabled: false, endpoint: 'http://127.0.0.1:9876', dataPath: null },
    proxy: { enabled: false, port: 8082, targetBaseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-flash', credentialId: 'provider.deepseek' },
  }, null, 2)}\n`,
  'utf8',
);
await writeFile(path.join(userDataDirectory, 'projects.json'), `${JSON.stringify({ schemaVersion: 1, projects: [project] }, null, 2)}\n`, 'utf8');

const application = await electron.launch({
  args: [appRoot],
  cwd: appRoot,
  executablePath: electronExecutable,
  env: { ...launchEnvironment, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true', KAI_DESKTOP_USER_DATA: userDataDirectory, KAI_DESKTOP_NOTIFICATIONS: 'off' },
  timeout: 30_000,
});

async function resize(width, height) {
  await application.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height);
    },
    { width, height },
  );
  await page.waitForTimeout(600);
}

/** Clicks a control the layout shows. A control that is not there is not the subject here, and a 30s wait for it is a 30s wait. */
async function clickIfPresent(name, role = 'button') {
  return page.getByRole(role, { name, exact: true }).click({ timeout: 3_000 }).then(() => true).catch(() => false);
}

/** Records everything the page is hiding behind an edge, tagged with where it was found. */
async function audit(where) {
  const offenders = await findClippedText(page, { includeTruncated: true });
  for (const offender of offenders) findings.push({ where, ...offender });
}

let page;
try {
  page = await application.firstWindow();
  const setupDialog = page.locator('.setup-panel[role="dialog"]');
  await setupDialog.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
  if (await setupDialog.isVisible().catch(() => false)) {
    await setupDialog.locator('button.secondary-button').filter({ hasText: 'Set up later' }).click({ force: true });
    await setupDialog.waitFor({ state: 'detached' });
  }
  await page.locator('.tour-card').getByRole('button', { name: 'Turn tour off' }).click({ timeout: 4_000 }).catch(() => undefined);
  await page.locator('.project-picker-button').waitFor({ timeout: 30_000 });

  const labels = await page.locator('.nav-rail button[aria-label]').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
  console.log(`Auditing ${labels.length} pages at ${sizes.length} window sizes.`);
  for (const [width, height] of sizes) {
    await resize(width, height);
    for (const label of labels) {
      console.log(`Checking ${label} at ${width}x${height}.`);
      await page.getByRole('button', { name: label, exact: true }).click();
      await page.waitForTimeout(500);
      await audit(`${label.replace(/^(Work|Learn|Project|Brain|Control): /, '')}-${width}x${height}`);
    }
    // The workspace with both side panels open holds the densest text on the page.
    await page.getByRole('button', { name: 'Work: Workspace', exact: true }).click();
    await clickIfPresent('Show threads panel');
    await clickIfPresent('Show context panel');
    await page.waitForTimeout(500);
    await audit(`Workspace-panels-${width}x${height}`);
    await clickIfPresent('Hide threads panel');
    await clickIfPresent('Hide context panel');
    // The Learn & Code page carries the tutor column and its own tabs, the densest prose in the app.
    await page.getByRole('button', { name: 'Learn: Learn & Code', exact: true }).click();
    const tutorOpen = await clickIfPresent('Show learning tutor');
    if (!tutorOpen) console.log(`  (no learning panel toggle at ${width}x${height})`);
    await page.waitForTimeout(500);
    for (const tab of ['Learn', 'Review', 'Senior dev']) {
      await clickIfPresent(tab);
      await page.waitForTimeout(400);
      await audit(`LearnCode-${tab}-${width}x${height}`);
    }
    for (const tab of ['Tutor', 'History', 'Progress', 'Teaching', 'Git']) {
      await clickIfPresent(tab, 'tab');
      await page.waitForTimeout(400);
      await audit(`LearnCode-Learn-${tab}-${width}x${height}`);
    }
    await clickIfPresent('Hide learning tutor');
  }
} finally {
  await application.close().catch(() => undefined);
  await rm(userDataDirectory, { recursive: true, force: true });
}

findings.sort((left, right) => left.where.localeCompare(right.where) || right.overhang - left.overhang);
// Silent clipping is a fault. An ellipsis or a line clamp is the app choosing to shorten text, which is only a
// fault when the shortened part is something the reader needs, so it is listed separately for triage.
const silent = findings.filter((item) => !item.ellipsis && !item.clamped);
const shortened = findings.filter((item) => item.ellipsis || item.clamped);
const describe = (item) =>
  `${item.where} | <${item.tag} class="${item.className}"> in <${item.in}> overhang ${item.overhang}/${item.overhangLeft}/${item.overhangBottom} (${item.overflow}${item.nowrap ? ', nowrap' : ''}${item.ellipsis ? ', ellipsis' : ''}${item.clamped ? ', clamped' : ''}) "${item.text}"`;
if (silent.length === 0) {
  console.log('No silently clipped text found.');
} else {
  console.log(`${silent.length} clipped text findings:\n`);
  for (const item of silent) console.log(describe(item));
}
if (shortened.length > 0) {
  console.log(`\n${shortened.length} deliberately shortened (check these read well):\n`);
  for (const item of shortened) console.log(describe(item));
}
await mkdir(path.join(appRoot, 'test-results'), { recursive: true });
await writeFile(path.join(appRoot, 'test-results', 'wrap-audit.json'), `${JSON.stringify(findings, null, 2)}\n`, 'utf8');
console.log('\nWritten to test-results/wrap-audit.json');
