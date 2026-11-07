// Opens the learning tutor's Teaching tab in the real app, measures its rows and writes a screenshot.
//   node scripts/probe-teaching.mjs <outFile> [theme=purple] [width=1440] [height=900]
// Used to check spacing: it prints each entry row's height against the height its own content needs, and any element
// inside the panel whose text is clipped, so "clustered" is a number instead of an impression.
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';

const [outFile, theme = 'purple', widthArgument = '1440', heightArgument = '900'] = process.argv.slice(2);
if (!outFile) throw new Error('Usage: node scripts/probe-teaching.mjs <outFile> [theme] [width] [height]');
const LIGHT = new Set(['light', 'sky', 'meadow', 'sand']);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(appRoot, '..', '..');
const userDataDirectory = await mkdtemp(path.join(tmpdir(), 'kai-teach-'));
const electronExecutable = createRequire(import.meta.url)('electron');
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...launchEnvironment } = process.env;
await mkdir(path.dirname(outFile), { recursive: true });

const now = new Date().toISOString();
const project = { schemaVersion: 1, id: 'project-teach', name: 'KAi', path: projectRoot, createdAt: now, lastOpenedAt: now };
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
  await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height), { width: Number(widthArgument), height: Number(heightArgument) });
  await page.evaluate(([id, light]) => {
    document.documentElement.dataset.theme = id;
    document.documentElement.dataset.themeFamily = light ? 'light' : 'dark';
    window.localStorage.setItem('kai.tab.learning', 'teaching');
  }, [theme, LIGHT.has(theme)]);
  await page.locator('nav[aria-label="Workbench pages"] button[aria-label$=": Learn & Code"]').click({ force: true, timeout: 10_000 });
  await page.waitForTimeout(800);
  const toggle = page.locator('button[aria-label="Show learning tutor"]');
  if (await toggle.count()) await toggle.first().click({ force: true });
  const tab = page.getByRole('tab', { name: 'Teaching' });
  await tab.click({ timeout: 15_000 });
  await page.locator('.teaching-entry').first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(500);

  // PROBE_CSS_FILE: try a stylesheet on the live page before committing it to the app's own CSS.
  if (process.env.PROBE_CSS_FILE) await page.addStyleTag({ content: await (await import('node:fs/promises')).readFile(process.env.PROBE_CSS_FILE, 'utf8') });
  await page.waitForTimeout(300);
  const report = await page.evaluate(() => {
    const root = document.querySelector('.teaching-library');
    if (!root) return { error: 'no .teaching-library' };
    const box = (element) => { const rect = element.getBoundingClientRect(); return { top: Math.round(rect.top), height: Math.round(rect.height), width: Math.round(rect.width) }; };
    const rows = [...root.querySelectorAll('.teaching-entry')].map((row) => {
      const copy = row.querySelector('.teaching-entry-copy');
      return { title: row.querySelector('strong')?.textContent, ...box(row), contentNeeds: Math.round(copy ? copy.scrollHeight + 14 : 0), rowScroll: row.scrollHeight, rowClient: row.clientHeight };
    });
    const gaps = rows.slice(1).map((row, index) => row.top - (rows[index].top + rows[index].height));
    const clipped = [...root.querySelectorAll('*')].filter((element) => {
      const style = getComputedStyle(element);
      return element.scrollHeight > element.clientHeight + 1 && /hidden|clip/.test(style.overflowY) && element.clientHeight > 0 && !element.classList.contains('teaching-entry-list');
    }).map((element) => `${element.tagName.toLowerCase()}.${element.className}`.slice(0, 80));
    const list = root.querySelector('.teaching-entry-list');
    const sample = root.querySelector('.teaching-entry');
    const style = sample ? getComputedStyle(sample) : null;
    const check = root.querySelector('.teaching-enabled [role="switch"]');
    const checkRect = check?.getBoundingClientRect();
    const checkbox = check ? { width: Math.round(checkRect.width), height: Math.round(checkRect.height), radius: getComputedStyle(check).borderRadius, padding: getComputedStyle(check).padding, border: getComputedStyle(check).border, outline: getComputedStyle(check).outline, boxShadow: getComputedStyle(check).boxShadow } : null;
    return {
      checkbox,
      list: list ? { ...box(list), scrollHeight: list.scrollHeight, display: getComputedStyle(list).display, gridAutoRows: getComputedStyle(list).gridAutoRows, alignContent: getComputedStyle(list).alignContent } : null,
      rowStyle: style ? { height: style.height, minHeight: style.minHeight, maxHeight: style.maxHeight, overflow: style.overflow, padding: style.padding, display: style.display, flexShrink: style.flexShrink } : null,
      rows, gaps, clipped,
    };
  });
  if (process.env.PROBE_RULES) {
    const rules = await page.evaluate((props) => {
      const element = document.querySelector('.teaching-entry');
      const found = [];
      const walk = (list, context) => {
        for (const rule of list) {
          if (rule.cssRules && !rule.selectorText) { walk(rule.cssRules, `${context}${rule.conditionText ?? rule.name ?? ''}|`); continue; }
          if (!rule.selectorText || !rule.style) continue;
          let matches = false;
          try { matches = element.matches(rule.selectorText); } catch { matches = false; }
          if (!matches) continue;
          const hit = props.filter((prop) => rule.style.getPropertyValue(prop));
          if (hit.length) found.push(`${context}${rule.selectorText} { ${hit.map((prop) => `${prop}: ${rule.style.getPropertyValue(prop)}`).join('; ')} }`);
        }
      };
      for (const sheet of document.styleSheets) { try { walk(sheet.cssRules, `${(sheet.href ?? 'inline').split('/').pop()}: `); } catch { /* cross-origin */ } }
      return found;
    }, process.env.PROBE_RULES.split(','));
    console.log(JSON.stringify(rules, null, 2));
  }
  console.log(JSON.stringify(report, null, 2));
  await page.screenshot({ path: outFile });
  console.log(outFile);
} finally {
  await application.close().catch(() => undefined);
  await rm(userDataDirectory, { recursive: true, force: true });
}
