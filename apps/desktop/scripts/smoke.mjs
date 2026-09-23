import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    },
    timeout: 30_000,
  });

  const page = await electronApp.firstWindow();
  page.on('pageerror', (error) => rendererErrors.push(error.message));
  try {
    await page
      .getByRole('heading', {
        name: usesAgentProject ? 'KAI Live Agent Smoke' : 'Choose a project to begin',
        level: usesAgentProject ? 1 : 2,
      })
      .waitFor({ timeout: 20_000 });
  } catch (error) {
    const bodyText = await page.locator('body').innerText().catch(() => '<body unavailable>');
    throw new Error(`Desktop workspace did not become ready: ${bodyText}`, { cause: error });
  }
  const agentCapabilities = await verifyAgentCapabilities(page);
  await verifyWorkspaceControls(page);
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
    const proxyAccess = await verifyAuthenticatedLoopback(electronApp, page, enginePorts);
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
    await page.getByRole('heading', { name: 'Ready' }).waitFor();
    await page.getByRole('heading', { name: 'Proxy activity' }).waitFor();
    await page.getByText('smoke-model').first().waitFor();
    await page.locator('.proxy-request-row').first().click();
    await page.getByText('Request detail').waitFor();
    await page.getByText('Upstream model').waitFor();
    await assertPageContentFillsWidth(page, '.proxy-panel');
    await page.screenshot({ path: path.join(outputDirectory, 'proxy-ready.png') });
    const proxyMinimumSize = await resizeWindow(electronApp, 960, 640);
    assertSize(proxyMinimumSize, 960, 640);
    await assertNoHorizontalOverflow(page);
    await assertPageContentFillsWidth(page, '.proxy-panel');
    await page.screenshot({ path: path.join(outputDirectory, 'proxy-960x640.png') });
    await resizeWindow(electronApp, 1440, 920);
  }

  const desktopSize = await resizeWindow(electronApp, 1440, 920);
  assertSize(desktopSize, 1440, 920);
  await page.screenshot({ path: path.join(outputDirectory, 'workspace-1440x920.png') });

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('heading', { name: 'Settings' }).waitFor();
  await page.getByText('OS vault available').waitFor();
  const providerSelect = page.locator('label.field:has(span:text-is("Provider")) > select');
  const providerOptions = await providerSelect.locator('option').allTextContents();
  if (!providerOptions.includes('OpenRouter') || !providerOptions.includes('DeepSeek API')) {
    throw new Error(`Direct API provider presets are incomplete: ${providerOptions.join(', ')}`);
  }
  await verifySelectContrast(providerSelect, 'Direct API provider');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await page.waitForTimeout(250);
  await assertNoErrorBanner(page);
  await assertPageContentFillsWidth(page, '.settings-grid');
  await page.screenshot({ path: path.join(outputDirectory, 'settings-1440x920.png') });

  const settingsMinimumSize = await resizeWindow(electronApp, 960, 640);
  assertSize(settingsMinimumSize, 960, 640);
  await assertNoHorizontalOverflow(page);
  await assertPageContentFillsWidth(page, '.settings-grid');
  await page.screenshot({ path: path.join(outputDirectory, 'settings-960x640.png') });
  await resizeWindow(electronApp, 1440, 920);

  await page.getByRole('button', { name: 'Workspace' }).click();
  await page.getByRole('button', { name: 'Hide context panel' }).click();
  await page.getByRole('button', { name: 'Show context panel' }).waitFor();
  await page.getByRole('button', { name: 'Show context panel' }).click();

  const minimumSize = await resizeWindow(electronApp, 960, 640);
  assertSize(minimumSize, 960, 640);
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
  await rm(userDataDirectory, { recursive: true, force: true });
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
  const expected = ['claude', 'codex', 'qwen', 'gemini'];
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
  const agentSelect = page.getByLabel('Agent');
  for (const agent of ['claude', 'codex', 'qwen', 'gemini']) {
    await agentSelect.selectOption(agent);
    if ((await agentSelect.inputValue()) !== agent) {
      throw new Error(`The workspace did not switch to the ${agent} agent.`);
    }
  }
  await agentSelect.selectOption('codex');
  await verifySelectContrast(agentSelect, 'Agent');

  const autonomy = page.getByLabel('Autonomy');
  for (const mode of ['plan', 'ask', 'autoEdit', 'full', 'custom']) {
    await autonomy.selectOption(mode);
    if ((await autonomy.inputValue()) !== mode) {
      throw new Error(`The workspace did not switch to the ${mode} autonomy mode.`);
    }
  }
  await autonomy.selectOption('ask');
  await verifySelectContrast(autonomy, 'Autonomy');

  const route = page.getByLabel('Route');
  if ((await route.inputValue()) !== 'direct') {
    throw new Error(`CLI routing should begin in direct mode, received ${await route.inputValue()}.`);
  }
  await verifySelectContrast(route, 'Route');
}

async function verifySelectContrast(select, label) {
  const colors = await select.evaluate((element) => {
    const control = getComputedStyle(element);
    const option = Array.from(element.options).find((item) => !item.disabled) ?? element.options[0];
    const optionStyle = option ? getComputedStyle(option) : control;
    return {
      background: control.backgroundColor,
      color: control.color,
      optionBackground: optionStyle.backgroundColor,
      optionColor: optionStyle.color,
    };
  });
  const opaqueBackground = colors.optionBackground !== 'transparent'
    && colors.optionBackground !== 'rgba(0, 0, 0, 0)';
  if (!opaqueBackground || colors.optionColor === colors.optionBackground) {
    throw new Error(
      `${label} select has unsafe contrast: ${JSON.stringify(colors)}.`,
    );
  }
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
  await page.getByRole('heading', { name: 'KAI Live Agent Smoke', level: 1 }).waitFor({ timeout: 20_000 });
  const contextPreview = await page.evaluate(() => window.kaiDesktop.previewContext({ projectId: 'project-live-agent-smoke' }));
  if (!contextPreview.ok || contextPreview.data.estimatedTokens < 1) {
    throw new Error(`Project context preview was not populated: ${JSON.stringify(contextPreview)}`);
  }
  await page.getByText('Estimated direct API context').waitFor();
  await page.locator('.context-meter strong').filter({ hasText: '~' }).waitFor();
  await page.getByRole('button', { name: 'API' }).click();
  await page.getByText('API ready').waitFor();
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
      defaultModel: 'smoke-model',
      credentialId: 'provider.smoke',
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
    requests.push({
      path: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(raw),
    });
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
  await page.getByRole('heading', { name: 'Brain overview' }).waitFor();
  await page.getByText(marker).waitFor();

  const updateResponse = await page.evaluate((title) =>
    window.kaiDesktop.updateBrainField({ title, field: 'note', value: 'Updated by the isolated desktop smoke.' }), marker);
  if (!updateResponse.ok) throw new Error(updateResponse.error.message);
  await page.getByRole('button', { name: 'Refresh' }).click();
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
  const alerts = await page.getByRole('alert').allTextContents();
  if (alerts.length > 0) throw new Error(`KAI displayed an error: ${alerts.join(' | ')}`);
}

async function assertNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (overflow) throw new Error('KAI displayed horizontal overflow at the minimum window size.');
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
