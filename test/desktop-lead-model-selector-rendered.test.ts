import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type Server } from 'node:http';
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
    await page.getByRole('option', { name: /Lead chat 1/ }).click();
    await input.fill('Draft for chat one');
    await page.getByRole('button', { name: 'Lead chat history' }).click();
    await page.getByRole('option', { name: /Lead chat 2/ }).click();
    await page.waitForFunction(() => (document.querySelector('textarea[aria-label="Ask the Lead"]') as HTMLTextAreaElement | null)?.value === 'Draft for chat two');
    expect(await input.inputValue()).toBe('Draft for chat two');
    await page.getByRole('button', { name: 'New Lead chat' }).click();
    await page.waitForFunction(() => (document.querySelector('textarea[aria-label="Ask the Lead"]') as HTMLTextAreaElement | null)?.value === '');
    expect(await input.inputValue()).toBe('');
  }, 30_000);
});
