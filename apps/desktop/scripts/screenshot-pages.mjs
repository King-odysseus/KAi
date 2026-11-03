// Screenshots the real desktop UI: each page in the navigation rail, in each theme, so a redesign can be checked
// against its mockup by eye and a colour that is unreadable in one theme is found before anyone installs it.
//
//   node scripts/screenshot-pages.mjs <outDir> [themes=purple,code,navy,forest,light,sand] [pages=all] [width=1440] [height=900]
//
// `pages` is a comma list of navigation labels without the group ("Workspace,Settings"), or "all". The theme is set on
// the root element the way the app does it, so no restart is needed between themes. The repository is the fixture
// project, as in audit-wrapping.mjs.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';

const [outDirectory, themeArgument = 'purple,code,navy,forest,light,sand', pageArgument = 'all', widthArgument = '1440', heightArgument = '900'] = process.argv.slice(2);
if (!outDirectory) throw new Error('Usage: node scripts/screenshot-pages.mjs <outDir> [themes] [pages] [width] [height]');
const themes = themeArgument.split(',');
const LIGHT = new Set(['light', 'sky', 'meadow', 'sand']);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(appRoot, '..', '..');
const userDataDirectory = await mkdtemp(path.join(tmpdir(), 'kai-shots-'));
const electronExecutable = createRequire(import.meta.url)('electron');
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...launchEnvironment } = process.env;
await mkdir(outDirectory, { recursive: true });

const now = new Date().toISOString();
const project = { schemaVersion: 1, id: 'project-shots', name: 'KAi', path: projectRoot, createdAt: now, lastOpenedAt: now };
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
let page;
try {
  page = await application.firstWindow();
  // Bootstrap is what opens the setup wizard, so wait for the window to settle before deciding whether it is there.
  await page.locator('.project-picker-button').waitFor({ timeout: 60_000 });
  const setupDialog = page.locator('.setup-panel');
  await setupDialog.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => undefined);
  if (await setupDialog.isVisible().catch(() => false)) {
    // The panel's own close control is present in every state; the footer button can be disabled while checks run.
    // clicked in the DOM so a tour layer over the panel cannot swallow the click.
    await setupDialog.evaluate((panel) => panel.querySelector('button[aria-label="Set up later"]')?.click()).catch(() => undefined);
    await setupDialog.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
  }
  await page.locator('.tour-card').getByRole('button', { name: 'Turn tour off' }).click({ timeout: 4_000 }).catch(() => undefined);
  await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height), { width: Number(widthArgument), height: Number(heightArgument) });
  await page.waitForTimeout(600);

  // Page buttons only: the rail's own expand/collapse control also carries an aria-label but opens no page.
  const labels = await page.locator('.nav-rail nav button[aria-label]').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
  const wanted = pageArgument === 'all' ? labels : labels.filter((label) => pageArgument.split(',').some((name) => label.endsWith(`: ${name}`)));
  for (const theme of themes) {
    await page.evaluate(([id, light]) => { document.documentElement.dataset.theme = id; document.documentElement.dataset.themeFamily = light ? 'light' : 'dark'; }, [theme, LIGHT.has(theme)]);
    for (const label of wanted) {
      // Force-click the rail entry: a transient overlay may cover it, but it is still the page being captured.
      await page.locator(`.nav-rail nav button[aria-label=${JSON.stringify(label)}]`).click({ force: true, timeout: 5_000 });
      await page.waitForTimeout(450);
      const file = path.join(outDirectory, `${theme}-${label.replace(/^[A-Za-z]+: /, '').replace(/[^A-Za-z0-9]+/g, '-')}.png`);
      await page.screenshot({ path: file });
      console.log(file);
    }
  }
} finally {
  await application.close().catch(() => undefined);
  await rm(userDataDirectory, { recursive: true, force: true });
}
