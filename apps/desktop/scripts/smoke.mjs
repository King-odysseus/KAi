import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { assertControlsDoNotWrap, assertTextIsNotClipped } from './layout-checks.mjs';
import { chooseOption, optionLabels, selectedValue, waitForPage } from './smoke-helpers.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(appRoot, 'test-results', 'smoke');
const userDataDirectory = await mkdtemp(path.join(tmpdir(), 'kai-desktop-smoke-'));
const electronExecutable = createRequire(import.meta.url)('electron');
const packagedExecutable = process.env.KAI_PACKAGED_EXECUTABLE;
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...launchEnvironment } = process.env;
const realEngineSmoke = process.env.KAI_REAL_ENGINE_SMOKE === '1';
const realAgentSmoke = process.env.KAI_REAL_AGENT_SMOKE === '1';
const directApiSmoke = process.env.KAI_DIRECT_API_SMOKE === '1';
const requestedDirectProvider = process.env.KAI_DIRECT_API_PROVIDER;
const directApiProvider = requestedDirectProvider === 'openrouter' || requestedDirectProvider === 'deepseek'
  ? requestedDirectProvider
  : 'openai';
const mcpSmoke = process.env.KAI_MCP_SMOKE === '1';
const mcpTransport = process.env.KAI_MCP_TRANSPORT === 'http' ? 'http' : 'stdio';
const commandSmoke = process.env.KAI_COMMAND_SMOKE === '1';
const mcpHttpCredentialId = 'mcp.smoke.http';
const mcpHttpAuthorization = 'Bearer smoke-http-token';
const usesAgentProject = realAgentSmoke || directApiSmoke || mcpSmoke || commandSmoke;
const enginePorts = realEngineSmoke
  ? { cognitive1: await availablePort(), universalProxy: await availablePort() }
  : null;
const liveProjectPath = path.join(userDataDirectory, 'live-agent-project');
const rendererErrors = [];
const directApiFixture = directApiSmoke || mcpSmoke || commandSmoke
  ? await startDirectApiFixture({ mcp: mcpSmoke, command: commandSmoke, provider: directApiProvider })
  : null;
const mcpHttpFixture = mcpSmoke && mcpTransport === 'http' ? await startMcpHttpFixture() : null;
let electronApp;

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
if (enginePorts) await writeEngineSettings(userDataDirectory, enginePorts);
if (usesAgentProject) await writeAgentSettings(userDataDirectory, liveProjectPath, directApiFixture, mcpSmoke, mcpHttpFixture?.url, directApiProvider);

try {
  electronApp = await electron.launch({
    args: packagedExecutable ? [] : [appRoot],
    cwd: appRoot,
    executablePath: packagedExecutable ?? electronExecutable,
    env: {
      ...launchEnvironment,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      KAI_DESKTOP_USER_DATA: userDataDirectory,
      KAI_DESKTOP_NOTIFICATIONS: 'off',
    },
    timeout: 30_000,
  });

  const page = await electronApp.firstWindow();
  page.on('pageerror', (error) => rendererErrors.push(error.message));
  // Found by its role and its dismiss button, not its heading, so a reworded title does not strand the smoke behind it.
  const setupDialog = page.locator('.setup-panel[role="dialog"]');
  await setupDialog.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
  if (await setupDialog.isVisible().catch(() => false)) {
    await setupDialog.locator('button.secondary-button').filter({ hasText: 'Set up later' }).click({ force: true });
    await setupDialog.waitFor({ state: 'detached' });
  }
  // The guided tour starts by itself on a fresh profile; turn it off so its hint card never covers a control under test.
  await page.locator('.tour-card').getByRole('button', { name: 'Turn tour off' }).click({ timeout: 4_000 }).catch(() => undefined);
  try {
    await page.locator('.project-picker-button').getByText(usesAgentProject ? 'KAI Live Agent Smoke' : 'No project', { exact: true }).waitFor({ timeout: 20_000 });
    await verifyBuildIdentifier(page);
    if (!usesAgentProject) {
      await page.getByText('Open a local repository').waitFor({ timeout: 5_000 });
    }
  } catch (error) {
    const bodyText = await page.locator('body').innerText().catch(() => '<body unavailable>');
    throw new Error(`Desktop workspace did not become ready: ${bodyText}`, { cause: error });
  }
  const agentCapabilities = await verifyAgentCapabilities(page);
  // The basic smoke profile intentionally starts without a project, so composer controls that depend on an
  // active workspace are only exercised by the profiles that provision the live smoke project.
  if (usesAgentProject) await verifyWorkspaceControls(page);
  await verifyCommandPalette(page);
  await verifyDirectApiCapability(page);
  if ((directApiSmoke || mcpSmoke || commandSmoke) && directApiFixture) {
    await verifyDirectApiFlow(page, directApiFixture, mcpSmoke, Boolean(mcpHttpFixture), commandSmoke, directApiProvider);
  }
  if (realAgentSmoke) await verifyLiveAgent(page);

  if (enginePorts) {
    const services = await waitForReadyServices(page, 30_000);
    if (services.find((service) => service.kind === 'cognitive1')?.status !== 'ready') {
      throw new Error('Cognitive1 did not reach ready state in the desktop host.');
    }
    if (services.find((service) => service.kind === 'universalProxy')?.status !== 'ready') {
      throw new Error('Universal Agent Proxy did not reach ready state in the desktop host.');
    }
    const repairedSettings = JSON.parse(await readFile(path.join(userDataDirectory, 'settings.json'), 'utf8'));
    if (repairedSettings.proxy?.defaultModel !== 'deepseek-flash') {
      throw new Error(`Deprecated proxy model was not repaired: ${JSON.stringify(repairedSettings.proxy)}`);
    }
    const proxyAccess = await verifyAuthenticatedLoopback(electronApp, page, enginePorts);
    await verifyOverwatchFlow(electronApp, page, enginePorts.cognitive1);
    await page.screenshot({ path: path.join(outputDirectory, 'services-ready.png') });
    await verifyBrainFlow(electronApp, page, enginePorts.cognitive1);
    await assertPageContentFillsWidth(page, '.brain-panel');
    await page.screenshot({ path: path.join(outputDirectory, 'brain-ready.png') });
    const brainMinimumSize = await resizeWindow(electronApp, 960, 640);
    assertSize(brainMinimumSize, 960, 640);
    await assertNoHorizontalOverflow(page);
    await assertPageContentFillsWidth(page, '.brain-panel');
    await page.screenshot({ path: path.join(outputDirectory, 'brain-960x640.png') });
    await resizeWindow(electronApp, 1440, 920);
    await verifyProxyFlow(page, proxyAccess, enginePorts.universalProxy);
    await page.getByRole('button', { name: 'Universal Proxy' }).click();
    const proxyPanel = page.locator('.proxy-control-centre');
    await proxyPanel.getByRole('heading', { name: 'Proxy Control Centre' }).waitFor();
    await proxyPanel.locator('.agent-card').nth(3).waitFor();
    await proxyPanel.getByRole('heading', { name: 'Diagnostics' }).waitFor();
    await proxyPanel.getByRole('tab', { name: 'Traffic & costs' }).click();
    await proxyPanel.getByRole('heading', { name: 'API Spend' }).waitFor();
    await page.locator('.proxy-request-row').first().waitFor();
    await page.getByText('smoke-model').first().waitFor();
    await page.locator('.proxy-request-row').first().click();
    await page.getByText(/Request detail/).waitFor();
    await page.getByText('Upstream model').waitFor();
    await proxyPanel.getByRole('tab', { name: 'Agents' }).click();
    await proxyPanel.getByRole('heading', { name: 'Claude Login' }).waitFor();
    await proxyPanel.getByRole('tab', { name: 'Providers' }).click();
    await proxyPanel.getByRole('heading', { name: 'Provider preset' }).waitFor();
    await proxyPanel.getByRole('heading', { name: 'Dual API — OpenAI + Claude' }).waitFor();
    await proxyPanel.getByRole('tab', { name: 'Advanced' }).click();
    await proxyPanel.getByRole('heading', { name: 'Dry Run / Preview' }).waitFor();
    await proxyPanel.getByRole('tab', { name: 'Overview' }).click();
    await assertPageContentFillsWidth(page, '.proxy-control-centre');
    await page.screenshot({ path: path.join(outputDirectory, 'proxy-ready.png') });
    const proxyMinimumSize = await resizeWindow(electronApp, 960, 640);
    assertSize(proxyMinimumSize, 960, 640);
    await assertNoHorizontalOverflow(page);
    await assertPageContentFillsWidth(page, '.proxy-control-centre');
    await page.screenshot({ path: path.join(outputDirectory, 'proxy-960x640.png') });
    await resizeWindow(electronApp, 1440, 920);
  }

  const desktopSize = await resizeWindow(electronApp, 1440, 920);
  assertSize(desktopSize, 1440, 920);
  await assertControlsDoNotWrap(page, 'workspace-1440x920');
  await page.screenshot({ path: path.join(outputDirectory, 'workspace-1440x920.png') });
  if (usesAgentProject) await verifyCodeLearningWorkspace(electronApp, page);

  await page.getByRole('button', { name: 'Usage' }).click();
  await page.getByRole('heading', { name: 'Usage', level: 1 }).waitFor();
  await page.getByText('Budget limits').waitFor();
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(outputDirectory, 'usage-1440x920.png') });
  const usageMinimumSize = await resizeWindow(electronApp, 960, 640);
  assertSize(usageMinimumSize, 960, 640);
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(outputDirectory, 'usage-960x640.png') });
  await resizeWindow(electronApp, 1440, 920);

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('heading', { name: 'Settings' }).waitFor();
  // Settings is split into categories; the vault status sits with the connections, Overwatch with the services.
  await openSettingsCategory(page, 'Connections and models');
  await page.getByText('OS vault available').waitFor();
  await openSettingsCategory(page, 'Services and access');
  const overwatchHeading = page.getByText('AI Overwatch', { exact: true });
  await overwatchHeading.waitFor();
  await page.getByRole('checkbox', { name: /Enable Overwatch/ }).waitFor();
  await overwatchHeading.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(outputDirectory, 'settings-overwatch-1440x920.png') });
  const directApiSection = page.locator('section.settings-section').filter({ has: page.getByText('Direct API', { exact: true }) });
  const providerSelect = directApiSection.locator('label.field:has(span:text-is("Provider")) > .kai-select');
  const providerOptions = await optionLabels(providerSelect);
  if (!providerOptions.includes('OpenRouter') || !providerOptions.includes('DeepSeek API')) {
    throw new Error(`Direct API provider presets are incomplete: ${providerOptions.join(', ')}`);
  }
  const learningApiSection = page.locator('section.settings-section').filter({ has: page.getByText('Learning Tutor API', { exact: true }) });
  await learningApiSection.getByText('Dedicated provider connection for Learn, Guided, Pair, and Copilot.', { exact: false }).waitFor();
  await learningApiSection.getByRole('button', { name: 'Refresh models' }).waitFor();
  const learningProviderSelect = learningApiSection.locator('label.field:has(span:text-is("Provider")) > .kai-select');
  const learningProviderOptions = await optionLabels(learningProviderSelect);
  if (!learningProviderOptions.includes('OpenRouter') || !learningProviderOptions.includes('DeepSeek API')) {
    throw new Error(`Learning Tutor provider presets are incomplete: ${learningProviderOptions.join(', ')}`);
  }
  await verifySelectContrast(providerSelect, 'Direct API provider');
  // The save bar is always on screen and reports the state of every card, including the managed services.
  await page.getByText('All changes saved').waitFor();
  await page.locator('.service-status').first().waitFor();
  if (await page.locator('.service-status').count() < 2) {
    throw new Error('Managed services did not show live status for C1 and the Universal Proxy.');
  }
  await assertNoErrorBanner(page);
  await assertControlsDoNotWrap(page, 'settings-1440x920');
  await page.screenshot({ path: path.join(outputDirectory, 'settings-1440x920.png') });

  await page.getByRole('button', { name: 'Workflows' }).click();
  await page.getByRole('heading', { name: 'Workflows', level: 1 }).waitFor();
  await page.getByLabel('Step 1 agent').waitFor();
  await page.getByLabel('Step 1 prompt').waitFor();
  await assertNoHorizontalOverflow(page);
  await assertPageContentFillsWidth(page, '.workflow-builder');
  await assertControlsDoNotWrap(page, 'workflows-1440x920');
  await page.screenshot({ path: path.join(outputDirectory, 'workflows-1440x920.png') });

  await page.getByRole('button', { name: 'Add step' }).click();
  await page.getByLabel('Step 2 prompt').waitFor();
  await page.getByRole('button', { name: 'Remove step 2' }).click();
  await page.getByLabel('Step 2 prompt').waitFor({ state: 'detached' });

  await page.getByRole('button', { name: 'History' }).click();
  await page.getByRole('heading', { name: 'History', level: 1 }).waitFor();
  await assertPageContentFillsWidth(page, '.history-search');
  await assertPageContentFillsWidth(page, '.history-table');
  await assertControlsDoNotWrap(page, 'history-1440x920');
  await page.screenshot({ path: path.join(outputDirectory, 'history-1440x920.png') });

  const settingsMinimumSize = await resizeWindow(electronApp, 960, 640);
  assertSize(settingsMinimumSize, 960, 640);
  await page.getByRole('button', { name: 'Workflows' }).click();
  await page.getByRole('heading', { name: 'Workflows', level: 1 }).waitFor();
  await assertNoHorizontalOverflow(page);
  await assertPageContentFillsWidth(page, '.workflow-builder');
  await assertControlsDoNotWrap(page, 'workflows-960x640');
  await page.screenshot({ path: path.join(outputDirectory, 'workflows-960x640.png') });

  await page.getByRole('button', { name: 'History' }).click();
  await page.getByRole('heading', { name: 'History', level: 1 }).waitFor();
  await assertPageContentFillsWidth(page, '.history-search');
  await assertPageContentFillsWidth(page, '.history-table');
  await assertControlsDoNotWrap(page, 'history-960x640');
  await page.screenshot({ path: path.join(outputDirectory, 'history-960x640.png') });

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor();
  await assertNoHorizontalOverflow(page);
  await assertPageContentFillsWidth(page, '.settings-categories');
  await assertControlsDoNotWrap(page, 'settings-960x640');
  await page.screenshot({ path: path.join(outputDirectory, 'settings-960x640.png') });
  await verifyControlsOnEveryPage(page, '960x640');
  await resizeWindow(electronApp, 1440, 920);
  await verifyControlsOnEveryPage(page, '1440x920');

  await page.getByRole('button', { name: 'Workspace' }).click();
  await page.getByRole('button', { name: 'Show context panel' }).waitFor();
  if (await page.locator('.context-panel').count() > 0) {
    throw new Error('The context panel should start minimised.');
  }
  await page.getByRole('button', { name: 'Show context panel' }).click();
  await page.getByRole('button', { name: 'Hide context panel' }).click();
  await page.locator('.context-panel').waitFor({ state: 'detached' });

  const minimumSize = await resizeWindow(electronApp, 960, 640);
  assertSize(minimumSize, 960, 640);
  await assertControlsDoNotWrap(page, 'workspace-960x640');
  if (usesAgentProject) await verifySkillsDialogFitsViewport(page);
  await page.screenshot({ path: path.join(outputDirectory, 'workspace-960x640.png') });

  if (rendererErrors.length > 0) {
    throw new Error(`Renderer errors: ${rendererErrors.join(' | ')}`);
  }

  console.log(
    `KAI desktop smoke passed. Agents: ${agentCapabilities
      .map((agent) => `${agent.id}=${agent.available ? 'ready' : 'unavailable'}`)
      .join(', ')}. Screenshots: ${outputDirectory}`,
  );
} finally {
  await electronApp?.close();
  await directApiFixture?.close();
  await mcpHttpFixture?.close();
  if (process.env.KAI_SMOKE_KEEP_USER_DATA === '1') {
    console.log(`KAI smoke user data preserved at ${userDataDirectory}`);
  } else {
    await rm(userDataDirectory, { recursive: true, force: true });
  }
}

async function verifyLiveAgent(page) {
  await page.getByText('CLI ready').waitFor({ timeout: 20_000 });
  const textarea = page.getByLabel('Task prompt');
  await textarea.fill('Reply with exactly KAI_CLI_OK. Do not run any tools.');
  const sendButton = page.getByRole('button', { name: 'Start conversation' });
  await page.waitForFunction(() => {
    const button = document.querySelector('button[aria-label="Start conversation"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  });
  await sendButton.click();
  await page
    .locator('article.assistant .message-body')
    .filter({ hasText: 'KAI_CLI_OK' })
    .waitFor({ timeout: 120_000 });

  const conversations = await page.evaluate(() => window.kaiDesktop.listConversations());
  if (!conversations.ok || conversations.data.length < 1) {
    throw new Error(`The live agent conversation was not persisted: ${JSON.stringify(conversations)}`);
  }
  const turns = conversations.data[0].turns;
  if (!turns.some((turn) => turn.role === 'assistant' && turn.text.includes('KAI_CLI_OK'))) {
    throw new Error(`The live agent reply was not persisted: ${JSON.stringify(turns)}`);
  }
}

async function verifyAgentCapabilities(page) {
  const response = await page.evaluate(() => window.kaiDesktop.agentCapabilities());
  if (!response.ok) throw new Error(response.error.message);
  const expected = ['claude', 'codex', 'qwen', 'gemini', 'kimi'];
  const ids = response.data.map((agent) => agent.id);
  if (expected.some((id) => !ids.includes(id))) {
    throw new Error(`Agent capability discovery is incomplete: ${ids.join(', ')}.`);
  }
  for (const agent of response.data) {
    if (agent.available && !agent.version) {
      throw new Error(`${agent.displayName} was reported ready without a version.`);
    }
    if (agent.available && agent.state !== 'ready') {
      throw new Error(`${agent.displayName} is available but reported state ${agent.state}.`);
    }
    if (!agent.available && !agent.unavailableReason) {
      throw new Error(`${agent.displayName} was unavailable without an explanation.`);
    }
    if (!agent.available && !['signed_out', 'not_installed', 'unavailable'].includes(agent.state)) {
      throw new Error(`${agent.displayName} was unavailable with an invalid setup state: ${agent.state}.`);
    }
    if (!agent.signInCommand || !agent.installUrl) {
      throw new Error(`${agent.displayName} did not report desktop setup guidance.`);
    }
  }
  return response.data;
}

async function verifyWorkspaceControls(page) {
  // The agent, model, route and autonomy menus live behind the composer's Advanced toggle.
  if (await page.getByRole('button', { name: 'Agent', exact: true }).count() === 0) {
    // The toggle reads "Work locally" (or "Hide" once open), so it is found by its class.
    await page.locator('.composer-advanced-toggle').click();
    await page.getByRole('button', { name: 'Agent', exact: true }).waitFor();
  }
  const agents = [
    ['claude', 'Claude'],
    ['codex', 'Codex'],
    ['qwen', 'Qwen Code'],
    ['gemini', 'Gemini CLI'],
    ['kimi', 'Kimi Code'],
  ];
  for (const [agent, label] of agents) {
    await selectMenuOption(page, 'Agent', label);
    try {
      await page.waitForFunction((expected) => {
        const trigger = document.querySelector('button[aria-label="Agent"]');
        return trigger?.textContent?.includes(expected) ?? false;
      }, label, { timeout: 5_000 });
    } catch (error) {
      const actual = await page.getByRole('button', { name: 'Agent', exact: true }).innerText();
      throw new Error(`Agent menu did not select ${agent}. Expected ${label}, received ${JSON.stringify(actual)}.`, { cause: error });
    }
    const selected = await page.getByRole('button', { name: 'Agent', exact: true }).innerText();
    if (!selected.includes(label)) {
      throw new Error(`The workspace did not switch to the ${agent} agent; selected value was ${JSON.stringify(selected)}.`);
    }
  }
  await selectMenuOption(page, 'Agent', /^Codex$/);
  await verifyMenuContrast(page, 'Agent');

  const autonomyModes = [
    ['plan', 'Plan'],
    ['ask', 'Ask'],
    ['autoEdit', 'Auto-edit'],
    ['full', 'Full control'],
    ['custom', 'Custom'],
  ];
  for (const [mode, label] of autonomyModes) {
    await selectMenuOption(page, 'Autonomy', label);
    const selected = await page.getByRole('button', { name: 'Autonomy', exact: true }).innerText();
    if (!selected.includes(label)) {
      throw new Error(`The workspace did not switch to the ${mode} autonomy mode.`);
    }
  }
  await selectMenuOption(page, 'Autonomy', 'Ask');
  await verifyMenuContrast(page, 'Autonomy');

  const route = page.getByRole('button', { name: 'Route', exact: true });
  if (!await route.isDisabled()) {
    throw new Error('CLI routing should keep the route control disabled in direct mode.');
  }
  if (!(await route.innerText()).includes('Direct')) {
    throw new Error(`CLI routing should begin in direct mode, received ${await route.innerText()}.`);
  }

  await verifyThemeToggle(page);
}

async function verifyThemeToggle(page) {
  const initialTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  if (initialTheme !== 'dark') throw new Error(`The workspace should begin in dark mode, received ${initialTheme}.`);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await page.evaluate(() => document.documentElement.dataset.theme === 'light')) break;
    await page.getByRole('button', { name: /^Theme:/ }).click({ force: true });
    await page.waitForTimeout(150);
  }
  if (!await page.evaluate(() => document.documentElement.dataset.theme === 'light')) {
    throw new Error('The title-bar theme control did not cycle to light mode.');
  }
  await waitForPage(page, async () => {
    const response = await window.kaiDesktop.getSettings();
    return response.ok && response.data.theme === 'light';
  }, undefined, { message: 'The light theme was not saved.' });
  await assertNoHorizontalOverflow(page);
  await verifyMenuContrast(page, 'Agent');
  await page.screenshot({ path: path.join(outputDirectory, 'theme-light.png') });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await page.evaluate(() => document.documentElement.dataset.theme === 'dark')) break;
    await page.getByRole('button', { name: /^Theme:/ }).click({ force: true });
    await page.waitForTimeout(150);
  }
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
}

async function verifyBuildIdentifier(page) {
  const response = await page.evaluate(() => window.kaiDesktop.bootstrap());
  if (!response.ok || !response.data.buildIdentifier || response.data.buildIdentifier.includes('unidentified')) {
    throw new Error(`The desktop build identifier is missing: ${JSON.stringify(response)}`);
  }
  const rail = await page.locator('.rail-footer span').getAttribute('title');
  const suffix = response.data.buildIdentifier.split('+').at(-1);
  if (!suffix || !rail?.includes(suffix)) {
    throw new Error(`The desktop UI did not expose build identifier ${response.data.buildIdentifier}: ${rail ?? '<missing title>'}`);
  }
}

async function verifySkillsDialogFitsViewport(page) {
  const canvas = page.locator('.conversation-canvas');
  await canvas.evaluate((element) => { element.style.minHeight = '1400px'; });
  await page.locator('.composer-box textarea').fill('$');
  const dialog = page.getByRole('dialog', { name: 'Skills' });
  await dialog.waitFor();
  const panelBounds = await dialog.locator('.skills-panel').boundingBox();
  const viewport = page.viewportSize();
  if (!panelBounds || !viewport) throw new Error('Could not measure the Skills dialog.');
  if (panelBounds.x < 0 || panelBounds.y < 0 || panelBounds.x + panelBounds.width > viewport.width || panelBounds.y + panelBounds.height > viewport.height) {
    throw new Error(`Skills dialog is outside the viewport: ${JSON.stringify({ panelBounds, viewport })}`);
  }
  await page.getByRole('button', { name: 'Close skills' }).click();
  await canvas.evaluate((element) => { element.style.minHeight = ''; });
  await page.locator('.composer-box textarea').fill('');
}

async function verifyCodeLearningWorkspace(application, page) {
  if (directApiFixture) {
    const credential = await page.evaluate(() => window.kaiDesktop.setCredential('provider.openai', 'sk-local-smoke'));
    if (!credential.ok) throw new Error(credential.error.message);
    const settings = await page.evaluate((baseUrl) => window.kaiDesktop.updateSettings({ learningTutor: { enabled: true, provider: 'openai', model: 'smoke-api-model', baseUrl, credentialId: 'provider.openai' } }), directApiFixture.baseUrl);
    if (!settings.ok) throw new Error(settings.error.message);
  }
  await page.getByRole('button', { name: 'Learn: Learn & Code' }).click();
  await page.locator('.code-view').waitFor();
  await page.locator('.code-tree-item').getByText('AGENTS.md', { exact: true }).click();
  await page.locator('.learning-panel').waitFor();
  await page.getByRole('textbox', { name: 'Tutor question' }).waitFor();
  await page.getByRole('textbox', { name: 'Tutor question' }).fill('Explain this file.');
  await page.getByRole('button', { name: 'Ask tutor' }).click();
  try {
    await page.getByRole('heading', { name: 'KAI Learning Mode response', level: 2 }).waitFor({ timeout: 20_000 });
  } catch (error) {
    const panelText = await page.locator('.learning-panel').innerText().catch(() => '<panel unavailable>');
    throw new Error(`The selected-code tutor response did not render. Panel text: ${panelText}`, { cause: error });
  }
  await page.locator('.learning-response .learning-question').getByText('Variables hold changing values.').waitFor();
  await page.getByRole('textbox', { name: 'Tutor question' }).fill('What should I do next?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await page.locator('.learning-pending-turn .learning-chat-question').getByText('What should I do next?').waitFor();
  await page.locator('.learning-pending-reply').getByText('Tutor is replying...').waitFor();
  await page.locator('.learning-pending-turn').waitFor({ state: 'detached' });
  await page.locator('.learning-chat-question').getByText('What should I do next?').waitFor();
  if (await page.locator('.learning-response').count() < 2) throw new Error('The follow-up tutor response did not join the conversation.');
  await page.getByRole('textbox', { name: 'Your explanation' }).fill('The project rules live in AGENTS.md and guide the agent when it opens this project.');
  await page.getByRole('button', { name: 'Check my answer' }).click();
  const nextLessonButton = page.getByRole('button', { name: /Ask tutor (to start next step|for a new challenge)/ });
  await nextLessonButton.waitFor();
  await page.locator('.learning-next-lesson').waitFor();
  if (await page.locator('.learning-pending-turn').count()) throw new Error('A graded answer started an unrequested tutor conversation.');
  await nextLessonButton.click();
  await page.waitForFunction(() => document.querySelectorAll('.learning-response').length >= 3);
  await page.locator('.learning-chat-action').getByText('KAI action').waitFor();
  await page.screenshot({ path: path.join(outputDirectory, 'code-learning-tutor-1440x920.png') });
  await page.getByRole('tab', { name: 'Progress' }).click();
  await page.getByText('Variables', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Teaching' }).click();
  await page.getByText('KAI Guided Discovery', { exact: true }).first().waitFor();
  await page.getByText(/KAI-owned Markdown:/).waitFor();
  await page.screenshot({ path: path.join(outputDirectory, 'teaching-library-1440x920.png') });
  await page.getByRole('tab', { name: 'Git' }).click();
  await page.locator('.learning-git').getByText(/Working tree:|not a Git repository/).waitFor();
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(outputDirectory, 'code-learning-1440x920.png') });

  await resizeWindow(application, 960, 640);
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(outputDirectory, 'code-learning-960x640.png') });
  await page.getByRole('tab', { name: 'Teaching' }).click();
  await page.getByText('KAI Guided Discovery', { exact: true }).first().waitFor();
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(outputDirectory, 'teaching-library-960x640.png') });
  await page.getByRole('tab', { name: 'Tutor' }).click();
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(outputDirectory, 'code-learning-tutor-960x640.png') });
  await resizeWindow(application, 1440, 920);
}

async function verifyCommandPalette(page) {
  await page.getByRole('button', { name: 'Open command palette' }).click({ force: true });
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.waitFor();
  await palette.getByLabel('Search commands').fill('Execution Rules');
  await page.screenshot({ path: path.join(outputDirectory, 'command-palette.png') });
  await palette.getByRole('option', { name: /View and Edit Execution Rules/ }).click();
  await page.getByRole('heading', { name: 'Execution Rules', level: 1 }).waitFor();

  await page.keyboard.press('Control+K');
  await palette.waitFor();
  await palette.getByLabel('Search commands').fill('Open Agent Workbench');
  await palette.getByRole('option', { name: /Open Agent Workbench/ }).click();
  await page.getByLabel('Task prompt').waitFor();
}

/** Opens every page in the navigation rail and checks that none of its controls wrap their text. */
async function verifyControlsOnEveryPage(page, size) {
  const labels = await page.locator('.nav-rail button[aria-label]').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
  for (const label of labels) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await page.waitForTimeout(400);
    await assertControlsDoNotWrap(page, `${label} at ${size}`);
    await assertTextIsNotClipped(page, `${label} at ${size}`);
  }
  await page.getByRole('button', { name: 'Work: Workspace', exact: true }).click();
}

async function selectMenuOption(page, triggerLabel, optionName) {
  await openSelectMenu(page, triggerLabel);
  const listbox = page.getByRole('listbox', { name: triggerLabel, exact: true });
  // An option's accessible name is its label followed by its description, and the descriptions overlap: "Ask" is a
  // prefix of "Ask KAI asks your permission" but also sits inside "asks before risky commands" and "without asking",
  // so a plain name match resolved to three options. A string names the label, so anchor it there. A regular
  // expression is passed through, since the caller already knows what it wants.
  const option = typeof optionName === 'string'
    ? listbox.getByRole('option', { name: new RegExp(`^${optionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`) })
    : listbox.getByRole('option', { name: optionName });
  await option.click({ force: true });
}

async function verifyMenuContrast(page, label) {
  await openSelectMenu(page, label);
  const options = page.getByRole('listbox', { name: label, exact: true }).getByRole('option');
  const firstOption = options.first();
  const colors = await firstOption.evaluate((element) => {
    const style = getComputedStyle(element);
    const parentStyle = getComputedStyle(element.parentElement);
    const transparent = style.backgroundColor === 'transparent' || style.backgroundColor === 'rgba(0, 0, 0, 0)';
    return {
      background: transparent ? parentStyle.backgroundColor : style.backgroundColor,
      color: style.color,
    };
  });
  const ratio = contrastRatio(colors.color, colors.background);
  if (ratio < 4.5) {
    throw new Error(`${label} menu has insufficient contrast (${ratio.toFixed(2)}): ${JSON.stringify(colors)}.`);
  }
  await page.keyboard.press('Escape');
}

async function openSelectMenu(page, label) {
  const trigger = page.getByRole('button', { name: label, exact: true });
  try {
    await page.waitForFunction((name) => {
      const button = Array.from(document.querySelectorAll('button')).find((element) => element.getAttribute('aria-label') === name);
      return button instanceof HTMLButtonElement && !button.disabled;
    }, label);
  } catch (error) {
    const state = await page.evaluate((name) => {
      const buttons = Array.from(document.querySelectorAll('button')).filter((element) => element.getAttribute('aria-label') === name);
      return {
        matching: buttons.map((button) => ({ disabled: button.disabled, text: button.textContent })),
        activity: document.querySelector('.thinking, .status-word')?.textContent ?? null,
        view: document.querySelector('h1')?.textContent ?? null,
        notice: document.querySelector('.agent-setup-banner, .rules-error, .error-banner')?.textContent?.slice(0, 200) ?? null,
      };
    }, label).catch(() => null);
    await page.screenshot({ path: path.join(outputDirectory, `menu-${label.toLowerCase()}-unavailable.png`) }).catch(() => undefined);
    throw new Error(`The "${label}" menu never became available: ${JSON.stringify(state)}`, { cause: error });
  }
  const listbox = page.getByRole('listbox', { name: label, exact: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await trigger.click({ force: true });
    try {
      await listbox.waitFor({ state: 'visible', timeout: attempt === 0 ? 5_000 : 15_000 });
      return;
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
}

async function verifySelectContrast(select, label) {
  // KAI's dropdown draws its list in a layer of its own, so read the colours there while it is open.
  await select.click();
  const list = select.page().locator('.kai-select-list');
  await list.locator('[role="option"]').first().waitFor();
  const colors = await list.evaluate((element) => {
    const option = element.querySelector('[role="option"]:not(.selected):not(:disabled)') ?? element.querySelector('[role="option"]');
    return {
      background: getComputedStyle(element).backgroundColor,
      optionColor: option ? getComputedStyle(option).color : '',
    };
  });
  await select.page().keyboard.press('Escape');
  const opaqueBackground = colors.background !== 'transparent' && colors.background !== 'rgba(0, 0, 0, 0)';
  if (!opaqueBackground || contrastRatio(colors.optionColor, colors.background) < 4.5) {
    throw new Error(
      `${label} dropdown has unsafe contrast: ${JSON.stringify(colors)}.`,
    );
  }
}

function contrastRatio(foreground, background) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(color) {
  const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) throw new Error(`Could not parse menu color: ${color}`);
  const channels = match.slice(1, 4).map((value) => Number(value) / 255).map((value) => (
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

async function verifyDirectApiCapability(page) {
  const response = await page.evaluate(() => window.kaiDesktop.directApiCapability());
  if (!response.ok) throw new Error(response.error.message);
  const capability = response.data;
  if (capability.available && (!capability.enabled || !capability.model || !capability.credentialStored)) {
    throw new Error(`Direct API was reported ready without complete configuration: ${JSON.stringify(capability)}.`);
  }
  if (!capability.available && !capability.unavailableReason) {
    throw new Error('Direct API was unavailable without an explanation.');
  }
}

async function verifyDirectApiFlow(page, fixture, usesMcp, usesRemoteMcp = false, usesCommand = false, provider = 'openai') {
  if (provider !== 'openai' && (usesMcp || usesCommand)) {
    throw new Error('Chat Completions smoke currently covers the plain direct API flow.');
  }
  const credentialId = provider === 'openrouter'
    ? 'provider.openrouter'
    : provider === 'deepseek'
      ? 'provider.deepseek'
      : 'provider.openai';
  const credential = await page.evaluate((id) => window.kaiDesktop.setCredential(id, 'sk-local-smoke'), credentialId);
  if (!credential.ok) throw new Error(credential.error.message);
  if (usesRemoteMcp) {
    const mcpCredential = await page.evaluate(({ id, value }) => window.kaiDesktop.setCredential(id, value), {
      id: mcpHttpCredentialId,
      value: mcpHttpAuthorization,
    });
    if (!mcpCredential.ok) throw new Error(mcpCredential.error.message);
  }
  const settings = await page.evaluate(({ baseUrl, provider, credentialId }) => window.kaiDesktop.updateSettings({
    directApi: {
      enabled: true,
      provider,
      model: 'smoke-api-model',
      baseUrl,
      credentialId,
    },
  }), { baseUrl: fixture.baseUrl, provider, credentialId });
  if (!settings.ok) throw new Error(settings.error.message);

  await page.reload();
  await page.locator('.project-picker-button').getByText('KAI Live Agent Smoke', { exact: true }).waitFor({ timeout: 20_000 });
  const contextPreview = await page.evaluate(() => window.kaiDesktop.previewContext({ projectId: 'project-live-agent-smoke' }));
  if (!contextPreview.ok || contextPreview.data.estimatedTokens < 1) {
    throw new Error(`Project context preview was not populated: ${JSON.stringify(contextPreview)}`);
  }
  await page.getByText('Estimated direct API context').waitFor();
  await page.locator('.context-meter strong').filter({ hasText: '~' }).waitFor();
  await page.getByRole('button', { name: 'API' }).click();
  await page.getByText('API ready').waitFor();
  const routeMenu = page.getByRole('button', { name: 'Route', exact: true });
  if (await routeMenu.isDisabled()) throw new Error('The route menu should be enabled in API mode.');
  await verifyMenuContrast(page, 'Route');
  const providerChip = page.locator('.api-provider-chip');
  const expectedProvider = provider === 'openrouter' ? 'OpenRouter' : provider === 'deepseek' ? 'DeepSeek API' : 'OpenAI Responses API';
  await providerChip.filter({ hasText: expectedProvider }).waitFor();
  await providerChip.filter({ hasText: 'smoke-api-model' }).waitFor();
  const textarea = page.getByLabel('Task prompt');
  const expectedReply = usesMcp ? 'KAI_MCP_OK' : usesCommand ? 'KAI_COMMAND_OK' : 'KAI_API_OK';
  await textarea.fill(usesMcp
    ? 'Use the MCP echo tool, then reply with KAI_MCP_OK.'
    : usesCommand
      ? 'Run the project command tool, then reply with KAI_COMMAND_OK.'
      : 'Reply with exactly KAI_API_OK. Do not use tools.');
  await page.getByRole('button', { name: 'Start conversation' }).click();
  if (usesCommand) await page.getByRole('button', { name: 'Allow once' }).click();
  await page.locator('article.assistant .message-body').filter({ hasText: expectedReply }).waitFor({ timeout: 20_000 });

  const expectedRequests = usesMcp || usesCommand ? 2 : 1;
  if (fixture.requests.length !== expectedRequests) {
    throw new Error(`Expected ${expectedRequests} direct API request(s), received ${fixture.requests.length}.`);
  }
  const request = fixture.requests[0];
  if (request.authorization !== 'Bearer sk-local-smoke') {
    throw new Error('The direct API request did not use the OS-vault credential.');
  }
  if (request.body.model !== 'smoke-api-model' || request.body.stream !== true) {
    throw new Error(`The direct API request was malformed: ${JSON.stringify(request.body)}.`);
  }
  const requestWithRules = JSON.stringify(request.body);
  if (!requestWithRules.includes('Authoritative Cognitive1 standing instructions') || !requestWithRules.includes('57. **Keep the brain clean**')) {
    throw new Error(`The bundled Cognitive1 standing instructions were not injected into the direct API request: ${requestWithRules.slice(0, 2_000)}`);
  }
  if (provider !== 'openai' && !Array.isArray(request.body.messages)) {
    throw new Error(`The Chat Completions request did not include messages: ${JSON.stringify(request.body)}.`);
  }
  if (provider !== 'openai' && request.path !== '/v1/chat/completions') {
    throw new Error(`The Chat Completions request used the wrong path: ${request.path}.`);
  }
  if (usesMcp) {
    const toolNames = Array.isArray(request.body.tools)
      ? request.body.tools.map((tool) => tool?.name).filter(Boolean)
      : [];
    if (!toolNames.includes('mcp_smoke_echo')) {
      throw new Error(`The MCP tool was not exposed to the provider: ${JSON.stringify(toolNames)}.`);
    }
    const followUp = fixture.requests[1];
    if (followUp.body.previous_response_id !== 'resp-mcp-tool' || !JSON.stringify(followUp.body.input).includes('echo:from-smoke')) {
      throw new Error(`The MCP tool result was not returned to the provider: ${JSON.stringify(followUp.body)}.`);
    }
  }
  if (usesCommand) {
    const toolNames = Array.isArray(request.body.tools)
      ? request.body.tools.map((tool) => tool?.name).filter(Boolean)
      : [];
    if (!toolNames.includes('run_command')) {
      throw new Error(`The command tool was not exposed to the provider: ${JSON.stringify(toolNames)}.`);
    }
    const followUp = fixture.requests[1];
    if (followUp.body.previous_response_id !== 'resp-command-tool' || !JSON.stringify(followUp.body.input).includes('command-smoke-output')) {
      throw new Error(`The command result was not returned to the provider: ${JSON.stringify(followUp.body)}.`);
    }
  }

  const conversations = await page.evaluate(() => window.kaiDesktop.listConversations());
  if (!conversations.ok || !conversations.data[0]?.turns.some((turn) => turn.role === 'assistant' && turn.text.includes(expectedReply))) {
    throw new Error(`The direct API reply was not persisted: ${JSON.stringify(conversations)}.`);
  }
}

async function waitForReadyServices(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await page.evaluate(() => window.kaiDesktop.serviceStatus());
    if (!response.ok) throw new Error(response.error.message);
    if (response.data.every((service) => ['ready', 'failed'].includes(service.status))) return response.data;
    await page.waitForTimeout(250);
  }
  throw new Error('Managed services did not finish starting before the timeout.');
}

async function writeEngineSettings(directory, ports) {
  const settings = {
    schemaVersion: 1,
    defaultAgent: 'codex',
    defaultRoute: 'direct',
    defaultAutonomy: 'ask',
    theme: 'dark',
    activeProjectId: null,
    projectOrder: [],
    windowBounds: null,
    logRetentionEntries: 2000,
    diagnosticsEnabled: true,
    cognitive1: {
      enabled: true,
      endpoint: `http://127.0.0.1:${ports.cognitive1}`,
      dataPath: null,
    },
    proxy: {
      enabled: true,
      port: ports.universalProxy,
      targetBaseUrl: 'http://127.0.0.1:19999/v1',
      defaultModel: 'deepseek-v4.1-flash',
      credentialId: 'provider.deepseek',
    },
  };
  await writeFile(path.join(directory, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

async function writeAgentSettings(
  directory,
  projectPath,
  directApiFixture = null,
  includeMcp = false,
  remoteMcpUrl = null,
  provider = 'openai',
) {
  await mkdir(projectPath, { recursive: true });
  await writeFile(path.join(projectPath, 'AGENTS.md'), '# Smoke project rules\nKeep context estimates visible.\n', 'utf8');
  const now = new Date().toISOString();
  const project = {
    schemaVersion: 1,
    id: 'project-live-agent-smoke',
    name: 'KAI Live Agent Smoke',
    path: projectPath,
    createdAt: now,
    lastOpenedAt: now,
  };
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
    directApi: {
      enabled: Boolean(directApiFixture),
      provider,
      model: directApiFixture ? 'smoke-api-model' : '',
      baseUrl: directApiFixture?.baseUrl ?? 'https://api.openai.com/v1',
      credentialId: provider === 'openrouter'
        ? 'provider.openrouter'
        : provider === 'deepseek'
          ? 'provider.deepseek'
          : 'provider.openai',
    },
    mcpServers: includeMcp ? [remoteMcpUrl ? {
      id: 'smoke',
      name: 'KAI Smoke MCP',
      enabled: true,
      transport: 'http',
      url: remoteMcpUrl,
      headerCredentialIds: { Authorization: mcpHttpCredentialId },
    } : {
      id: 'smoke',
      name: 'KAI Smoke MCP',
      enabled: true,
      transport: 'stdio',
      command: process.execPath,
      args: [path.join(appRoot, '..', '..', 'test', 'fixtures', 'mcp-echo-server.mjs')],
      cwd: null,
      envCredentialIds: {},
    }] : [],
    cognitive1: {
      enabled: false,
      endpoint: 'http://127.0.0.1:9876',
      dataPath: null,
    },
    proxy: {
      enabled: false,
      port: 8082,
      targetBaseUrl: 'https://api.deepseek.com',
      defaultModel: 'deepseek-flash',
      credentialId: 'provider.deepseek',
    },
  };
  await writeFile(path.join(directory, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  await writeFile(
    path.join(directory, 'projects.json'),
    `${JSON.stringify({ schemaVersion: 1, projects: [project] }, null, 2)}\n`,
    'utf8',
  );
}

async function startMcpHttpFixture() {
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' });
      response.end();
      return;
    }
    if (request.headers.authorization !== mcpHttpAuthorization) {
      response.writeHead(401);
      response.end();
      return;
    }
    try {
      const mcp = new McpServer({ name: 'kai-smoke-http-mcp', version: '1.0.0' });
      mcp.registerTool(
        'echo',
        {
          description: 'Echo text for the packaged Streamable HTTP smoke.',
          inputSchema: { text: z.string() },
          annotations: { readOnlyHint: true },
        },
        async ({ text }) => ({ content: [{ type: 'text', text: `echo:${text}` }] }),
      );
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await mcp.connect(transport);
      await transport.handleRequest(request, response, await readJsonBody(request));
      response.once('close', () => {
        void transport.close();
        void mcp.close();
      });
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: String(error) }, id: null }));
      }
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Streamable HTTP MCP fixture did not bind a TCP port.');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

async function startDirectApiFixture({ mcp = false, command = false, provider = 'openai' } = {}) {
  const requests = [];
  let requestCount = 0;
  const server = http.createServer(async (request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { raw += chunk; });
    await new Promise((resolve) => request.on('end', resolve));
    requestCount += 1;
    const body = JSON.parse(raw);
    requests.push({
      path: request.url,
      authorization: request.headers.authorization,
      body,
    });
    if (body?.text?.format?.name === 'kai_learning_tutor_response') {
      await new Promise((resolve) => setTimeout(resolve, 350));
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ output_text: JSON.stringify(learningTutorFixture()) }));
      return;
    }
    if (body?.text?.format?.name === 'kai_explain_back_grade') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ output_text: JSON.stringify({ verdict: 'solid', feedback: 'You connected the file to its purpose.', gap: '' }) }));
      return;
    }
    if (provider !== 'openai') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"KAI_API_"},"finish_reason":null}]}\n\n');
      response.end('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":3}}\n\ndata: [DONE]\n\n');
      return;
    }
    if (mcp && requestCount === 1) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-mcp-tool","output":[{"type":"function_call","id":"fc_mcp","call_id":"call_mcp","name":"mcp_smoke_echo","arguments":"{\\"text\\":\\"from-smoke\\"}"}]}}\n\n');
      return;
    }
    if (command && requestCount === 1) {
      const commandText = `"${process.execPath}" -e "process.stdout.write('command-smoke-output')"`;
      const call = {
        type: 'function_call',
        id: 'fc_command',
        call_id: 'call_command',
        name: 'run_command',
        arguments: JSON.stringify({ command: commandText }),
      };
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp-command-tool', output: [call] } })}\n\n`);
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp-local-smoke"}}\n\n');
    await new Promise((resolve) => setTimeout(resolve, 25));
    const replyPrefix = mcp ? 'KAI_MCP_' : command ? 'KAI_COMMAND_' : 'KAI_API_';
    response.write(`event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"${replyPrefix}"}\n\n`);
    await new Promise((resolve) => setTimeout(resolve, 25));
    response.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"OK"}\n\n');
    const finalResponseId = mcp ? 'resp-mcp-final' : command ? 'resp-command-final' : 'resp-local-smoke';
    response.end(`event: response.completed\ndata: {"type":"response.completed","response":{"id":"${finalResponseId}","usage":{"input_tokens":8,"output_tokens":3}}}\n\n`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Direct API smoke server did not bind to a TCP port.');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function learningTutorFixture() {
  return {
    title: 'KAI Learning Mode response',
    recap: 'The file tree and editor are already available. This block explains the project rules file.',
    purpose: 'Connect the visible Markdown guidance to the way an agent receives project instructions.',
    analogy: {
      title: 'A project welcome board',
      explanation: 'A welcome board states the shared rules before people begin work.',
      mappings: [{
        analogyPart: 'Welcome board',
        codePart: 'AGENTS.md',
        explanation: 'The file is read as shared instruction context before work begins.',
      }],
      limits: 'A board cannot enforce behaviour by itself, and neither can a rules file without host enforcement.',
    },
    steps: [{
      title: 'Read the instructions',
      explanation: 'The desktop host includes the project rules before asking a provider to act.',
    }],
    concepts: [{
      name: 'Variables',
      category: 'Documentation',
      mastery: 'introduced',
      evidence: 'The learner opened a rules file and requested an explanation.',
    }],
    codePreview: '# Smoke project rules',
    lineByLine: [{
      line: '# Smoke project rules',
      explanation: 'The heading names the purpose of this instruction file.',
    }],
    checks: ['Where should a project-wide instruction be recorded so the host can load it?'],
    sourceNotes: [{ label: 'Project convention', url: null }],
    followUpQuestion: 'Variables hold changing values. Which file did you just inspect?',
    suggestion: null,
  };
}

async function verifyAuthenticatedLoopback(application, page, ports) {
  const cognitive1Token = await copyAccessToken(application, page, 'cognitive1');
  await expectStatus(`http://127.0.0.1:${ports.cognitive1}/health`, undefined, 401);
  await expectStatus(`http://127.0.0.1:${ports.cognitive1}/health`, cognitive1Token, 200);

  const originalProxyToken = await copyAccessToken(application, page, 'universalProxy');
  await expectStatus(`http://127.0.0.1:${ports.universalProxy}/health`, undefined, 401);
  await expectStatus(`http://127.0.0.1:${ports.universalProxy}/health`, originalProxyToken, 200);

  const rotated = await page.evaluate(() => window.kaiDesktop.rotateServiceToken('universalProxy'));
  if (!rotated.ok) throw new Error(rotated.error.message);
  await waitForReadyServices(page, 30_000);
  const rotatedProxyToken = await copyAccessToken(application, page, 'universalProxy');
  if (rotatedProxyToken === originalProxyToken) throw new Error('Proxy access token did not change after rotation.');
  await expectStatus(`http://127.0.0.1:${ports.universalProxy}/health`, originalProxyToken, 401);
  await expectStatus(`http://127.0.0.1:${ports.universalProxy}/health`, rotatedProxyToken, 200);
  return rotatedProxyToken;
}

async function verifyOverwatchFlow(application, page, cognitive1Port) {
  const credential = await page.evaluate(() => window.kaiDesktop.setCredential('cognitive1.overwatch', 'smoke-overwatch-key'));
  if (!credential.ok) throw new Error(credential.error.message);

  const settings = await page.evaluate(() => window.kaiDesktop.updateSettings({
    cognitive1: {
      overwatch: {
        enabled: true,
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        credentialId: 'cognitive1.overwatch',
        model: 'gpt-6-astra',
        autoRejectThreshold: 0.85,
      },
    },
  }));
  if (!settings.ok) throw new Error(settings.error.message);

  await waitForReadyServices(page, 30_000);
  const token = await copyAccessToken(application, page, 'cognitive1');
  const response = await fetch(`http://127.0.0.1:${cognitive1Port}/api/overwatch/status`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const status = await response.json();
  if (
    !response.ok ||
    status.enabled !== true ||
    status.ready !== true ||
    status.hasKey !== true ||
    status.provider !== 'openai' ||
    status.model !== 'gpt-6-astra'
  ) {
    throw new Error(`AI Overwatch was not ready in C1 after desktop configuration: ${JSON.stringify(status)}`);
  }

  const disabled = await page.evaluate(() => window.kaiDesktop.updateSettings({
    cognitive1: {
      overwatch: {
        enabled: false,
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        credentialId: 'cognitive1.overwatch',
        model: 'deepseek-chat',
        autoRejectThreshold: 0.85,
      },
    },
  }));
  if (!disabled.ok) throw new Error(disabled.error.message);
  await waitForReadyServices(page, 30_000);
}

async function verifyBrainFlow(application, page, cognitive1Port) {
  const token = await copyAccessToken(application, page, 'cognitive1');
  const marker = 'KAI smoke isolated brain entry';
  const learned = await fetch(`http://127.0.0.1:${cognitive1Port}/api/brain/learn`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type: 'patterns',
      title: marker,
      agent: 'smoke',
      tags: 'smoke,isolated',
      project: 'KAI Smoke',
      note: 'Seed only the temporary desktop smoke data root.',
      force: true,
    }),
  });
  const learnedPayload = await learned.json();
  if (!learned.ok || learnedPayload.ok !== true) {
    throw new Error(`Could not seed the isolated brain entry: ${JSON.stringify(learnedPayload)}`);
  }

  const overviewResponse = await page.evaluate(() => window.kaiDesktop.brainOverview());
  if (!overviewResponse.ok || overviewResponse.data.totalEntries < 1) {
    throw new Error(`Brain overview did not report the isolated smoke entry: ${JSON.stringify(overviewResponse)}`);
  }
  const searchResponse = await page.evaluate((query) => window.kaiDesktop.searchBrain({ query, maxResults: 10 }), marker);
  if (!searchResponse.ok || !searchResponse.data.some((entry) => entry.title === marker)) {
    throw new Error(`Brain search did not return the isolated smoke entry: ${JSON.stringify(searchResponse)}`);
  }

  await page.getByRole('button', { name: 'C1 Brain' }).click();
  await page.getByRole('heading', { name: 'Ready' }).waitFor();
  // The panel opens on Review, which is the draft queue. The brain explorer itself lives under the Memory tab.
  await page.getByRole('heading', { name: 'Review, Overwatch, and memory' }).waitFor();
  await page.locator('.cognitive1-tabs').getByRole('button', { name: 'Memory', exact: true }).click();
  await page.getByRole('heading', { name: 'Brain overview' }).waitFor();
  await page.getByRole('heading', { name: 'Brain Git sync' }).waitFor();
  await page.getByPlaceholder('Title, field, agent, or project').fill(marker);
  await chooseOption(page.getByLabel('Search mode'), 'semantic');
  if (await selectedValue(page.getByLabel('Search mode')) !== 'semantic') {
    throw new Error('The brain search mode did not switch to semantic retrieval.');
  }
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByText(marker).waitFor();
  const initializeBrain = page.getByRole('button', { name: 'Initialize' });
  if (await initializeBrain.isEnabled()) {
    await initializeBrain.click();
    await page.getByText(/changed file|Working tree clean/).waitFor({ timeout: 20_000 });
  }
  await page.getByRole('button', { name: 'Advanced' }).click();
  await page.getByText('Run any Cognitive1 tool').waitFor();

  const toolResponse = await page.evaluate(() => window.kaiDesktop.cognitive1Tool({
    tool: 'brain_status',
    arguments: {},
  }));
  if (!toolResponse.ok || !Array.isArray(toolResponse.data?.content)) {
    throw new Error(`The authenticated Cognitive1 MCP tool bridge failed: ${JSON.stringify(toolResponse)}`);
  }
  await page.getByRole('button', { name: 'Memory' }).click();
  await page.getByRole('heading', { name: 'Brain overview' }).waitFor();

  const updateResponse = await page.evaluate((title) =>
    window.kaiDesktop.updateBrainField({ title, field: 'note', value: 'Updated by the isolated desktop smoke.' }), marker);
  if (!updateResponse.ok) throw new Error(updateResponse.error.message);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByText('Updated by the isolated desktop smoke.').waitFor();
}

async function verifyProxyFlow(page, token, proxyPort) {
  const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Proxy-Agent': 'smoke',
    },
    body: JSON.stringify({
      model: 'smoke-model',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Generate an isolated proxy history record.' }],
    }),
  });
  if (response.ok) throw new Error('The unreachable proxy target unexpectedly returned success.');
  await response.body?.cancel();

  const historyResponse = await page.evaluate(() =>
    window.kaiDesktop.proxyHistory({ search: 'smoke-model', status: '5xx', limit: 10 }),
  );
  if (!historyResponse.ok || !historyResponse.data.some((entry) => entry.agent === 'smoke')) {
    throw new Error(`Proxy history did not record the isolated smoke request: ${JSON.stringify(historyResponse)}`);
  }
  const detailResponse = await page.evaluate(
    (id) => window.kaiDesktop.proxyHistoryDetail(id),
    historyResponse.data.find((entry) => entry.agent === 'smoke')?.id ?? '',
  );
  if (!detailResponse.ok || detailResponse.data.statusCode < 500) {
    throw new Error(`Proxy history detail did not expose the failed request: ${JSON.stringify(detailResponse)}`);
  }

  const overviewResponse = await page.evaluate(() => window.kaiDesktop.proxyOverview());
  if (!overviewResponse.ok || overviewResponse.data.target !== 'http://127.0.0.1:19999/v1') {
    throw new Error(`Proxy overview did not normalize the managed engine: ${JSON.stringify(overviewResponse)}`);
  }
}

async function copyAccessToken(application, page, kind) {
  const result = await page.evaluate((serviceKind) => window.kaiDesktop.copyServiceToken(serviceKind), kind);
  if (!result.ok) throw new Error(result.error.message);
  const token = await application.evaluate(({ clipboard }) => clipboard.readText());
  if (typeof token !== 'string' || token.length < 32) throw new Error(`No ${kind} access token was copied.`);
  return token;
}

async function expectStatus(url, token, expectedStatus) {
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (response.status !== expectedStatus) {
    throw new Error(`Expected ${expectedStatus} from ${url}, received ${response.status}.`);
  }
  await response.body?.cancel();
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(() => resolve()));
  return port;
}

async function resizeWindow(application, width, height) {
  return application.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('KAI desktop window was not found.');
      window.setSize(size.width, size.height);
      return window.getSize();
    },
    { width, height },
  );
}

function assertSize(actual, width, height) {
  if (Math.abs(actual[0] - width) > 4 || Math.abs(actual[1] - height) > 4) {
    throw new Error(`Expected window size ${width}x${height}, received ${actual[0]}x${actual[1]}.`);
  }
}

async function assertNoErrorBanner(page) {
  const alerts = (await page.getByRole('alert').allTextContents()).map((value) => value.trim()).filter(Boolean);
  if (alerts.length > 0) throw new Error(`KAI displayed an error: ${alerts.join(' | ')}`);
}

async function assertNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (overflow) throw new Error('KAI displayed horizontal overflow at the minimum window size.');
}

async function openSettingsCategory(page, name) {
  // A category button toggles its section, and the open sections are remembered, so only click a closed one.
  const button = page.locator('.settings-category-nav').getByRole('button', { name });
  if (!(await button.evaluate((element) => element.classList.contains('active')))) await button.click();
}

async function assertPageContentFillsWidth(page, selector) {
  const measurement = await page.evaluate((targetSelector) => {
    const element = document.querySelector(targetSelector);
    const container = element?.closest('.page-view');
    if (!element || !container) return null;
    const style = getComputedStyle(container);
    const contentWidth =
      container.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
    return {
      elementWidth: element.getBoundingClientRect().width,
      contentWidth,
    };
  }, selector);

  if (!measurement) throw new Error(`Could not measure full-width page content: ${selector}.`);
  if (measurement.elementWidth < measurement.contentWidth - 2) {
    throw new Error(
      `${selector} did not fill the page width: ${measurement.elementWidth}px of ${measurement.contentWidth}px.`,
    );
  }
}
