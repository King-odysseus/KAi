import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let browser: Browser;
let server: Server;
let page: Page;
let url = '';

beforeAll(async () => {
  const bundle = await build({
    entryPoints: ['test/fixtures/lead-model-selector-harness.tsx'],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    tsconfig: 'apps/desktop/tsconfig.web.json',
    plugins: [{ name: 'ignore-stylesheets', setup(buildApi) {
      buildApi.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'js' }));
    } }],
  });
  const script = bundle.outputFiles[0]!.text;
  server = createServer((request, response) => {
    if (request.url === '/bundle.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(script);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not start rendered Lead test server');
  url = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 320, height: 720 } });
  page.setDefaultTimeout(10_000);
}, 30_000);

afterAll(async () => {
  await browser?.close();
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
}, 30_000);

async function chooseByMouse(viewportWidth: number): Promise<void> {
  await page.setViewportSize({ width: viewportWidth, height: 720 });
  await page.goto(url);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('button', { name: 'Lead runs on' }).click();
  await page.getByRole('option', { name: /^API/ }).click();
  await page.getByRole('button', { name: 'Lead provider' }).click();
  await page.getByRole('option', { name: /^Local Lab/ }).click();
  expect(await page.locator('.lead-tier-label').textContent()).toMatch(/Local/);
  expect(await page.getByRole('button', { name: 'Lead model' }).textContent()).toContain('local-small');
  await page.getByRole('button', { name: 'Lead model' }).click();
  await page.getByRole('option', { name: 'local-large', exact: true }).click();
  expect(await page.locator('.lead-tier-label').textContent()).toMatch(/Local/);
  expect(await page.getByRole('button', { name: 'Lead model' }).textContent()).toContain('local-large');
  await page.reload();
  expect(await page.getByRole('button', { name: 'Lead runs on' }).textContent()).toContain('API');
  expect(await page.getByRole('button', { name: 'Lead provider' }).textContent()).toContain('Local Lab');
  expect(await page.getByRole('button', { name: 'Lead model' }).textContent()).toContain('local-large');
  expect(await page.locator('.lead-tier-label').textContent()).toMatch(/Local/);
}

async function chooseByKeyboard(viewportWidth: number): Promise<void> {
  await page.setViewportSize({ width: viewportWidth, height: 720 });
  await page.goto(url);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('button', { name: 'Lead runs on' }).focus();
  await page.keyboard.press('Enter');
  await page.locator('[role="option"]:not(:disabled):focus').waitFor();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Lead provider' }).focus();
  await page.keyboard.press('Enter');
  await page.locator('[role="option"]:not(:disabled):focus').waitFor();
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Lead model' }).focus();
  await page.keyboard.press('Enter');
  await page.locator('[role="option"]:not(:disabled):focus').waitFor();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  expect(await page.getByRole('button', { name: 'Lead model' }).textContent()).toContain('local-large');
  await page.reload();
  expect(await page.getByRole('button', { name: 'Lead runs on' }).textContent()).toContain('API');
  expect(await page.getByRole('button', { name: 'Lead provider' }).textContent()).toContain('Local Lab');
  expect(await page.getByRole('button', { name: 'Lead model' }).textContent()).toContain('local-large');
}

describe('rendered Lead model selector', () => {
  it('selects and restores Runs on, Provider, and Model with the mouse at narrow and wide widths', async () => {
    await chooseByMouse(320);
    await chooseByMouse(1280);
  }, 30_000);

  it('selects and restores Runs on, Provider, and Model with the keyboard at narrow and wide widths', async () => {
    await chooseByKeyboard(320);
    await chooseByKeyboard(1280);
  }, 30_000);

  it('switches saved Lead chats, restores each draft, and starts a new chat', async () => {
    await chooseByMouse(320);
    const input = page.getByRole('textbox', { name: 'Ask the Lead' });
    await input.fill('Draft for chat two');
    await page.getByRole('button', { name: 'Lead chat history' }).click();
    expect(await page.getByRole('region', { name: 'Lead chat history page' }).count()).toBe(1);
    await page.getByRole('button', { name: /Lead chat 1/ }).click();
    await input.fill('Draft for chat one');
    await page.getByRole('button', { name: 'Lead chat history' }).click();
    await page.getByRole('button', { name: 'Back to Lead chat' }).click();
    expect(await input.inputValue()).toBe('Draft for chat one');
    await page.getByRole('button', { name: 'Lead chat history' }).click();
    await page.getByRole('button', { name: /Lead chat 2/ }).click();
    await page.waitForFunction(() => (document.querySelector('textarea[aria-label="Ask the Lead"]') as HTMLTextAreaElement | null)?.value === 'Draft for chat two');
    expect(await input.inputValue()).toBe('Draft for chat two');
    await page.getByRole('button', { name: 'New Lead chat' }).click();
    await page.waitForFunction(() => (document.querySelector('textarea[aria-label="Ask the Lead"]') as HTMLTextAreaElement | null)?.value === '');
    expect(await input.inputValue()).toBe('');
  }, 30_000);
});

it('restores Learn & Code tabs and switches learning panels without opening the development Lead', async () => {
 await page.goto(url);
 await page.evaluate(() => localStorage.setItem('kai.codeSidePanel', 'lead'));
 await page.goto(`${url}?learning`);
 expect(await page.getByRole('tab', { name: 'Learn', exact: true }).getAttribute('aria-selected')).toBe('true');
 expect(await page.getByRole('tab', { name: 'Lead', exact: true }).count()).toBe(0);
 await page.getByRole('tab', { name: 'Guided Build', exact: true }).click();
 await page.waitForFunction(() => document.querySelector('[aria-label="Selected learning panel"]')?.textContent === 'guide');
 await page.reload();
 expect(await page.getByRole('tab', { name: 'Guided Build', exact: true }).getAttribute('aria-selected')).toBe('true');
 await page.getByRole('tab', { name: 'Review', exact: true }).click();
 await page.getByRole('tab', { name: 'Learn', exact: true }).click();
 expect(await page.getByRole('tab', { name: 'Learn', exact: true }).getAttribute('aria-selected')).toBe('true');
});

it('reviews and hands off a complete task at 300px and wide, and disables sending when Builder is off', async () => {
 for (const width of [300, 760]) {
   await page.setViewportSize({ width, height: 720 });
   await page.goto(`${url}?task`);
   expect(await page.getByRole('heading', { name: 'Goal', exact: true }).count()).toBe(1);
   await page.getByRole('button', { name: 'Change task', exact: true }).click();
   await page.waitForFunction(() => (document.querySelector('[aria-label="Lead revision"]') as HTMLTextAreaElement)?.value.includes('What I want changed'));
   expect(await page.getByRole('textbox', { name: 'Builder draft' }).inputValue()).toBe('');
   await page.getByRole('button', { name: 'Send task to Builder', exact: true }).click();
   await page.waitForFunction(() => (document.querySelector('[aria-label="Builder draft"]') as HTMLTextAreaElement)?.value.includes('Validates inputs.'));
   expect(await page.getByRole('textbox', { name: 'Builder draft' }).inputValue()).toContain('### Files');
   await page.getByRole('button', { name: 'Toggle Builder', exact: true }).click();
   expect(await page.getByRole('button', { name: 'Builder is off', exact: true }).isDisabled()).toBe(true);
 }
});

it('saves handoff modes and requires approval, preserving drafts and preventing replay after restart', async () => {
  await page.goto(url);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${url}?handoff`);
  expect(await page.getByRole('button', { name: 'Lead handoff mode' }).textContent()).toContain('Ask first');
  expect(await page.getByLabel('Builder run count').textContent()).toBe('0');
  await page.getByRole('button', { name: 'Change task', exact: true }).click();
  expect(await page.getByLabel('Builder run count').textContent()).toBe('0');
  await page.getByRole('button', { name: 'Approve and start Builder', exact: true }).click();
  await page.waitForFunction(() => localStorage.getItem('handoff.runs') === '1');
  expect(await page.getByLabel('Existing Builder draft').inputValue()).toBe('My unsent Builder draft');
  expect(await page.evaluate(() => localStorage.getItem('handoff.sentTask'))).toMatch(/^### Goal\nAdd input validation/);
  await page.reload();
  expect(await page.getByRole('button', { name: 'Sent to Builder', exact: true }).isDisabled()).toBe(true);
  expect(await page.getByLabel('Builder run count').textContent()).toBe('1');
  await page.getByRole('button', { name: 'Lead handoff mode' }).click();
  await page.getByRole('option', { name: /^Auto handoff/ }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('handoff.lead-a')!).leadHandoffMode === 'auto');
  await page.reload();
  expect(await page.getByRole('button', { name: 'Lead handoff mode' }).textContent()).toContain('Auto handoff');
  expect(await page.getByLabel('Builder run count').textContent()).toBe('1');
  await page.getByRole('button', { name: 'Complete new Lead reply' }).click();
  await page.waitForFunction(() => localStorage.getItem('handoff.runs') === '2');
  expect(await page.getByLabel('Existing Builder draft').inputValue()).toBe('My unsent Builder draft');
  await page.reload();
  expect(await page.getByLabel('Builder run count').textContent()).toBe('2');
  await page.getByRole('button', { name: 'Toggle Builder busy' }).click();
  await page.getByRole('button', { name: 'Complete new Lead reply' }).click();
  await page.getByRole('alert').filter({ hasText: 'already running' }).waitFor();
  expect(await page.getByLabel('Builder run count').textContent()).toBe('2');
  await page.getByRole('button', { name: 'Toggle Builder busy' }).click();
  await page.getByRole('button', { name: 'Toggle Builder', exact: true }).click();
  await page.getByRole('button', { name: 'Complete new Lead reply' }).click();
  await page.getByRole('alert').filter({ hasText: 'Builder is off' }).waitFor();
  expect(await page.getByLabel('Builder run count').textContent()).toBe('2');
  await page.getByRole('button', { name: 'Lead handoff mode' }).click();
  await page.getByRole('option', { name: /^Discuss only/ }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('handoff.lead-a')!).leadHandoffMode === 'discuss');
  expect(await page.getByRole('button', { name: 'Approve and start Builder', exact: true }).count()).toBe(0);
  await page.reload();
  expect(await page.getByRole('button', { name: 'Lead handoff mode' }).textContent()).toContain('Discuss only');
}, 30_000);

it('keeps handoff controls and their menu inside narrow and wide panes in both themes', async () => {
  await page.goto(url);
  await page.evaluate(() => localStorage.clear());
  const { compile } = await import('@tailwindcss/node');
  const { Scanner } = await import('@tailwindcss/oxide');
  const base = resolve('apps/desktop/src/renderer/src');
  const compiler = await compile(readFileSync(`${base}/design-system.css`, 'utf8'), { base, onDependency: () => undefined });
  const scanner = new Scanner({ sources: [{ base, pattern: '**/*.{ts,tsx}', negated: false }, ...compiler.sources] });
  const styles = compiler.build(scanner.scan()) + ['styles.css', 'ops.css', 'themes.css', 'themes.generated.css', 'uap-dashboard.css', 'controls.css', 'workspace-polish.css', 'vscode.css', 'code-side.css', 'ui-upgrade.css'].map((file) => readFileSync(`${base}/${file}`, 'utf8')).join('\n');
  const reportDir = '.kai/spec/reports/build/lead-handoff-screens';
  await mkdir(reportDir, { recursive: true });
  for (const width of [300, 760]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${url}?handoff`);
    // The real app has a 960px minimum window; this fixture represents only its resizable right pane.
    await page.addStyleTag({ content: styles + '\nhtml, body, #root { min-width: 0; } .lead-panel { height: 100%; }' });
    await page.evaluate((name) => {
      document.documentElement.dataset.theme = name === 'light' ? 'light' : 'code';
      document.documentElement.dataset.themeFamily = name;
    }, theme);
    await page.getByRole('button', { name: 'Lead handoff mode', exact: true }).click();
    await page.getByRole('option', { name: /^Auto handoff/ }).click();
    await page.getByRole('button', { name: 'Lead access', exact: true }).click();
    await page.getByRole('option', { name: /^Plan edits allowed/ }).click();
    await page.waitForFunction(() => { const record = JSON.parse(localStorage.getItem('handoff.lead-a')!); return record.leadAccess === 'plan' && record.leadHandoffMode === 'auto'; });
    const control = page.locator('.lead-handoff-control').filter({ has: page.getByRole('button', { name: 'Lead handoff mode', exact: true }) });
    const box = await control.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    const handoffButton = page.getByRole('button', { name: 'Lead handoff mode', exact: true });
    const accessButton = page.getByRole('button', { name: 'Lead access', exact: true });
    const firstBox = await handoffButton.boundingBox(), secondBox = await accessButton.boundingBox();
    expect(Math.abs(firstBox!.y - secondBox!.y)).toBeLessThanOrEqual(1);
    expect(firstBox!.x + firstBox!.width).toBeLessThanOrEqual(secondBox!.x);
    expect(secondBox!.x + secondBox!.width).toBeLessThanOrEqual(width + 1);
    expect(await page.locator('.lead-handoff-controls small').count()).toBe(0);
    await handoffButton.focus();
    await accessButton.focus();
    await page.getByRole('tooltip').filter({ hasText: 'Builder access is separate' }).waitFor();
    const tipBox = await page.getByRole('tooltip').boundingBox();
    expect(tipBox!.x).toBeGreaterThanOrEqual(0);
    expect(tipBox!.x + tipBox!.width).toBeLessThanOrEqual(width + 1);
    expect(tipBox!.y).toBeGreaterThanOrEqual(0);
    expect(tipBox!.y + tipBox!.height).toBeLessThanOrEqual(1001);
    await page.screenshot({ path: `${reportDir}/tooltip-${theme}-${width}.png` });
    await page.keyboard.press('Escape');
    await page.locator('.lead-handoff-controls').screenshot({ path: `${reportDir}/controls-${theme}-${width}.png` });
    await page.getByRole('button', { name: 'Lead handoff mode' }).click();
    const menu = await page.getByRole('listbox').boundingBox();
    expect(menu!.x).toBeGreaterThanOrEqual(0);
    expect(menu!.x + menu!.width).toBeLessThanOrEqual(width + 1);
    expect(menu!.y).toBeGreaterThanOrEqual(0);
    expect(menu!.y + menu!.height).toBeLessThanOrEqual(1001);
    await page.locator('.lead-panel').screenshot({ path: `${reportDir}/${theme}-${width}.png` });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Lead access', exact: true }).click();
    const accessMenu = await page.getByRole('listbox').boundingBox();
    expect(accessMenu!.x).toBeGreaterThanOrEqual(0);
    expect(accessMenu!.x + accessMenu!.width).toBeLessThanOrEqual(width + 1);
    expect(accessMenu!.y + accessMenu!.height).toBeLessThanOrEqual(1001);
    await page.keyboard.press('Escape');
    const buttons = await page.getByRole('region', { name: 'Builder task proposal' }).locator('button').evaluateAll((elements) => elements.map((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    }));
    expect(buttons).toHaveLength(4);
    expect(Math.max(...buttons.map((button) => button.height)) - Math.min(...buttons.map((button) => button.height))).toBeLessThanOrEqual(1);
    for (const button of buttons) {
      expect(button.x).toBeGreaterThanOrEqual(0);
      expect(button.x + button.width).toBeLessThanOrEqual(width + 1);
    }
    if (width === 760) expect(Math.max(...buttons.map((button) => button.y)) - Math.min(...buttons.map((button) => button.y))).toBeLessThanOrEqual(1);
  }
}, 30_000);

it('keeps normal chat usable during a saved price pause and requests exactly one explicit review', async () => {
  const { compile } = await import('@tailwindcss/node');
  const { Scanner } = await import('@tailwindcss/oxide');
  const base = resolve('apps/desktop/src/renderer/src');
  const compiler = await compile(readFileSync(`${base}/design-system.css`, 'utf8'), { base, onDependency: () => undefined });
  const scanner = new Scanner({ sources: [{ base, pattern: '**/*.{ts,tsx}', negated: false }, ...compiler.sources] });
  const styles = compiler.build(scanner.scan()) + ['styles.css', 'ops.css', 'themes.css', 'themes.generated.css', 'uap-dashboard.css', 'controls.css', 'workspace-polish.css', 'vscode.css', 'code-side.css', 'ui-upgrade.css'].map((file) => readFileSync(`${base}/${file}`, 'utf8')).join('\n');
  const screenshotDir = '.kai/spec/reports/build/lead-price-pause-screens';
  await mkdir(screenshotDir, { recursive: true });
  for (const width of [300, 760]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(url); await page.evaluate(() => localStorage.clear()); await page.goto(`${url}?handoff`);
    await page.addStyleTag({ content: styles + '\nhtml, body, #root { min-width: 0; } .lead-panel { height: 100%; }' });
    await page.getByRole('button', { name: 'Lead runs on', exact: true }).click(); await page.getByRole('option', { name: /^API/ }).click();
    await page.getByRole('button', { name: 'Lead provider', exact: true }).click(); await page.getByRole('option', { name: /^Cloud Lab/ }).click();
    await page.getByRole('button', { name: 'Lead model', exact: true }).click(); await page.getByRole('option', { name: 'cloud-fast', exact: true }).click();
    await page.getByRole('button', { name: 'Show price pause', exact: true }).click();
    expect(await page.getByRole('alert').count()).toBe(0);
    await page.getByText('Automatic review paused — price unavailable', { exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'Ask the Lead', exact: true }).fill('hello');
    await page.getByRole('button', { name: 'Ask Lead', exact: true }).click();
    await page.getByText('Hello. We can still discuss the project.', { exact: true }).waitFor();
    const reviewButton = page.getByRole('button', { name: 'Review once with Lead · Paid API', exact: true });
    await reviewButton.scrollIntoViewIfNeeded();
    const box = await reviewButton.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    await page.screenshot({ path: `${screenshotDir}/pause-${width}.png` });
    await reviewButton.click();
    expect(await page.evaluate(() => localStorage.getItem('handoff.manualReviews'))).toBe('1');
    expect(JSON.parse((await page.evaluate(() => localStorage.getItem('handoff.reviewTarget')))!)).toMatchObject({ execution: 'api', api: { model: 'cloud-fast' } });
    expect(await page.getByLabel('Builder run count').textContent()).toBe('0');
    expect(await page.getByLabel('Existing Builder draft').inputValue()).toBe('My unsent Builder draft');
    await page.reload();
    await page.getByText('Automatic review paused — price unavailable', { exact: true }).waitFor();
    expect(await page.evaluate(() => localStorage.getItem('handoff.manualReviews'))).toBe('1');
  }
});

it('saves Lead access separately from handoff, previews and approves a small edit without replacing Builder drafts', async () => {
  await page.goto(url); await page.evaluate(() => localStorage.clear()); await page.goto(`${url}?handoff`);
  expect(await page.getByRole('button', { name: 'Lead access', exact: true }).textContent()).toContain('Read-only');
  await page.getByRole('button', { name: 'Lead access', exact: true }).click();
  await page.getByRole('option', { name: /^Ask before edits/ }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('handoff.lead-a')!).leadAccess === 'ask');
  expect(await page.getByRole('button', { name: 'Lead handoff mode', exact: true }).textContent()).toContain('Ask first');
  await page.reload(); expect(await page.getByRole('button', { name: 'Lead access', exact: true }).textContent()).toContain('Ask before edits');
  await page.getByRole('button', { name: 'Show edit proposal', exact: true }).click();
  const proposal = page.getByRole('region', { name: 'Lead edit proposal' });
  expect(await proposal.locator('pre').textContent()).toContain('- return true;');
  expect(await proposal.locator('pre').textContent()).toContain('+ return false;');
  await proposal.getByRole('button', { name: 'Approve exact edit', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('handoff.lead-a')!).leadEditProposals[0].state === 'applied');
  expect(await page.getByLabel('Builder run count').textContent()).toBe('0');
  expect(await page.getByLabel('Existing Builder draft').inputValue()).toBe('My unsent Builder draft');
  await page.reload(); expect(await page.getByRole('region', { name: 'Lead edit proposal' }).getByRole('status').textContent()).toBe('Applied with approval');
  await page.getByRole('button', { name: 'Lead access', exact: true }).click(); await page.getByRole('option', { name: /^Plan edits allowed/ }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('handoff.lead-a')!).leadAccess === 'plan');
  await page.reload(); expect(await page.getByRole('button', { name: 'Lead access', exact: true }).textContent()).toContain('Plan edits allowed');
});

it('turns a blocked result into an approvable next action without accepting the old task or replaying work', async () => {
  await page.goto(url); await page.evaluate(() => localStorage.clear()); await page.goto(`${url}?handoff`);
  await page.getByRole('button', { name: 'Lead handoff mode', exact: true }).click(); await page.getByRole('option', { name: /^Auto handoff/ }).click();
  await page.getByRole('button', { name: 'Lead runs on', exact: true }).click(); await page.getByRole('option', { name: /^API/ }).click();
  await page.getByRole('button', { name: 'Lead provider', exact: true }).click(); await page.getByRole('option', { name: /^Local Lab/ }).click();
  await page.getByRole('button', { name: 'Lead model', exact: true }).click(); await page.getByRole('option', { name: 'local-small', exact: true }).click();
  await page.getByRole('button', { name: 'Show price pause', exact: true }).click();
  await page.getByRole('button', { name: 'Plan ways forward', exact: true }).click();
  const proposal = page.getByRole('region', { name: 'Builder task proposal' }).filter({ hasText: 'Collect fresh check evidence.' });
  await proposal.getByRole('button', { name: 'Approve and start Builder', exact: true }).waitFor();
  expect(await page.getByLabel('Builder run count').textContent()).toBe('0');
  expect(await page.getByLabel('Existing Builder draft').inputValue()).toBe('My unsent Builder draft');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('handoff.builder-a')!).leadHandoffs[0].completion.state)).toBe('review-needed');
  await proposal.getByRole('button', { name: 'Approve and start Builder', exact: true }).click();
  await page.waitForFunction(() => localStorage.getItem('handoff.runs') === '1');
  expect(await page.evaluate(() => localStorage.getItem('handoff.sentTask'))).toContain('Collect fresh check evidence.');
  await page.reload();
  expect(await page.getByLabel('Builder run count').textContent()).toBe('1');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('handoff.builder-a')!).leadHandoffs[0].completion.state)).toBe('review-needed');
});

it('queues a live Builder result while Lead is busy, reloads it and reviews once when Lead is free', async () => {
  await page.goto(url); await page.evaluate(() => localStorage.clear()); await page.goto(`${url}?handoff`);
  await page.getByRole('button', { name: 'Toggle Lead busy', exact: true }).click();
  await page.getByRole('button', { name: 'Finish Builder during Lead reply', exact: true }).click();
  expect(await page.getByLabel('Completion review count').textContent()).toBe('0');
  await page.getByRole('button', { name: 'Toggle Lead busy', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('handoff.builder-a')!).leadHandoffs[0].completion?.notified === true);
  await page.waitForFunction(() => document.querySelector('[aria-label="Completion review count"]')?.textContent === '2');
  await page.getByRole('button', { name: 'Repeat completion notification', exact: true }).click();
  expect(await page.getByLabel('Completion review count').textContent()).toBe('2');
  expect(await page.getByLabel('Builder run count').textContent()).toBe('0');
  await page.reload();
  expect(await page.getByLabel('Completion review count').textContent()).toBe('0');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('handoff.builder-a')!).leadHandoffs[0].completion.notified)).toBe(true);
});

it('keeps a local Lead and separate paid reviewer choices across restart, requiring explicit paid review opt-in', async () => {
  await page.goto(url); await page.evaluate(() => localStorage.clear()); await page.goto(`${url}?handoff`);
  await page.getByRole('button', { name: 'Lead runs on', exact: true }).click();
  await page.getByRole('option', { name: /^API/ }).click();
  await page.getByRole('button', { name: 'Lead provider', exact: true }).click();
  await page.getByRole('option', { name: /^Local Lab/ }).click();
  await page.getByRole('button', { name: 'Lead model', exact: true }).click();
  await page.getByRole('option', { name: 'local-large', exact: true }).click();
  await page.getByText('Review and continuation settings', { exact: true }).click();
  expect(await page.getByRole('switch', { name: 'Automatically review Builder results' }).getAttribute('aria-checked')).toBe('false');
  await page.getByRole('button', { name: 'Reviewer runs on', exact: true }).click();
  await page.getByRole('option', { name: /^API/ }).click();
  await page.getByRole('button', { name: 'Reviewer provider', exact: true }).click();
  await page.getByRole('option', { name: /^Cloud Lab/ }).click();
  await page.getByRole('button', { name: 'Reviewer model', exact: true }).click();
  await page.getByRole('option', { name: 'cloud-strong', exact: true }).click();
  await page.getByRole('switch', { name: 'Automatically review Builder results' }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('handoff.lead-a')!).leadDeliverySettings?.autoReview === true);
  expect(await page.getByRole('button', { name: 'Lead model', exact: true }).textContent()).toContain('local-large');
  await page.reload();
  await page.getByText('Review and continuation settings', { exact: true }).click();
  expect(await page.getByRole('button', { name: 'Lead model', exact: true }).textContent()).toContain('local-large');
  expect(await page.getByRole('button', { name: 'Reviewer model', exact: true }).textContent()).toContain('cloud-strong');
  expect(await page.getByRole('switch', { name: 'Automatically review Builder results' }).getAttribute('aria-checked')).toBe('true');
  await page.getByRole('button', { name: 'Reviewer model', exact: true }).click();
  await page.getByRole('option', { name: 'cloud-fast', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('handoff.lead-a')!).leadDeliverySettings?.autoReview === false);
  const taskLimit = page.getByRole('spinbutton', { name: 'Automatic task limit' });
  await taskLimit.fill('2'); await taskLimit.press('Tab');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('handoff.lead-a')!).leadDeliverySettings?.maxTasks === 2);
  expect(await page.getByLabel('Builder run count').textContent()).toBe('0');
}, 30_000);
