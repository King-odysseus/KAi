// Drives the newer workbench pages (Code, Operations, ...) against a real project on disk.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { assertControlsDoNotWrap, assertTogglesCompact } from './layout-checks.mjs';
import { chooseOption, selectedValue, waitForPage } from './smoke-helpers.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(appRoot, 'test-results', 'smoke-workbench');
const userData = await mkdtemp(path.join(tmpdir(), 'kai-workbench-smoke-'));
const projectPath = path.join(userData, 'sample-project');
const secondProjectPath = path.join(userData, 'second-project');
const electronExecutable = createRequire(import.meta.url)('electron');
const packagedExecutable = process.env.KAI_PACKAGED_EXECUTABLE;
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...launchEnvironment } = process.env;
const rendererErrors = [];
let electronApp;

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await createProject();

try {
  electronApp = await electron.launch({
    args: packagedExecutable ? [] : [appRoot],
    cwd: appRoot,
    executablePath: packagedExecutable ?? electronExecutable,
    env: { ...launchEnvironment, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true', KAI_DESKTOP_USER_DATA: userData, KAI_DESKTOP_NOTIFICATIONS: 'off' },
    timeout: 30_000,
  });
  const page = await electronApp.firstWindow();
  // The guided tour starts by itself on a fresh profile. Check it works, then turn it off so its hint card never covers a control under test.
  await verifyTour(page);
  page.on('pageerror', (error) => {
    // Monaco cancels internal async decorations when the test rapidly changes models.
    // Ignore only that library cancellation; retain all application errors.
    if (error.name === 'Canceled' && error.message === 'Canceled' && /assets\/async-/.test(error.stack ?? '')) return;
    rendererErrors.push(error.stack ?? error.message);
  });
  await waitForProjectName(page, 'Sample Project');
  await verifyBuildIdentifier(page);

  await verifyCodeEditor(page);
  await verifySettingsCheckboxRetention(page);
  if (!process.env.KAI_TUTOR_SMOKE) {
  await verifyEditorAutosave(page);
  await verifyLivePreview(electronApp, page);
  await verifyGitAndTerminal(page);
  await verifyOperations(page);
  await verifyTasksAndSettings(page);
  await verifyStudioAndGraph(page);
  await verifySettingsSearch(page);
  await verifyThemes(page);
  await verifyIndependentWindows(electronApp, page);
  }

  if (rendererErrors.length > 0) throw new Error(`Renderer errors: ${rendererErrors.join(' | ')}`);
  console.log(`KAI workbench smoke passed. Screenshots: ${outputDirectory}`);
} catch (error) {
  if (rendererErrors.length > 0) console.error(`Renderer errors: ${rendererErrors.join(' | ')}`);
  if (electronApp) {
    const windows = electronApp.windows();
    for (const [index, window] of windows.entries()) {
      window.on('pageerror', (pageError) => rendererErrors.push(pageError.message));
      await window.screenshot({ path: path.join(outputDirectory, `failure-${index + 1}.png`) }).catch(() => undefined);
      console.error(`Window ${index + 1} body:\n${await window.locator('body').innerText().catch(() => '<body unavailable>')}`);
    }
  }
  throw error;
} finally {
  await electronApp?.close().catch(() => undefined);
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
}

async function verifyCodeEditor(page) {
  await page.getByRole('button', { name: 'Learn: Learn & Code', exact: true }).click();
  await page.getByLabel('Project files', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'src', exact: true }).click();
  const file = page.getByRole('button', { name: 'hello.ts' });
  await file.waitFor();
  // .gitignore is respected and binary files are hidden.
  if (await page.getByRole('button', { name: 'ignored.txt' }).count() > 0) throw new Error('A gitignored file was listed.');
  if (await page.getByRole('button', { name: 'logo.png' }).count() > 0) throw new Error('A binary file was listed.');

  await file.click();
  await page.locator('.monaco-editor').first().waitFor({ timeout: 20_000 });
  await page.getByText('export const hello').first().waitFor();
  await assertTutorTextareaStyled(page);
  await verifyTutorScope(page);
  await verifyTutorCollapsibleSections(page);
  await verifyTutorCompactControls(page);
  await verifyTutorInlineCompletion(page);
  await verifyResizablePane(page, 'Resize project files pane', '.code-sidebar');
  await verifyResizablePane(page, 'Resize learning tutor pane', '.learning-panel');
  await assertControlsDoNotWrap(page, 'code-1440x920');
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

  // Ordinary page navigation keeps the editor session alive instead of deleting and recreating the model.
  await page.getByRole('button', { name: 'Control: Usage', exact: true }).click();
  await page.getByRole('heading', { name: 'Usage', level: 1 }).waitFor();
  await page.getByRole('button', { name: 'Learn: Learn & Code', exact: true }).click();
  await page.locator('.monaco-editor').first().waitFor();
  await page.getByText('changed elsewhere').first().waitFor();

  await resizeWindow(electronApp, 960, 640);
  await assertNoHorizontalOverflow(page);
  await assertControlsDoNotWrap(page, 'code-960x640');
  await page.screenshot({ path: path.join(outputDirectory, 'code-960x640.png') });
  await resizeWindow(electronApp, 1440, 920);
}

async function verifyLivePreview(application, page) {
  const titlebar = page.locator('.titlebar-actions');
  await titlebar.getByRole('button', { name: 'Show live preview pane' }).waitFor();
  if (await page.locator('.preview-column').count() > 0) {
    throw new Error('The live preview pane should start closed.');
  }
  await titlebar.getByRole('button', { name: 'Show live preview pane' }).click();
  await page.locator('.preview-pane').waitFor();
  await titlebar.getByRole('button', { name: 'Hide live preview pane' }).waitFor();
  await page.getByLabel('Preview command').waitFor();
  await verifyResizablePane(page, 'Resize live preview pane', '.preview-column');
  await page.getByRole('button', { name: 'Start project' }).click();
  await page.locator('.preview-status.running').waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => {
    const preview = document.querySelector('webview');
    return preview instanceof HTMLElement && preview.getAttribute('src')?.startsWith('http://127.0.0.1:');
  }, undefined, { timeout: 30_000 });
  await page.getByRole('tab', { name: /Issues/ }).click();
  await page.getByText(/KAI preview error/).waitFor({ timeout: 20_000 });
  await page.getByText(/KAI preview warning/).waitFor({ timeout: 20_000 });

  const preview = page.locator('webview');
  await preview.evaluate(async (element) => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await element.executeJavaScript("Boolean(document.getElementById('preview-target'))").catch(() => false)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('The live preview document did not load.');
  });
  await page.getByRole('button', { name: 'Select element' }).first().click();
  await preview.evaluate((element) => element.executeJavaScript("document.getElementById('preview-target').click(); true"));
  await page.getByText('#preview-target', { exact: true }).waitFor({ timeout: 10_000 });
  await page.getByPlaceholder('Describe what should change...').fill('Make the heading shorter and clearer.');
  await page.getByRole('button', { name: 'Send to workspace' }).click();
  await page.getByText('Preview context added. Add any extra detail, then send the change request.').waitFor();
  const prompt = await page.getByLabel('Task prompt').inputValue();
  if (!prompt.includes('Change the selected element') || !prompt.includes('Make the heading shorter and clearer.')) {
    throw new Error(`The preview context was not sent to the composer: ${prompt}`);
  }

  await page.locator('.preview-status.running').waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.locator('.preview-status.stopped').waitFor({ timeout: 20_000 });
  await assertNoHorizontalOverflow(page);
  await assertControlsDoNotWrap(page, 'live-preview-1440x920');
  await page.screenshot({ path: path.join(outputDirectory, 'live-preview-1440x920.png') });

  await resizeWindow(application, 960, 640);
  await assertNoHorizontalOverflow(page);
  await assertControlsDoNotWrap(page, 'live-preview-960x640');
  await page.screenshot({ path: path.join(outputDirectory, 'live-preview-960x640.png') });
  await resizeWindow(application, 1440, 920);
  await titlebar.getByRole('button', { name: 'Hide live preview pane' }).click();
  await page.locator('.preview-column').waitFor({ state: 'detached' });
}

async function verifyEditorAutosave(page) {
  const navigation = page.locator('.nav-rail');
  await navigation.getByRole('button', { name: 'Control: Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor();
  const autoSaveToggle = page.getByRole('checkbox', { name: /Autosave edited files/ });
  await autoSaveToggle.waitFor();
  if (await autoSaveToggle.isChecked()) throw new Error('The autosave smoke expected autosave to start disabled.');
  await autoSaveToggle.check();
  await page.getByRole('button', { name: 'Save editor settings' }).click();
  await page.getByText('Code editor saved and shared with all open KAI windows.').waitFor();

  await navigation.getByRole('button', { name: 'Learn: Learn & Code', exact: true }).click();
  await page.locator('.monaco-editor').first().waitFor({ timeout: 20_000 });
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n// autosaved in KAI');
  await page.getByText('Autosave on').waitFor();
  await page.getByText('Autosaved src/hello.ts').waitFor({ timeout: 10_000 });
  const saved = await readFile(path.join(projectPath, 'src', 'hello.ts'), 'utf8');
  if (!saved.includes('// autosaved in KAI')) throw new Error('The edited file was not saved by autosave.');
}

async function verifyGitAndTerminal(page) {
  await page.getByRole('button', { name: 'Project: Git', exact: true }).click();
  await page.getByRole('heading', { name: 'Git', level: 1 }).waitFor();
  await page.getByText('Recent commits').waitFor();
  // The Code test left src/hello.ts modified; stage and commit it through the UI.
  // The row only moves once git has staged the file, so wait for the confirmation.
  await page.getByRole('button', { name: 'Stage src/hello.ts' }).click();
  await page.getByText('Staged src/hello.ts.').waitFor({ timeout: 20_000 });
  await page.getByPlaceholder('Describe what changed and why').fill('Update hello from the KAI smoke test');
  await page.getByRole('button', { name: /Commit 1 staged file/ }).click();
  await page.getByText('Committed 1 file.').waitFor({ timeout: 20_000 });
  const subject = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: projectPath, encoding: 'utf8' }).trim();
  if (subject !== 'Update hello from the KAI smoke test') throw new Error(`Unexpected last commit: ${subject}`);
  await page.getByRole('button', { name: 'Push' }).isDisabled().catch(() => undefined);
  await assertControlsDoNotWrap(page, 'git-1440x920');
  await page.screenshot({ path: path.join(outputDirectory, 'git-1440x920.png') });
  await resizeWindow(electronApp, 960, 640);
  await assertNoHorizontalOverflow(page);
  await assertControlsDoNotWrap(page, 'git-960x640');
  await page.screenshot({ path: path.join(outputDirectory, 'git-960x640.png') });
  await resizeWindow(electronApp, 1440, 920);

  // The terminal is a bottom panel available from any page. Exercise the
  // command-palette path here so the smoke does not depend on raw key delivery.
  await page.getByRole('button', { name: 'Open command palette' }).click();
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.getByLabel('Search commands').fill('Toggle Terminal Panel');
  await palette.getByRole('option', { name: /Toggle Terminal Panel/ }).click();
  const dock = page.getByRole('region', { name: 'Terminal' });
  await dock.waitFor();
  const terminalInput = dock.locator('.xterm-helper-textarea');
  await terminalInput.fill('echo KAI_TERMINAL_OK');
  await terminalInput.press('Enter');
  await page.waitForFunction(
    () => document.querySelector('.terminal-dock .xterm-rows')?.textContent?.includes('KAI_TERMINAL_OK') ?? false,
    undefined,
    { timeout: 20_000 },
  );
  await assertControlsDoNotWrap(page, 'terminal-dock-1440x920');
  await page.screenshot({ path: path.join(outputDirectory, 'terminal-dock-1440x920.png') });
  await resizeWindow(electronApp, 960, 640);
  await assertNoHorizontalOverflow(page);
  await assertControlsDoNotWrap(page, 'terminal-dock-960x640');
  await page.screenshot({ path: path.join(outputDirectory, 'terminal-dock-960x640.png') });
  await resizeWindow(electronApp, 1440, 920);
  // The panel and its output survive a page change, then hide again.
  await page.getByRole('button', { name: 'Control: Usage', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('.terminal-dock .xterm-rows')?.textContent?.includes('KAI_TERMINAL_OK') ?? false,
  );
  await dock.getByRole('button', { name: 'Close terminal' }).click();
  await dock.waitFor({ state: 'hidden' });
  await assertNoHorizontalOverflow(page);
}

async function verifyOperations(page) {
  await page.getByRole('button', { name: 'Control: Operations', exact: true }).click();
  await page.getByRole('heading', { name: 'Operations', level: 1 }).waitFor();
  await page.getByRole('tab', { name: 'Recovery' }).waitFor();
  await page.getByText('No interrupted runs').waitFor();
  await assertNoHorizontalOverflow(page);
  await assertControlsDoNotWrap(page, 'operations-1440x920');
  await page.screenshot({ path: path.join(outputDirectory, 'operations-1440x920.png') });

  // Checks: the project has a committed change from the Git step, so run a passing check and see it verified.
  await page.getByRole('tab', { name: 'Checks' }).click();
  await page.getByText('No check has been recorded for this project yet.').waitFor();
  await page.getByLabel('Check command').fill('node -e "process.exit(0)"');
  await page.getByRole('button', { name: /Run checks/ }).click();
  await page.getByRole('dialog', { name: 'Run this check?' }).getByRole('button', { name: 'Run check' }).click();
  await page.getByText('Passed', { exact: false }).first().waitFor({ timeout: 30_000 });
  await assertControlsDoNotWrap(page, 'checks-1440x920');
  await page.screenshot({ path: path.join(outputDirectory, 'checks-1440x920.png') });

  await page.getByRole('tab', { name: 'Diagnostics' }).click();
  await page.getByText('Engine checks').waitFor();
  await page.getByRole('button', { name: /Copy diagnostics report/ }).click();
  await page.getByText('# KAI diagnostics').waitFor();
  const report = await page.locator('.verify-output').last().innerText();
  if (/Bearer\s+[A-Za-z0-9._-]{10,}/.test(report) || /sk-[A-Za-z0-9_-]{10,}/.test(report)) throw new Error('The diagnostics report contains something that looks like a credential.');
  if (report.includes(process.env.USERNAME ?? '')) throw new Error('The diagnostics report contains the Windows user name.');
  await assertControlsDoNotWrap(page, 'diagnostics-1440x920');
  await page.screenshot({ path: path.join(outputDirectory, 'diagnostics-1440x920.png') });

  await page.getByRole('tab', { name: 'Active work' }).click();
  await page.getByText(/Cognitive1 is not running/).waitFor();
}

/** The tour starts by itself, walks a lesson with Next, turns off everywhere, and still lists every screen. */
async function verifyTour(page) {
  const card = page.locator('.tour-card');
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  await card.getByText('Workspace', { exact: false }).first().waitFor();
  await card.getByRole('button', { name: /Next/ }).click();
  await card.getByRole('heading', { name: 'The composer' }).waitFor();
  // Let the ring finish sliding, then it must sit on the composer and the card must not cover it.
  await page.waitForTimeout(500);
  const geometry = await page.evaluate(() => {
    const box = (selector) => { const element = document.querySelector(selector); if (!element) return null; const r = element.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, bottom: r.bottom }; };
    return { spot: box('.tour-spot'), composer: box('.composer-box'), card: box('.tour-card') };
  });
  if (!geometry.spot || !geometry.composer || !geometry.card) throw new Error('The tour ring, the composer or the card is missing.');
  if (Math.abs(geometry.spot.top - geometry.composer.top) > 12 || Math.abs(geometry.spot.left - geometry.composer.left) > 12) throw new Error('The tour ring is not on the composer: ' + JSON.stringify(geometry));
  const overlaps = geometry.card.left < geometry.composer.right && geometry.card.right > geometry.composer.left && geometry.card.top < geometry.composer.bottom && geometry.card.bottom > geometry.composer.top;
  if (overlaps) throw new Error('The tour card covers the composer it is explaining: ' + JSON.stringify(geometry));
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(outputDirectory, 'tour-card-1440x920.png') });
  await card.getByRole('button', { name: 'Turn tour off' }).click();
  await card.waitFor({ state: 'detached' });
  // Another screen must not start a lesson now that the tour is off.
  await page.getByRole('button', { name: 'Work: Project Studio', exact: true }).click();
  await page.waitForTimeout(700);
  if (await card.isVisible().catch(() => false)) throw new Error('The tour started on a new screen after it was turned off.');
  await page.getByRole('button', { name: 'Open the guided tour' }).click();
  const list = page.getByRole('dialog', { name: 'Lessons' });
  await list.waitFor();
  for (const title of ['Workspace', 'Project Studio', 'Project Graph', 'Settings']) await list.getByText(title, { exact: true }).first().waitFor();
  if (await list.getByRole('checkbox').isChecked()) throw new Error('The lessons list still says lessons start by themselves.');
  await page.screenshot({ path: path.join(outputDirectory, 'tour-list-1440x920.png') });
  await page.keyboard.press('Escape');
  await list.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Work: Workspace', exact: true }).click();
}

/** Settings can be searched through every card, and the open-pencil connector is a card of its own. */
async function verifySettingsSearch(page) {
  await page.locator('.nav-rail').getByRole('button', { name: 'Control: Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor();
  const search = page.getByRole('searchbox', { name: 'Search settings' });
  await search.fill('MCP address');
  await page.getByText('open-pencil (design editor)').waitFor();
  await page.getByRole('button', { name: 'Test connection' }).waitFor();
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(outputDirectory, 'settings-search-1440x920.png') });
  await search.fill('zzzz-no-such-setting');
  if ((await page.locator('.settings-categories .settings-section:visible').count()) !== 0) throw new Error('A search with no match still shows settings cards.');
  await search.fill('');
  if ((await page.locator('.settings-categories .settings-section:visible').count()) === 0) throw new Error('Clearing the settings search left every card hidden.');
  // The category bar stays pinned while the page scrolls.
  const bar = page.locator('.settings-sticky');
  await bar.waitFor();
  if ((await bar.evaluate((element) => getComputedStyle(element).position)) !== 'sticky') throw new Error('The settings category bar is not pinned.');
}

/** The Studio composer and the graph page open, fit the window, and show their empty states without a model. */
async function verifyStudioAndGraph(page) {
  await page.getByRole('button', { name: 'Work: Project Studio', exact: true }).click();
  await page.getByRole('heading', { name: /Project Studio/ }).first().waitFor();
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(outputDirectory, 'studio-1440x920.png') });

  await page.getByRole('button', { name: 'Work: Project Graph', exact: true }).click();
  await page.getByRole('heading', { name: 'Project graph', level: 1 }).waitFor();
  await page.getByRole('group', { name: 'Graph view' }).waitFor();
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(outputDirectory, 'graph-1440x920.png') });
  await page.getByRole('button', { name: 'Work: Workspace', exact: true }).click();
}

async function verifyTasksAndSettings(page) {
  await page.getByRole('button', { name: 'Work: Tasks', exact: true }).click();
  await page.getByRole('heading', { name: 'Tasks', level: 1 }).waitFor();
  await page.getByText(/Cognitive1 is not running/).waitFor();
  await assertNoHorizontalOverflow(page);

  await page.getByRole('button', { name: 'Control: Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor();
  await page.getByText('Updates', { exact: true }).waitFor();
  if (packagedExecutable) {
    await page.getByRole('button', { name: 'Check for updates' }).waitFor();
  } else {
    await page.getByText(/only available in installed builds/).waitFor();
  }
  await page.getByText('CLI models').waitFor();
  await page.getByText('Tray and notifications').waitFor();
  await assertSettingsSectionsFullWidth(page);
  // The tutor connection sits in the Connections category, which starts closed.
  await openSettingsCategory(page, 'Connections and models');
  const learningSection = page.locator('section.settings-section').filter({ has: page.getByText('Learning Tutor API', { exact: true }) });
  const learningProvider = learningSection.locator('label.field:has(span:text-is("Provider")) > .kai-select');
  await chooseOption(learningProvider, 'deepseek');
  const learningModel = learningSection.locator('label.field:has(span:text-is("Model")) > input');
  if ((await learningModel.inputValue()) !== 'deepseek-v4-pro') {
    throw new Error(`The DeepSeek tutor default is stale: ${await learningModel.inputValue()}`);
  }
  const learningModels = await learningSection.locator('#learning-tutor-models option').evaluateAll((options) => options.map((option) => option.value));
  if (!learningModels.includes('deepseek-flash') || !learningModels.includes('deepseek-v4-pro')) {
    throw new Error(`The DeepSeek tutor catalog is stale: ${learningModels.join(', ')}`);
  }
  await verifyShortcutSheet(page);
  await assertControlsDoNotWrap(page, 'settings-1440x920');
  await page.screenshot({ path: path.join(outputDirectory, 'settings-1440x920.png') });

  // The composer offers a per-conversation model next to agent, route and autonomy.
  await page.getByRole('button', { name: 'Work: Workspace', exact: true }).click();
  const titlebar = page.locator('.titlebar-actions');
  await titlebar.getByRole('button', { name: 'Show threads panel' }).waitFor();
  if (await page.locator('.conversation-column').count() > 0) {
    throw new Error('The left threads panel should start minimised.');
  }
  await titlebar.getByRole('button', { name: 'Show context panel' }).waitFor();
  if (await page.locator('.context-column').count() > 0) {
    throw new Error('The context panel should start minimised.');
  }
  await titlebar.getByRole('button', { name: 'Show threads panel' }).click();
  await page.locator('.conversation-column').waitFor();
  await verifyResizablePane(page, 'Resize conversations', '.conversation-column');
  await titlebar.getByRole('button', { name: 'Hide threads panel' }).click();
  await page.locator('.conversation-column').waitFor({ state: 'detached' });

  await titlebar.getByRole('button', { name: 'Show context panel' }).click();
  await page.locator('.context-column').waitFor();
  await verifyResizablePane(page, 'Resize context panel', '.context-column');
  await titlebar.getByRole('button', { name: 'Hide context panel' }).click();
  await page.locator('.context-column').waitFor({ state: 'detached' });

  // The agent, model, route and autonomy menus live behind the composer's Advanced toggle.
  if (await page.getByRole('button', { name: 'Agent', exact: true }).count() === 0) {
    // The toggle reads "Work locally" (or "Hide" once open), so it is found by its class.
    await page.locator('.composer-advanced-toggle').click();
  }
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await page.getByRole('listbox', { name: 'Agent', exact: true }).getByRole('option', { name: /^Qwen Code/ }).click();
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  const modelMenu = page.getByRole('listbox', { name: 'Model', exact: true });
  await modelMenu.getByRole('option', { name: 'qwen3.8-max', exact: true }).waitFor();
  await modelMenu.getByRole('option', { name: 'Other model…' }).waitFor();
  const modelMenuStacking = await modelMenu.evaluate((element) => {
    const composer = document.querySelector('.composer-box');
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + 10, rect.top + 10);
    return {
      composerOverflow: composer ? getComputedStyle(composer).overflow : null,
      hitInsideMenu: hit ? element.contains(hit) : false,
    };
  });
  if (modelMenuStacking.composerOverflow === 'hidden' || !modelMenuStacking.hitInsideMenu) {
    throw new Error(`The model menu was clipped by its composer container: ${JSON.stringify(modelMenuStacking)}.`);
  }
  await page.keyboard.press('Escape');
}

async function verifyThemes(page) {
  // The title-bar button cycles in this order. Synchronize on state rather than
  // assuming a click landed before the previous settings write completed.
  const order = ['navy', 'purple', 'light', 'dark'];
  for (const theme of order) {
    await setTheme(page, theme);
    for (const [button, heading] of [['Control: Usage', 'Usage'], ['Learn: Learn & Code', null], ['Work: Workspace', null], ['Control: Settings', 'Settings']]) {
      await page.getByRole('button', { name: button, exact: true }).click();
      if (heading) await page.getByRole('heading', { name: heading, level: 1 }).waitFor();
      await page.waitForTimeout(500);
      if (theme === 'light' && button === 'Learn: Learn & Code') await assertTutorTextareaLightTheme(page);
      await assertControlsDoNotWrap(page, `${theme} theme, ${button}`);
      await page.screenshot({ path: path.join(outputDirectory, `theme-${theme}-${button.split(': ').pop().toLowerCase().replace(/[^a-z]+/g, '-')}.png`) });
    }
  }
}

async function setTheme(page, target) {
  const themeButton = page.locator('button[aria-label^="Theme:"]');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await page.evaluate(() => document.documentElement.dataset.theme ?? '');
    if (current === target) return;
    await themeButton.click();
    await page.waitForFunction(
      (previous) => (document.documentElement.dataset.theme ?? '') !== previous,
      current,
      { timeout: 4_000 },
    ).catch(() => undefined);
  }
  const actual = await page.evaluate(() => document.documentElement.dataset.theme ?? 'unset');
  throw new Error(`The theme did not reach ${target}; current theme is ${actual}.`);
}

async function verifyIndependentWindows(application, page) {
  await page.getByRole('button', { name: 'Work: Workspace', exact: true }).click();
  await waitForProjectName(page, 'Sample Project');

  const secondWindowPromise = application.waitForEvent('window');
  await page.getByRole('button', { name: 'New window' }).click();
  const second = await secondWindowPromise;
  second.on('pageerror', (error) => rendererErrors.push(error.stack ?? error.message));
  await second.locator('.project-picker-button').getByText('No project', { exact: true }).waitFor({ timeout: 20_000 });

  const thirdWindowPromise = application.waitForEvent('window');
  await page.keyboard.press('Control+Shift+N');
  const third = await thirdWindowPromise;
  third.on('pageerror', (error) => rendererErrors.push(error.stack ?? error.message));
  await third.locator('.project-picker-button').getByText('No project', { exact: true }).waitFor({ timeout: 20_000 });
  await third.close();

  await second.locator('.project-picker-button').click();
  await second.getByRole('button', { name: /Second Project/ }).click();
  await waitForProjectName(second, 'Second Project');
  await waitForProjectName(page, 'Sample Project');

  // A renderer reload must restore this window's own project rather than another window's selection.
  await second.reload();
  await waitForProjectName(second, 'Second Project');
  await waitForProjectName(page, 'Sample Project');

  await setTheme(page, 'light');
  await second.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await waitForProjectName(second, 'Second Project');
  await waitForProjectName(page, 'Sample Project');

  await setTheme(page, 'dark');
  await second.waitForFunction(() => document.documentElement.dataset.theme === 'dark');

  await page.close();
  await waitForProjectName(second, 'Second Project');
  await second.screenshot({ path: path.join(outputDirectory, 'independent-windows-1440x920.png') });
}

async function verifyBuildIdentifier(page) {
  const response = await page.evaluate(() => window.kaiDesktop.bootstrap());
  if (!response.ok || !response.data.buildIdentifier || response.data.buildIdentifier.includes('unidentified')) {
    throw new Error(`The desktop build identifier is missing: ${JSON.stringify(response)}`);
  }
  const rail = await page.locator('.rail-footer').innerText();
  const suffix = response.data.buildIdentifier.split('+').at(-1);
  if (!suffix || !rail.includes(suffix)) {
    throw new Error(`The desktop UI did not expose build identifier ${response.data.buildIdentifier}: ${rail}`);
  }
}

async function waitForProjectName(page, name) {
  await page.locator('.project-picker-button').getByText(name, { exact: true }).waitFor({ timeout: 20_000 });
}

async function createProject() {
  await mkdir(path.join(projectPath, 'src'), { recursive: true });
  await mkdir(path.join(secondProjectPath, 'src'), { recursive: true });
  await writeFile(path.join(projectPath, 'src', 'hello.ts'), 'export const hello = "world";\r\n', 'utf8');
  await writeFile(path.join(projectPath, 'README.md'), '# Sample\n', 'utf8');
  await writeFile(path.join(projectPath, 'package.json'), JSON.stringify({ name: 'kai-preview-smoke', private: true, scripts: { dev: 'node preview-server.cjs' } }, null, 2), 'utf8');
  await writeFile(path.join(projectPath, 'preview-server.cjs'), [
    "const http = require('node:http');",
    'const server = http.createServer((_request, response) => {',
    "  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });",
    "  response.end('<!doctype html><html><body><main><h1 id=\"preview-target\">Preview target</h1></main><script>console.warn(\"KAI preview warning\"); console.error(\"KAI preview error\");</script></body></html>');",
    '});',
    "server.listen(0, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${server.address().port}/`));",
    "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
  ].join('\n'), 'utf8');
  await writeFile(path.join(projectPath, '.gitignore'), 'ignored.txt\n', 'utf8');
  await writeFile(path.join(projectPath, 'ignored.txt'), 'secret\n', 'utf8');
  await writeFile(path.join(projectPath, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]));
  execFileSync('git', ['init', '-q'], { cwd: projectPath });
  execFileSync('git', ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Smoke', 'add', '-A'], { cwd: projectPath });
  execFileSync('git', ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Smoke', 'commit', '-q', '-m', 'initial'], { cwd: projectPath });
  const now = new Date().toISOString();
  const project = { schemaVersion: 1, id: 'project-workbench-smoke', name: 'Sample Project', path: projectPath, createdAt: now, lastOpenedAt: now };
  const secondProject = { schemaVersion: 1, id: 'project-workbench-smoke-second', name: 'Second Project', path: secondProjectPath, createdAt: now, lastOpenedAt: now };
  const settings = {
    schemaVersion: 1,
    defaultAgent: 'codex',
    defaultRoute: 'direct',
    defaultAutonomy: 'ask',
    theme: 'dark',
    activeProjectId: project.id,
    projectOrder: [project.id, secondProject.id],
    windowBounds: null,
    logRetentionEntries: 2000,
    diagnosticsEnabled: true,
    directApi: { enabled: false, provider: 'openai', model: '', baseUrl: 'https://api.openai.com/v1', credentialId: 'provider.openai' },
    learningTutor: { enabled: false, provider: 'openai', model: 'gpt-6-astra', baseUrl: 'https://api.openai.com/v1', credentialId: 'provider.openai' },
    editor: { autoSave: false, autoSaveDelayMs: 800 },
    mcpServers: [],
    cognitive1: { enabled: false, endpoint: 'http://127.0.0.1:9876', dataPath: null },
    proxy: { enabled: false, port: 8082, targetBaseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-chat', credentialId: 'provider.deepseek' },
    setupCompletedAt: new Date().toISOString(),
  };
  await writeFile(path.join(userData, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  await writeFile(path.join(userData, 'projects.json'), `${JSON.stringify({ schemaVersion: 1, projects: [project, secondProject] }, null, 2)}\n`, 'utf8');
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

async function assertSettingsSectionsFullWidth(page) {
  const result = await page.evaluate(() => {
    const grid = document.querySelector('.settings-grid');
    if (!(grid instanceof HTMLElement)) return null;
    const gridStyle = getComputedStyle(grid);
    const contentWidth = grid.clientWidth - Number.parseFloat(gridStyle.paddingLeft) - Number.parseFloat(gridStyle.paddingRight);
    const sections = [...grid.querySelectorAll(':scope > .settings-section')].map((section) => section.getBoundingClientRect().width);
    return { contentWidth, sections };
  });
  if (!result || result.sections.length === 0) throw new Error('No settings sections were rendered.');
  if (result.sections.some((width) => width < result.contentWidth - 2)) {
    throw new Error(`A settings section did not fill the grid width: ${JSON.stringify(result)}`);
  }
}

async function verifyShortcutSheet(page) {
  await page.keyboard.press('Control+/');
  const sheet = page.getByRole('dialog', { name: 'Shortcut sheet' });
  await sheet.waitFor();
  const codeShortcut = sheet.getByLabel('Shortcut for Code editor');
  await codeShortcut.focus();
  await page.keyboard.press('Control+Alt+2');
  if ((await codeShortcut.inputValue()) !== 'Ctrl+Alt+2') {
    throw new Error(`Shortcut capture did not record the key combination: ${await codeShortcut.inputValue()}`);
  }
  await sheet.getByRole('button', { name: 'Save shortcuts' }).click();
  await sheet.getByText('Saved and active now').waitFor();
  await sheet.getByRole('button', { name: 'Reset all' }).click();
  await sheet.getByRole('button', { name: 'Save shortcuts' }).click();
  await sheet.getByText('Saved and active now').waitFor();
  await sheet.getByRole('button', { name: 'Close shortcut sheet' }).click();
  await sheet.waitFor({ state: 'detached' });
}

async function assertTutorTextareaStyled(page) {
  const textarea = page.getByLabel('Tutor question');
  await textarea.waitFor();
  const style = await textarea.evaluate((element) => {
    const computed = getComputedStyle(element);
    return {
      minHeight: Number.parseFloat(computed.minHeight),
      paddingTop: Number.parseFloat(computed.paddingTop),
      paddingLeft: Number.parseFloat(computed.paddingLeft),
      borderRadius: Number.parseFloat(computed.borderRadius),
      caretColor: computed.caretColor,
      backgroundColor: computed.backgroundColor,
    };
  });
  if (style.minHeight < 32 || style.minHeight > 48 || style.paddingTop < 8 || style.paddingLeft < 12 || style.borderRadius < 8) {
    throw new Error(`The tutor textarea style is incomplete: ${JSON.stringify(style)}`);
  }
  if (style.caretColor === 'transparent' || style.backgroundColor === 'rgba(0, 0, 0, 0)') {
    throw new Error(`The tutor textarea lacks visible caret/background styling: ${JSON.stringify(style)}`);
  }
}

/** The tutor card's footer line, which names what the next question will use as context. */
function contextLine(composer, pattern) {
  return composer.getByText(/Enter to ask/).filter({ hasText: pattern });
}

async function verifyTutorScope(page) {
  const composer = page.locator('.learning-composer');
  const scope = composer.getByLabel('Tutor context scope');
  await scope.waitFor();
  if (await composer.getByLabel('Tutor context scope').count() !== 1) {
    throw new Error('The tutor context selector must live inside the tutor prompt card.');
  }
  if ((await selectedValue(scope)) !== 'auto') throw new Error('The tutor should default to Auto scope.');
  await contextLine(composer, /^Auto/).waitFor();
  await chooseOption(scope, 'active-file');
  await contextLine(composer, /^hello\.ts/).waitFor();
  await chooseOption(scope, 'project');
  await contextLine(composer, /^Whole project/).waitFor();

  await page.getByLabel('Tutor question').fill('What does hello export?');
  if ((await page.getByLabel('Tutor question').inputValue()) !== 'What does hello export?') {
    throw new Error('The tutor question field did not keep what was typed.');
  }
  await page.getByLabel('Tutor question').fill('');

  await page.getByRole('button', { name: 'Close src/hello.ts' }).click();
  await contextLine(composer, /^Whole project · Enter/).waitFor();
  const askTutor = composer.getByRole('button', { name: 'Ask tutor' });
  if (await askTutor.isDisabled()) throw new Error('Whole-project tutoring should work without an open file.');
  await chooseOption(scope, 'active-file');
  if (!(await askTutor.isDisabled())) throw new Error('File-context tutoring should require an open file.');
  await chooseOption(scope, 'project');
  if (await askTutor.isDisabled()) throw new Error('Switching back to whole-project tutoring should re-enable the prompt.');

  if (await page.getByRole('button', { name: 'hello.ts' }).count() === 0) {
    await page.getByRole('button', { name: 'src', exact: true }).click();
  }
  await page.getByRole('button', { name: 'hello.ts' }).click();
  await page.locator('.monaco-editor').first().waitFor();
}

async function verifyTutorCollapsibleSections(page) {
  const scroll = page.locator('.learning-scroll');
  const controls = page.locator('#learning-controls');
  // The redesigned tutor starts with its optional controls closed.
  await page.getByRole('button', { name: 'Expand learning controls', exact: true }).click();
  await controls.waitFor();
  const beforeControls = await scroll.boundingBox();
  await page.getByRole('button', { name: 'Collapse learning controls' }).click();
  await controls.waitFor({ state: 'detached' });
  const afterControls = await scroll.boundingBox();
  if (!beforeControls || !afterControls || afterControls.height <= beforeControls.height) {
    throw new Error(`Collapsing learning controls did not expand the response area: ${JSON.stringify({ beforeControls, afterControls })}`);
  }
  await page.getByRole('button', { name: 'Expand learning controls' }).click();
  await controls.waitFor();

  const composer = page.getByLabel('Tutor question');
  await composer.waitFor();
  const beforeComposer = await scroll.boundingBox();
  await page.getByRole('button', { name: 'Collapse tutor composer' }).click();
  await composer.waitFor({ state: 'detached' });
  const afterComposer = await scroll.boundingBox();
  if (!beforeComposer || !afterComposer || afterComposer.height <= beforeComposer.height) {
    throw new Error(`Collapsing the tutor composer did not expand the response area: ${JSON.stringify({ beforeComposer, afterComposer })}`);
  }
  await page.getByRole('button', { name: 'Expand tutor composer' }).click();
  await composer.waitFor();
}

async function assertTutorTextareaLightTheme(page) {
  const textarea = page.getByRole('textbox', { name: 'Tutor question', exact: true });
  await textarea.waitFor();
  const colors = await textarea.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, background: style.backgroundColor };
  });
  const background = colors.background.match(/\d+/g)?.slice(0, 3).map(Number) ?? [];
  const foreground = colors.color.match(/\d+/g)?.slice(0, 3).map(Number) ?? [];
  const average = (values) => values.reduce((total, value) => total + value, 0) / Math.max(1, values.length);
  if (average(background) < 200 || average(foreground) > 120) {
    throw new Error(`The Learning Tutor textarea did not follow light theme colours: ${JSON.stringify(colors)}`);
  }
}

async function verifyResizablePane(page, separatorName, paneSelector) {
  const separator = page.getByRole('separator', { name: separatorName });
  const pane = page.locator(paneSelector);
  await separator.waitFor();
  const before = await pane.boundingBox();
  if (!before) throw new Error(`The pane ${paneSelector} has no measurable size.`);
  await separator.press('End');
  await page.waitForFunction(
    ({ selector, minimum }) => {
      const element = document.querySelector(selector);
      return Boolean(element && element.getBoundingClientRect().width > minimum);
    },
    { selector: paneSelector, minimum: before.width + 1 },
    { timeout: 5_000 },
  );
  const expanded = await pane.boundingBox();
  if (!expanded || expanded.width <= before.width + 1) {
    throw new Error(`The pane ${paneSelector} did not expand from ${before.width}px: ${JSON.stringify(expanded)}`);
  }
  await separator.dblclick();
  await page.waitForFunction(
    ({ selector, width }) => {
      const element = document.querySelector(selector);
      return Boolean(element && Math.abs(element.getBoundingClientRect().width - width) <= 18);
    },
    { selector: paneSelector, width: before.width },
    { timeout: 5_000 },
  );
  const reset = await pane.boundingBox();
  if (!reset || Math.abs(reset.width - before.width) > 18) {
    throw new Error(`The pane ${paneSelector} did not reset predictably: ${JSON.stringify({ before, reset })}`);
  }
}


async function verifyTutorCompactControls(page) {
  const input = page.getByLabel('Tutor question');
  await input.fill('');
  const small = await input.boundingBox();
  if (!small || small.height > 48) throw new Error('Tutor prompt must start as one line.');
  await input.fill('Explain this line.\nAnd this part.\nAnd one more.\nWhat should I test?');
  const expanded = await input.boundingBox();
  if (!expanded || expanded.height <= small.height) throw new Error('Tutor prompt did not grow.');
  await input.fill('');
  const modes = page.getByRole('group', { name: 'Assistance level' });
  const learn = modes.getByRole('button', { name: 'Learn', exact: true });
  await learn.click();
  await page.waitForFunction(() => document.querySelectorAll('.learning-assistance button[aria-pressed="true"]').length === 2);
  if (await learn.getAttribute('aria-pressed') !== 'true') throw new Error('Learn did not stay selected.');
  const hint = page.getByRole('button', { name: 'Hint', exact: true });
  if (await hint.getAttribute('title') !== 'Hint') throw new Error('Compact action has no tooltip.');
  const box = await hint.boundingBox();
  if (!box || box.width > 40) throw new Error('Tutor action is not compact.');
  await assertControlsDoNotWrap(page, 'tutor-expanded');
  await assertTogglesCompact(page, 'tutor-expanded');
  await page.getByRole('tab', { name: 'History', exact: true }).click();
  await page.getByText('Lesson history', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Tutor', exact: true }).click();
  await page.getByRole('button', { name: 'Focus', exact: true }).click();
  if (await page.locator('#learning-controls').isVisible()) throw new Error('Focus mode still shows learning controls.');
  await input.waitFor();
  await assertControlsDoNotWrap(page, 'tutor-focus');
  await assertTogglesCompact(page, 'tutor-focus');
  await page.screenshot({ path: path.join(outputDirectory, 'tutor-focus.png') });
  await page.getByRole('button', { name: 'Exit focus', exact: true }).click();
  await page.getByRole('tab', { name: 'History', exact: true }).waitFor();
}


async function verifyTutorInlineCompletion(page) {
  const progress = await page.evaluate(async () => (await window.kaiDesktop.learningProgress('project-workbench-smoke')).data);
  const response = { title: 'Smoke lesson', recap: 'Remember this lesson.', purpose: 'Inspect the project.', analogy: { title: 'Map', explanation: 'Files form a map.', mappings: [], limits: 'Read the code.' }, steps: [{ title: 'Do this next', explanation: 'Inspect the cited line.' }], concepts: [], codePreview: '', lineByLine: [], checks: ['Explain the line.'], sourceNotes: [{ label: 'Readme', filePath: 'README.md', startLine: 1, endLine: 1 }], followUpQuestion: '', suggestion: null };
  await electronApp.evaluate(({ ipcMain }, { progress, response }) => {
    ipcMain.removeHandler('learning:evaluate');
    ipcMain.handle('learning:evaluate', async (_event, request) => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      if (request.completionContext) return { ok: true, data: { progress: { ...progress, preferences: { ...progress.preferences, assistance: 'copilot', teachingModes: ['copilot'], inlineSuggestions: true } }, response: { ...response, suggestion: { code: '// INLINE_SMOKE', language: 'typescript', replaceSelection: false, explanation: 'Smoke completion' } } } };
      return { ok: true, data: { response, progress: { ...progress, lessons: [{ id: 'smoke-lesson', createdAt: new Date().toISOString(), filePath: request.filePath, response, understood: false }], memory: { lessonId: 'smoke-lesson', lastLesson: response.title, filePath: request.filePath, unresolvedCheck: 'Explain the line.', recommendedNext: '', understood: false } } } };
    });
  }, { progress, response });
  await page.getByRole('button', { name: 'Ask tutor', exact: true }).click();
  await page.locator('.learning-composer-processing').waitFor();
  await page.getByRole('heading', { name: 'Smoke lesson', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Open referenced file', exact: true }).click();
  await page.getByRole('button', { name: 'Close README.md', exact: true }).waitFor();
  if (!(await page.getByRole('heading', { name: 'Smoke lesson', exact: true }).isVisible())) throw new Error('Opening a file cleared the lesson.');
  await page.getByRole('button', { name: 'Select lines', exact: true }).click();
  await page.getByRole('tab', { name: 'History', exact: true }).click();
  await page.locator('.learning-history button').first().click();
  await page.getByRole('heading', { name: 'Smoke lesson', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close README.md', exact: true }).click();
  // Select Copilot alone, regardless of which teaching modes were used earlier.
  const modes = page.getByRole('group', { name: 'Assistance level' });
  if (!(await modes.isVisible())) await page.getByRole('button', { name: 'Expand learning controls', exact: true }).click();
  const copilot = modes.getByRole('button', { name: 'Copilot', exact: true });
  if (await copilot.getAttribute('aria-pressed') !== 'true') await copilot.click();
  for (const name of ['Learn', 'Guided', 'Pair']) {
    const mode = modes.getByRole('button', { name, exact: true });
    if (await mode.getAttribute('aria-pressed') === 'true') await mode.click();
  }
  const inline = page.getByRole('checkbox', { name: 'Inline suggestions', exact: true });
  await inline.check();
  await page.getByRole('tab', { name: 'History', exact: true }).click();
  await page.getByRole('tab', { name: 'Tutor', exact: true }).click();
  if (!(await inline.isChecked())) throw new Error('Inline checkbox reverted.');
  await waitForPage(page, async () => {
    const saved = (await window.kaiDesktop.learningProgress('project-workbench-smoke')).data;
    return saved.preferences.inlineSuggestions && saved.preferences.assistance === 'copilot' && saved.preferences.teachingModes.length === 1;
  });
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Alt+Backslash');
  await page.locator('.ghost-text-decoration, .ghost-text').first().waitFor({ timeout: 15_000 });
  await page.keyboard.press('Tab');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('.monaco-editor .view-lines')?.textContent?.includes('INLINE_SMOKE'));
  await inline.uncheck();
  await page.keyboard.press('Escape');
}


async function openSettingsCategory(page, name) {
  // A category button toggles its section, and the open sections are remembered, so only click a closed one.
  const button = page.locator('.settings-category-nav').getByRole('button', { name });
  if (!(await button.evaluate((element) => element.classList.contains('active')))) await button.click();
}

async function verifySettingsCheckboxRetention(page) {
  await page.locator('.nav-rail').getByRole('button', { name: 'Control: Settings', exact: true }).click();
  await openSettingsCategory(page, 'Services and access');
  const overwatch = page.getByRole('checkbox', { name: /Enable Overwatch/ });
  await overwatch.check();
  // An unrelated write broadcasts fresh settings to the open form.
  await page.evaluate(async () => {
    const current = (await window.kaiDesktop.getSettings()).data;
    await window.kaiDesktop.updateSettings({ logRetentionEntries: current.logRetentionEntries + 1 });
  });
  await page.waitForTimeout(500);
  if (!(await overwatch.isChecked())) throw new Error('Settings refresh discarded the Overwatch checkbox draft.');
  await page.getByRole('button', { name: 'Save all changes' }).click();
  await page.getByText('saved and shared with all open KAI windows.', { exact: false }).waitFor();
  const saved = await page.evaluate(async () => (await window.kaiDesktop.getSettings()).data);
  if (!saved.cognitive1.overwatch.enabled) throw new Error('Overwatch checkbox did not persist.');
  await page.locator('.nav-rail').getByRole('button', { name: 'Learn: Learn & Code', exact: true }).click();
  await page.locator('.nav-rail').getByRole('button', { name: 'Control: Settings', exact: true }).click();
  // Coming back to Settings starts with only the first category open.
  await openSettingsCategory(page, 'Services and access');
  if (!(await overwatch.isChecked())) throw new Error('Overwatch checkbox reverted after navigation.');
  await page.locator('.nav-rail').getByRole('button', { name: 'Learn: Learn & Code', exact: true }).click();
}
