// Real Electron, file tools and project checks, with an isolated profile and a deterministic local provider.
// The profile and screenshots are retained for inspection. Nothing is installed or deleted.
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect } from '@playwright/test';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const recoveryCase = process.argv.includes('--blocked-recovery');
const profile = await mkdtemp(path.join(tmpdir(), 'kai-lead-completion-'));
const projectPath = path.join(profile, 'sample-project');
const output = path.resolve(appRoot, '../../.kai/spec/reports/build/workspace-completion-screens');
await mkdir(output, { recursive: true });
await mkdir(path.join(profile, 'conversations'), { recursive: true });
await mkdir(path.join(projectPath, 'src'), { recursive: true });
await writeFile(path.join(projectPath, 'src/form.js'), 'export function valid(value) { return true; }\n');
await writeFile(path.join(projectPath, 'package.json'), JSON.stringify({ private: true, type: 'module', scripts: { test: 'node --test form.test.mjs' } }));
await writeFile(path.join(projectPath, 'form.test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { valid } from './src/form.js'; test('validates input', () => { assert.equal(valid(''), false); assert.equal(valid('ok'), true); });\n");
const criterion = 'Empty input is rejected.';
const task = `### Goal\nValidate form input.\n### Files\n- src/form.js\n### Steps\n1. Make valid reject empty input.\n### Done checks\n- ${criterion}\n### Check command\n${recoveryCase ? 'npm run verify' : 'npm test'}`;
let requests = 0;
let builderRound = 0;
let leadRequests = 0;
let nextRequests = 0;
let providerError = '';
let editRequests = 0;
let recoveryRequests = 0;
let followupRequests = 0;
const recordedGitCommand = 'git --no-pager diff --no-index --name-only /dev/null src/form.js';
const secondCriterion = 'Missing input is rejected.';
const secondTask = `### Goal\nHandle missing input safely.\n### Files\n- src/form.js\n- form.test.mjs\n### Steps\n1. Reject non-string input and add a regression test.\n### Done checks\n- ${secondCriterion}\n### Check command\nnpm test`;
const server = createServer((incoming, response) => {
  let raw = '';
  incoming.setEncoding('utf8'); incoming.on('data', (part) => { raw += part; });
  incoming.on('end', async () => {
    if (incoming.url === '/v1/models') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'local-test' }] })); return; }
    const body = JSON.parse(raw);
    const question = [...body.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
    requests++;
    let delta;
    if (question.includes('Plan a way forward from this blocked task.')) {
      recoveryRequests++;
      if (body.tools?.some((tool) => ['write_file', 'run_command', 'task', 'update_plan'].includes(tool.function.name))) { providerError = 'Recovery planning was offered mutation tools'; response.writeHead(500); response.end(providerError); return; }
      delta = { content: '## Confirmed facts\nBuilder ran npm test; the required verify command is still missing.\n## Ways forward\nCollect current verification evidence, then choose a targeted repair. Keep the failed gate open. Independent work may continue after checking its dependencies.\n## Recommended next step\nAsk Builder to collect fresh check evidence without editing files.\nBUILDER TASK:\n### Goal\nCollect fresh verification evidence.\n### Files\n- src/form.js (read only)\n### Steps\n1. Inspect available package scripts and record the real check output. Do not edit files.\n### Done checks\n- Current checks and missing commands are reported accurately.\n### Check command\nnpm test\nEND BUILDER TASK' };
    } else if (/User message: continue(?:\r?\n|$)/.test(question)) {
      followupRequests++;
      if (!question.includes('Implemented the requested validation. The project test passed.') || !question.includes(recordedGitCommand) || !/Output:\s*src\/form\.js/.test(question)) { providerError = 'Continue was not given the actual linked Builder reply and recorded Git output'; response.writeHead(500); response.end(providerError); return; }
      delta = { content: '## Next step\nI have the Builder’s recorded reply and Git output. The verification gate stays open; collect the missing verify-command evidence next.\nBUILDER TASK:\nNone' };
    } else if (question.includes('Hello after recovery planning.')) {
      delta = { content: '## Next step\nWe can continue discussing the project while the verification gate stays open.\nBUILDER TASK:\nNone' };
    } else if (question.includes('Please make a small Lead correction')) {
      editRequests++;
      if (body.tools?.some((tool) => ['write_file', 'run_command', 'task', 'update_plan'].includes(tool.function.name))) { providerError = 'Lead edit discussion was offered mutation tools'; response.writeHead(500); response.end(providerError); return; }
      delta = { content: `## Small correction\nReview this exact edit before applying.\nLEAD EDIT:\n${JSON.stringify({ path: 'src/form.js', before: 'value.trim().length > 0', after: 'value.trim().length >= 2', reason: 'Require two characters as requested.' })}\nEND LEAD EDIT\nBUILDER TASK:\nNone` };
    } else if (question.includes('Review this linked Builder result read-only') || question.includes('Builder result reviewed.')) {
      leadRequests++;
      if (!question.includes('Handle missing input safely.')) { providerError = 'The authoritative fallback plan was not delivered to the Lead'; response.writeHead(500); response.end(providerError); return; }
      if (body.tools?.some((tool) => ['write_file', 'run_command', 'task', 'update_plan'].includes(tool.function.name))) { providerError = 'Lead was offered write tools'; response.writeHead(500); response.end(providerError); return; }
      if (question.includes('Builder result reviewed.')) {
        delta = { content: nextRequests++ === 0 ? `## Next planned step\nHandle missing values.\nBUILDER TASK:\n${secondTask}\nEND BUILDER TASK` : '## Next step\nBoth agreed tasks passed their checks. No further work is agreed.\nBUILDER TASK:\nNone' };
      } else delta = { content: `## Result\nThe project check passed and the changed function implements the requested validation.\nLEAD_RESULT_REVIEW\n${JSON.stringify({ verdict: 'pass', criteria: [{ criterion: question.includes(secondCriterion) ? secondCriterion : criterion, passed: true, evidence: 'file:src/form.js — input validation; check:npm test' }], summary: 'Recorded check and criterion passed.' })}\nEND_LEAD_RESULT_REVIEW` };
    } else {
      const call = (name, args) => ({ tool_calls: [{ index: 0, id: `call-${requests}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
      const second = question.includes('Handle missing input safely.');
      if (builderRound++ % 3 === 0) {
        delta = call('write_file', { path: 'src/form.js', content: second ? "export function valid(value) { return typeof value === 'string' && value.trim().length > 0; }\n" : 'export function valid(value) { return value.trim().length > 0; }\n' });
        if (second) {
          const source = Buffer.from("import { test } from 'node:test'; import assert from 'node:assert/strict'; import { valid } from './src/form.js'; test('validates input', () => { assert.equal(valid(''), false); assert.equal(valid('ok'), true); assert.equal(valid(null), false); });\n").toString('base64');
          delta.tool_calls.push({ index: 1, id: `test-${requests}`, type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: `node -e "require('fs').writeFileSync('form.test.mjs', Buffer.from('${source}', 'base64'))"` }) } });
        }
      } else if (builderRound % 3 === 2) {
        if (!recoveryCase) await new Promise((resolve) => setTimeout(resolve, 2500));
        delta = call('run_command', { command: 'npm test' });
        if (recoveryCase) delta.tool_calls.push({ index: 1, id: `git-${requests}`, type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: recordedGitCommand }) } });
      }
      else delta = { content: 'Implemented the requested validation. The project test passed.' };
    }
    response.setHeader('content-type', 'text/event-stream');
    response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 40 } })}\n\ndata: [DONE]\n\n`);
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
await mkdir(path.join(projectPath, '.kai/spec'), { recursive: true });
await writeFile(path.join(projectPath, '.kai/spec/plan.md'), '# Agreed plan\n- [ ] Validate form input.\n- [ ] Handle missing input safely.\n');
const now = new Date().toISOString();
const project = { schemaVersion: 1, id: 'project-a', name: 'Example project', path: projectPath, createdAt: now, lastOpenedAt: now };
const base = { schemaVersion: 1, projectId: project.id, createdAt: now, updatedAt: now, archived: false, unread: false, activeAgent: 'codex', route: 'direct', autonomy: 'full', execution: 'api', events: [] };
await writeFile(path.join(profile, 'conversations', 'builder-a.json'), JSON.stringify({ ...base, id: 'builder-a', title: 'Development', turns: [] }, null, 2));
await writeFile(path.join(profile, 'conversations', 'lead-a.json'), JSON.stringify({ ...base, id: 'lead-a', title: 'Lead', origin: { kind: 'lead', projectId: project.id }, autonomy: 'plan', leadHandoffMode: 'auto', turns: [{ id: 'ask-a', role: 'user', text: 'Follow both agreed input validation steps.', createdAt: now }, { id: 'proposal-a', role: 'assistant', text: `## Recommendation\nMake a small validation change.\nBUILDER TASK:\n${task}\nEND BUILDER TASK`, createdAt: now }] }, null, 2));
await writeFile(path.join(profile, 'projects.json'), JSON.stringify({ schemaVersion: 1, projects: [project] }));
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ schemaVersion: 1, defaultAgent: 'codex', defaultRoute: 'direct', defaultAutonomy: 'full', theme: 'navy', activeProjectId: project.id, projectOrder: [project.id], windowBounds: null, logRetentionEntries: 2000, diagnosticsEnabled: true, setupCompletedAt: now, directApi: { enabled: true, provider: 'lmstudio', model: 'local-test', baseUrl, credentialId: 'provider.lmstudio' }, cognitive1: { enabled: false, endpoint: 'http://127.0.0.1:9876', dataPath: null }, proxy: { enabled: false, port: 8082, targetBaseUrl: 'https://api.example.test', defaultModel: 'test-model', credentialId: 'provider.test' }, mcpServers: [] }));
const { ELECTRON_RUN_AS_NODE: ignored, ...env } = process.env;
let app;
const errors = [];
async function launch() {
  app = await electron.launch({ args: [appRoot], cwd: appRoot, executablePath: createRequire(import.meta.url)('electron'), env: { ...env, KAI_DESKTOP_USER_DATA: profile, KAI_DESKTOP_NOTIFICATIONS: 'off', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }, timeout: 30_000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(20_000);
  page.on('pageerror', (error) => { if (error.name !== 'Canceled') errors.push(error.message); });
  await page.evaluate(({ baseUrl }) => {
    localStorage.setItem('kai.tour.v1', JSON.stringify({ enabled: false, done: [] }));
    localStorage.setItem('kai.contextOpen', 'true'); localStorage.setItem('kai.contextWidth', '500'); localStorage.setItem('kai.rightPane.tab', 'lead');
    const target = { execution: 'api', api: { provider: 'lmstudio', model: 'local-test', baseUrl, credentialId: 'provider.lmstudio' } };
    // The visible composer target is also a valid default; the picker persists its stable identity on selection.
    localStorage.setItem('kai.lead.chat.project-a', 'lead-a');
  }, { baseUrl });
  await page.evaluate(async () => {
    const result = await window.kaiDesktop.completeSetup(true);
    if (!result.ok) throw new Error('Isolated test setup could not finish: ' + result.error.message);
  });
  await page.reload();
  await page.getByRole('button', { name: 'Lead handoff mode', exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1900, 1100); });
  return page;
}
try {
  let page = await launch();
  await page.getByLabel('Task prompt').fill('Unsent Builder draft');
  if (!recoveryCase) await page.getByRole('tab', { name: 'Code', exact: true }).click();
  await page.getByRole('button', { name: 'Approve and start Builder', exact: true }).click();
  if (!recoveryCase) {
    await expect(page.locator('.workspace-file-preview-head strong')).toHaveText('src/form.js', { timeout: 30_000 });
    await expect(page.locator('.workspace-code-panel .view-lines')).toContainText('trim().length > 0');
    await expect(page.locator('.workspace-code-panel .workspace-code-changed-line').first()).toBeVisible();
    await page.screenshot({ path: path.join(output, 'code-follow-active.png') });
  }
  if (recoveryCase) {
    await expect(page.locator('.lead-run-links [role="status"]').filter({ hasText: /^Not checked$/ })).toHaveCount(1, { timeout: 60_000 });
    const recovery = page.getByRole('region', { name: 'Builder task proposal' }).filter({ hasText: 'Collect fresh verification evidence.' });
    await expect(recovery.getByRole('button', { name: 'Approve and start Builder', exact: true })).toBeEnabled({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Stop Lead reply', exact: true })).not.toBeVisible();
    if (builderRound !== 3 || recoveryRequests !== 1) throw new Error('Recovery planning replayed Builder or retried indefinitely');
    await expect(page.getByLabel('Task prompt')).toHaveValue('Unsent Builder draft');
    await recovery.screenshot({ path: path.join(output, 'recovery-proposal.png') });
    await page.locator('.lead-compose textarea').fill('Hello after recovery planning.');
    await page.getByRole('button', { name: 'Ask Lead', exact: true }).click();
    await page.getByText('We can continue discussing the project while the verification gate stays open.', { exact: true }).waitFor();
    await expect(page.getByRole('button', { name: 'Stop Lead reply', exact: true })).not.toBeVisible();
    if (builderRound !== 3) throw new Error('A normal Lead follow-up started Builder while recovery was waiting for approval');
    await page.locator('.lead-compose textarea').fill('continue');
    await page.getByRole('button', { name: 'Ask Lead', exact: true }).click();
    await page.getByText('I have the Builder’s recorded reply and Git output. The verification gate stays open; collect the missing verify-command evidence next.', { exact: true }).waitFor();
    await expect(page.getByRole('button', { name: 'Stop Lead reply', exact: true })).not.toBeVisible();
    const beforeRestart = requests;
    await app.close(); app = null; page = await launch();
    await expect(page.locator('.lead-run-links [role="status"]').filter({ hasText: /^Not checked$/ })).toHaveCount(1);
    await expect(page.getByRole('region', { name: 'Builder task proposal' }).filter({ hasText: 'Collect fresh verification evidence.' }).getByRole('button', { name: 'Approve and start Builder', exact: true })).toBeEnabled();
    await page.waitForTimeout(700);
    if (requests !== beforeRestart || providerError || errors.length) throw new Error([providerError, ...errors, requests !== beforeRestart ? 'Restart replayed recovery' : ''].filter(Boolean).join('\n'));
    await page.locator('.lead-compose textarea').fill('continue');
    await page.getByRole('button', { name: 'Ask Lead', exact: true }).click();
    await expect(page.getByText('I have the Builder’s recorded reply and Git output. The verification gate stays open; collect the missing verify-command evidence next.', { exact: true })).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Stop Lead reply', exact: true })).not.toBeVisible();
    if (followupRequests !== 2 || builderRound !== 3 || providerError) throw new Error(providerError || 'Follow-up did not use stored evidence exactly twice');
    await page.screenshot({ path: path.join(output, 'recovery-restored.png') });
    console.log(JSON.stringify({ passed: true, scenario: 'blocked-recovery', requests, recoveryRequests, followupRequests, builderRound, profile, screenshots: output }));
  } else {
  await expect(page.locator('.lead-run-links [role="status"]').filter({ hasText: /^Passed$/ })).toHaveCount(2, { timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Stop Lead reply', exact: true })).not.toBeVisible({ timeout: 30_000 });
  if (leadRequests !== 4) throw new Error(`Expected two review and two next-step Lead turns; got ${leadRequests}`);
  await expect(page.getByLabel('Task prompt')).toHaveValue('Unsent Builder draft');
  if (!(await readFile(path.join(projectPath, 'src/form.js'), 'utf8')).includes('trim().length > 0')) throw new Error('Builder edit not applied');
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  await page.locator('.workspace-code-panel .monaco-editor').waitFor();
  await expect(page.getByRole('button', { name: 'Next changed file', exact: true })).toBeEnabled();
  await expect(page.locator('.workspace-code-panel .workspace-code-changed-line').first()).toBeVisible();
  const beforeNext = await page.locator('.workspace-file-preview-head strong').textContent();
  await page.getByRole('button', { name: 'Next changed file', exact: true }).click();
  await expect(page.locator('.workspace-file-preview-head strong')).not.toHaveText(beforeNext);
  await page.getByRole('button', { name: 'Previous changed file', exact: true }).click();
  await expect(page.locator('.workspace-file-preview-head strong')).toHaveText(beforeNext);
  await page.screenshot({ path: path.join(output, 'code-follow-navigation.png') });
  await page.locator('.workspace-code-files').getByRole('button', { name: 'src/form.js', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Follow Builder', exact: true })).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('button', { name: 'Edit file', exact: true }).click();
  await page.locator('.workspace-code-panel .monaco-editor .view-lines').click();
  await page.keyboard.press('Control+End'); await page.keyboard.type('// manual inspection\n');
  await page.getByText('Following paused while you have unsaved edits.', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Conversation', exact: true }).click();
  await expect(page.getByLabel('Task prompt')).toBeVisible();
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  await expect(page.locator('.workspace-code-panel .view-lines')).toContainText('manual inspection');
  await page.getByRole('button', { name: 'Reload file', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Discard', exact: true }).click();
  await page.getByRole('button', { name: 'Lead access', exact: true }).click();
  await page.getByRole('option', { name: /^Ask before edits/ }).click();
  await expect(page.getByRole('button', { name: 'Lead access', exact: true })).toContainText('Ask before edits');
  await page.locator('.lead-compose textarea').fill('Please make a small Lead correction: require at least two characters in src/form.js.');
  await page.getByRole('button', { name: 'Ask Lead', exact: true }).click();
  const edit = page.getByRole('region', { name: 'Lead edit proposal' });
  await expect(edit.getByRole('button', { name: 'Approve exact edit', exact: true })).toBeVisible({ timeout: 30_000 });
  if (!(await readFile(path.join(projectPath, 'src/form.js'), 'utf8')).includes('length > 0')) throw new Error('Lead wrote before approval');
  await edit.screenshot({ path: path.join(output, 'edit-before-approval.png') });
  await edit.getByRole('button', { name: 'Approve exact edit', exact: true }).click();
  await expect(edit.getByRole('status')).toHaveText('Applied with approval');
  if (!(await readFile(path.join(projectPath, 'src/form.js'), 'utf8')).includes('length >= 2')) throw new Error('Approved Lead correction was not written');
  await expect(page.getByLabel('Task prompt')).toHaveValue('Unsent Builder draft');
  if (builderRound !== 6 || editRequests !== 1) throw new Error('Lead edit unexpectedly started Builder or replayed a request');
  for (const theme of ['light', 'navy']) for (const width of [300, 760]) {
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; document.documentElement.dataset.themeFamily = theme === 'light' ? 'light' : 'dark'; }, theme);
    const actualHandle = page.getByRole('separator', { name: 'Resize context panel', exact: true });
    await actualHandle.focus(); await page.keyboard.press(width === 300 ? 'Home' : 'End');
    const compose = page.locator('.lead-compose');
    const before = await compose.boundingBox();
    await page.locator('.lead-transcript').evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const after = await compose.boundingBox();
    if (Math.abs(before.y - after.y) > 1) throw new Error('Lead input moved with transcript scrolling');
    await page.locator('.lead-transcript').evaluate((element) => { element.scrollTop = 0; });
    await page.screenshot({ path: path.join(output, `${theme}-${width}.png`) });
    await page.getByText('Review and continuation settings', { exact: true }).click();
    const overflow = await page.locator('.lead-transcript').evaluate((element) => element.scrollWidth - element.clientWidth);
    if (overflow > 0) throw new Error(`Lead transcript overflows horizontally by ${overflow}px at ${width}px in ${theme}`);
    await page.screenshot({ path: path.join(output, `review-settings-${theme}-${width}.png`) });
    await page.getByText('Review and continuation settings', { exact: true }).click();
  }
  const beforeRestart = requests;
  await app.close(); app = null;
  page = await launch();
  await expect(page.locator('.lead-run-links [role="status"]').filter({ hasText: /^Passed$/ })).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Lead access', exact: true })).toContainText('Ask before edits');
  await expect(page.getByRole('region', { name: 'Lead edit proposal' }).getByRole('status')).toHaveText('Applied with approval');
  await page.waitForTimeout(700);
  if (requests !== beforeRestart) throw new Error('Restart replayed a model request');
  if (providerError || errors.length) throw new Error([providerError, ...errors].filter(Boolean).join('\n'));
  console.log(JSON.stringify({ passed: true, requests, leadRequests, editRequests, profile, screenshots: output }));
  }
} catch (error) {
  if (app) { const page = await app.firstWindow(); await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => undefined); console.error((await page.locator('body').innerText()).slice(-7000)); }
  throw error;
} finally { await app?.close().catch(() => undefined); await new Promise((resolve) => server.close(resolve)); }
