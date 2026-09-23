// Drives the newer workbench pages (Code, Operations, ...) against a real project on disk.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(appRoot, 'test-results', 'smoke-workbench');
const userData = await mkdtemp(path.join(tmpdir(), 'kai-workbench-smoke-'));
const projectPath = path.join(userData, 'sample-project');
const electronExecutable = createRequire(import.meta.url)('electron');
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...launchEnvironment } = process.env;
const rendererErrors = [];
let electronApp;

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await createProject();

try {
  electronApp = await electron.launch({
    args: [appRoot],
    cwd: appRoot,
    executablePath: electronExecutable,
    env: { ...launchEnvironment, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true', KAI_DESKTOP_USER_DATA: userData, KAI_DESKTOP_NOTIFICATIONS: 'off' },
    timeout: 30_000,
  });
  const page = await electronApp.firstWindow();
  page.on('pageerror', (error) => rendererErrors.push(error.message));
  await page.getByRole('heading', { name: 'Sample Project', level: 1 }).waitFor({ timeout: 20_000 });

  await verifyCodeEditor(page);
  await verifyGitAndTerminal(page);
  await verifyOperations(page);
  await verifyTasksAndSettings(page);
  await verifyThemes(page);

  if (rendererErrors.length > 0) throw new Error(`Renderer errors: ${rendererErrors.join(' | ')}`);
  console.log(`KAI workbench smoke passed. Screenshots: ${outputDirectory}`);
} catch (error) {
  if (electronApp) {
    const page = await electronApp.firstWindow().catch(() => null);
    await page?.screenshot({ path: path.join(outputDirectory, 'failure.png') }).catch(() => undefined);
  }
  throw error;
} finally {
  await electronApp?.close().catch(() => undefined);
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
}

async function verifyCodeEditor(page) {
  await page.getByRole('button', { name: 'Code', exact: true }).click();
  await page.getByLabel('Project files').waitFor();
  await page.getByRole('button', { name: 'src', exact: true }).click();
  const file = page.getByRole('button', { name: 'hello.ts' });
  await file.waitFor();
  // .gitignore is respected and binary files are hidden.
  if (await page.getByRole('button', { name: 'ignored.txt' }).count() > 0) throw new Error('A gitignored file was listed.');
  if (await page.getByRole('button', { name: 'logo.png' }).count() > 0) throw new Error('A binary file was listed.');

  await file.click();
  await page.locator('.monaco-editor').first().waitFor({ timeout: 20_000 });
  await page.getByText('export const hello').first().waitFor();
  await page.screenshot({ path: path.join(outputDirectory, 'code-1440x920.png') });

  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('// edited in KAI');
  await page.getByText('●').first().waitFor();
  await page.keyboard.press('Control+S');
  await page.getByText('Saved src/hello.ts').waitFor();
  const saved = await readFile(path.join(projectPath, 'src', 'hello.ts'), 'utf8');
  if (!saved.includes('// edited in KAI')) throw new Error(`Saved file is missing the edit: ${saved}`);
  if (!saved.includes('\r\n')) throw new Error('Saving lost the file line endings (CRLF).');

  // An edit made elsewhere must be flagged, and reloading must show it.
  await writeFile(path.join(projectPath, 'src', 'hello.ts'), 'export const hello = "changed elsewhere";\r\n', 'utf8');
  await page.getByText(/changed on disk after you opened it/).waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Reload from disk' }).click();
  await page.getByText('changed elsewhere').first().waitFor();

  await resizeWindow(electronApp, 960, 640);
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(outputDirectory, 'code-960x640.png') });
  await resizeWindow(electronApp, 1440, 920);
}

async function verifyGitAndTerminal(page) {
  await page.getByRole('button', { name: 'Git', exact: true }).click();
  await page.getByRole('heading', { name: 'Git', level: 1 }).waitFor();
  await page.getByText('Recent commits').waitFor();
  // The Code test left src/hello.ts modified; stage and commit it through the UI.
  // The box only flips once git has staged the file, so wait for the confirmation instead of check().
  await page.getByRole('checkbox', { name: 'Stage src/hello.ts' }).click();
  await page.getByText('Staged src/hello.ts.').waitFor({ timeout: 20_000 });
  await page.getByPlaceholder('Describe what changed and why').fill('Update hello from the KAI smoke test');
  await page.getByRole('button', { name: /Commit 1 staged file/ }).click();
  await page.getByText('Committed 1 file.').waitFor({ timeout: 20_000 });
  const subject = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: projectPath, encoding: 'utf8' }).trim();
  if (subject !== 'Update hello from the KAI smoke test') throw new Error(`Unexpected last commit: ${subject}`);
  await page.getByRole('button', { name: 'Push' }).isDisabled().catch(() => undefined);
  await page.screenshot({ path: path.join(outputDirectory, 'git-1440x920.png') });
  await resizeWindow(electronApp, 960, 640);
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(outputDirectory, 'git-960x640.png') });
  await resizeWindow(electronApp, 1440, 920);

  // The terminal is a bottom panel toggled with Ctrl+`, available from any page.
  await page.keyboard.press('Control+Backquote');
  const dock = page.getByRole('region', { name: 'Terminal' });
  await dock.waitFor();
  await dock.getByLabel('Command', { exact: true }).fill('node -e "console.log(6 * 7)"');
  await page.keyboard.press('Enter');
  await dock.getByText('exit 0').waitFor({ timeout: 20_000 });
  await dock.getByRole('log').getByText('42', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(outputDirectory, 'terminal-dock-1440x920.png') });
  await resizeWindow(electronApp, 960, 640);
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(outputDirectory, 'terminal-dock-960x640.png') });
  await resizeWindow(electronApp, 1440, 920);
  // The panel and its output survive a page change, then hide again.
  await page.getByRole('button', { name: 'Usage', exact: true }).click();
  await dock.getByText('exit 0').waitFor();
  await page.keyboard.press('Control+Backquote');
  await dock.waitFor({ state: 'hidden' });
  await assertNoHorizontalOverflow(page);
}

async function verifyOperations(page) {
  await page.getByRole('button', { name: 'Operations', exact: true }).click();
  await page.getByRole('heading', { name: 'Operations', level: 1 }).waitFor();
  await page.getByRole('tab', { name: 'Recovery' }).waitFor();
  await page.getByText('No interrupted runs').waitFor();
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(outputDirectory, 'operations-1440x920.png') });

  // Checks: the project has a committed change from the Git step, so run a passing check and see it verified.
  await page.getByRole('tab', { name: 'Checks' }).click();
  await page.getByText('No check has been recorded for this project yet.').waitFor();
  await page.getByLabel('Check command').fill('node -e "process.exit(0)"');
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: /Run checks/ }).click();
  await page.getByText('Passed', { exact: false }).first().waitFor({ timeout: 30_000 });
  await page.screenshot({ path: path.join(outputDirectory, 'checks-1440x920.png') });

  await page.getByRole('tab', { name: 'Diagnostics' }).click();
  await page.getByText('Engine checks').waitFor();
  await page.getByRole('button', { name: /Copy diagnostics report/ }).click();
  await page.getByText('# KAI diagnostics').waitFor();
  const report = await page.locator('.verify-output').last().innerText();
  if (/Bearer\s+[A-Za-z0-9._-]{10,}/.test(report) || /sk-[A-Za-z0-9_-]{10,}/.test(report)) throw new Error('The diagnostics report contains something that looks like a credential.');
  if (report.includes(process.env.USERNAME ?? ' ')) throw new Error('The diagnostics report contains the Windows user name.');
  await page.screenshot({ path: path.join(outputDirectory, 'diagnostics-1440x920.png') });

  await page.getByRole('tab', { name: 'Active work' }).click();
  await page.getByText(/Cognitive1 is not running/).waitFor();
}

async function verifyTasksAndSettings(page) {
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('heading', { name: 'Tasks', level: 1 }).waitFor();
  await page.getByText(/Cognitive1 is not running/).waitFor();
  await assertNoHorizontalOverflow(page);

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor();
  await page.getByText('Updates', { exact: true }).waitFor();
  await page.getByText(/only available in installed builds/).waitFor();
  await page.getByText('CLI models').waitFor();
  await page.getByText('Tray and notifications').waitFor();
  await page.screenshot({ path: path.join(outputDirectory, 'settings-1440x920.png') });

  // The composer offers a per-conversation model next to agent, route and autonomy.
  await page.getByRole('button', { name: 'Workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: 'Other model…' }).waitFor();
  await page.keyboard.press('Escape');
}

async function verifyThemes(page) {
  // The title-bar button cycles dark -> navy -> purple -> light -> dark.
  const order = ['navy', 'purple', 'light', 'dark'];
  for (const theme of order) {
    await page.locator('button[aria-label^="Theme:"]').click();
    await page.waitForFunction((mode) => document.documentElement.dataset.theme === mode, theme, { timeout: 10_000 });
    for (const [button, heading] of [['Usage', 'Usage'], ['Code', null], ['Workspace', null], ['Settings', 'Settings']]) {
      await page.getByRole('button', { name: button, exact: true }).click();
      if (heading) await page.getByRole('heading', { name: heading, level: 1 }).waitFor();
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(outputDirectory, `theme-${theme}-${button.toLowerCase()}.png`) });
    }
  }
}

async function createProject() {
  await mkdir(path.join(projectPath, 'src'), { recursive: true });
  await writeFile(path.join(projectPath, 'src', 'hello.ts'), 'export const hello = "world";\r\n', 'utf8');
  await writeFile(path.join(projectPath, 'README.md'), '# Sample\n', 'utf8');
  await writeFile(path.join(projectPath, '.gitignore'), 'ignored.txt\n', 'utf8');
  await writeFile(path.join(projectPath, 'ignored.txt'), 'secret\n', 'utf8');
  await writeFile(path.join(projectPath, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]));
  execFileSync('git', ['init', '-q'], { cwd: projectPath });
  execFileSync('git', ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Smoke', 'add', '-A'], { cwd: projectPath });
  execFileSync('git', ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Smoke', 'commit', '-q', '-m', 'initial'], { cwd: projectPath });
  const now = new Date().toISOString();
  const project = { schemaVersion: 1, id: 'project-workbench-smoke', name: 'Sample Project', path: projectPath, createdAt: now, lastOpenedAt: now };
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
    mcpServers: [],
    cognitive1: { enabled: false, endpoint: 'http://127.0.0.1:9876', dataPath: null },
    proxy: { enabled: false, port: 8082, targetBaseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-chat', credentialId: 'provider.deepseek' },
  };
  await writeFile(path.join(userData, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  await writeFile(path.join(userData, 'projects.json'), `${JSON.stringify({ schemaVersion: 1, projects: [project] }, null, 2)}\n`, 'utf8');
}

async function resizeWindow(application, width, height) {
  return application.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(size.width, size.height);
    return window.getSize();
  }, { width, height });
}

async function assertNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (overflow) throw new Error('KAI displayed horizontal overflow.');
}
