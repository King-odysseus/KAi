// Opens Settings in the real app and checks that its on/off settings are switches that work and sit in their rows.
//   node scripts/probe-switches.mjs <outDir> [theme=purple]
// It drives a switch the way the smoke tests do (isChecked / uncheck / check on role=switch), reports each toggle row's
// geometry, and writes a screenshot of the editor settings card.
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';

const [outDirectory, theme = 'purple'] = process.argv.slice(2);
if (!outDirectory) throw new Error('Usage: node scripts/probe-switches.mjs <outDir> [theme]');
const LIGHT = new Set(['light', 'sky', 'meadow', 'sand']);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(appRoot, '..', '..');
const userDataDirectory = await mkdtemp(path.join(tmpdir(), 'kai-switch-'));
const electronExecutable = createRequire(import.meta.url)('electron');
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...launchEnvironment } = process.env;
await mkdir(outDirectory, { recursive: true });

const now = new Date().toISOString();
const project = { schemaVersion: 1, id: 'project-switch', name: 'KAi', path: projectRoot, createdAt: now, lastOpenedAt: now };
await writeFile(path.join(userDataDirectory, 'settings.json'), `${JSON.stringify({
  schemaVersion: 1, theme: 'dark', setupCompletedAt: now, activeProjectId: project.id, projectOrder: [project.id], diagnosticsEnabled: false,
  cognitive1: { enabled: false, endpoint: 'http://127.0.0.1:9876', dataPath: null },
  proxy: { enabled: false, port: 8082, targetBaseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-flash', credentialId: 'provider.deepseek' },
}, null, 2)}\n`, 'utf8');
await writeFile(path.join(userDataDirectory, 'projects.json'), `${JSON.stringify({ schemaVersion: 1, projects: [project] }, null, 2)}\n`, 'utf8');

const application = await electron.launch({
  args: [appRoot], cwd: appRoot, executablePath: electronExecutable,
  env: { ...launchEnvironment, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true', KAI_DESKTOP_USER_DATA: userDataDirectory, KAI_DESKTOP_NOTIFICATIONS: 'off' },
  timeout: 30_000,
});
const problems = [];
try {
  const page = await application.firstWindow();
  await page.locator('.project-picker-button').waitFor({ timeout: 60_000 });
  const setupDialog = page.locator('.setup-panel');
  await setupDialog.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => undefined);
  if (await setupDialog.isVisible().catch(() => false)) {
    await setupDialog.evaluate((panel) => panel.querySelector('button[aria-label="Set up later"]')?.click()).catch(() => undefined);
    await setupDialog.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
  }
  await page.locator('.tour-card').getByRole('button', { name: 'Turn tour off' }).click({ timeout: 4_000 }).catch(() => undefined);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 1100));
  await page.evaluate(([id, light]) => { document.documentElement.dataset.theme = id; document.documentElement.dataset.themeFamily = light ? 'light' : 'dark'; }, [theme, LIGHT.has(theme)]);
  await page.locator('nav[aria-label="Workbench pages"] button[aria-label$=": Settings"]').click({ force: true, timeout: 10_000 });
  await page.waitForTimeout(800);

  if (process.env.PROBE_DEBUG) {
    console.log(await page.evaluate(() => JSON.stringify({ h1: document.querySelector('h1')?.textContent, switches: document.querySelectorAll('[role=switch]').length, rows: document.querySelectorAll('.toggle-row').length, sections: [...document.querySelectorAll('.settings-section .section-title')].map((el) => el.textContent).slice(0, 12), cats: [...document.querySelectorAll('[aria-expanded]')].map((el) => (el.textContent ?? '').trim().slice(0, 30) + ':' + el.getAttribute('aria-expanded')).slice(0, 12) })));
    console.log(await page.locator('.toggle-row', { hasText: 'Autosave edited files' }).ariaSnapshot());
    await page.screenshot({ path: path.join(outDirectory, 'debug.png') });
  }
  // 1. No on/off setting is left as a checkbox on this page.
  const checkboxes = await page.locator('.toggle-row input[type="checkbox"]').count();
  if (checkboxes) problems.push(`${checkboxes} checkbox(es) still inside toggle rows`);

  // 2. A switch is found by its row's name and behaves like the checkbox did.
  const autosave = page.getByRole('switch', { name: /Autosave edited files/ });
  await autosave.scrollIntoViewIfNeeded();
  const start = await autosave.isChecked();
  await autosave.uncheck();
  const afterOff = await autosave.isChecked();
  await autosave.check();
  const afterOn = await autosave.isChecked();
  if (!(start === true && afterOff === false && afterOn === true)) problems.push(`autosave switch: start=${start} off=${afterOff} on=${afterOn}`);
  // Clicking the row's text toggles it too, as a checkbox row did.
  await page.locator('.toggle-row', { hasText: 'Autosave edited files' }).locator('strong').click();
  if ((await autosave.isChecked()) !== false) problems.push('clicking the row text did not toggle the switch');
  await autosave.check();

  // 3. Geometry of every switch row: the switch is inside the row, right of the text, and the row is not clipped.
  const rows = await page.evaluate(() => [...document.querySelectorAll('.toggle-row')].map((row) => {
    const control = row.querySelector('[role="switch"]');
    const text = row.querySelector('span > strong, strong');
    const rowBox = row.getBoundingClientRect();
    const box = control?.getBoundingClientRect();
    return {
      label: (text?.textContent ?? row.textContent ?? '').trim().slice(0, 40),
      hasSwitch: Boolean(control),
      inside: box ? box.left >= rowBox.left && box.right <= rowBox.right + 1 && box.top >= rowBox.top - 1 && box.bottom <= rowBox.bottom + 1 : false,
      width: box ? Math.round(box.width) : 0,
      height: box ? Math.round(box.height) : 0,
      rightGap: box ? Math.round(rowBox.right - box.right) : 0,
      clipped: row.scrollWidth > row.clientWidth + 1,
    };
  }));
  for (const row of rows) {
    if (!row.hasSwitch) problems.push(`toggle row without a switch: ${row.label}`);
    else if (!row.inside) problems.push(`switch outside its row: ${row.label}`);
    if (row.clipped) problems.push(`row clipped: ${row.label}`);
  }
  console.log(JSON.stringify({ rows: rows.length, withSwitch: rows.filter((row) => row.hasSwitch).length, sample: rows.slice(0, 4), checkboxes }, null, 2));

  const card = page.locator('.settings-section', { hasText: 'Code editor' }).first();
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: path.join(outDirectory, `settings-editor-${theme}.png`) });
} finally {
  await application.close().catch(() => undefined);
  await rm(userDataDirectory, { recursive: true, force: true });
}
console.log(problems.length ? `PROBLEMS:\n- ${problems.join('\n- ')}` : 'switches ok');
process.exitCode = problems.length ? 1 : 0;
