import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(path.join(tmpdir(), 'kai-studio-collaboration-'));
const userData = path.join(root, 'user-data');
const now = new Date().toISOString();
const studioId = 'studio_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
await mkdir(path.join(userData, 'studio'), { recursive: true });
const specRoot = path.join(userData, 'studio', 'projects', studioId, '.kai', 'spec');
await mkdir(specRoot, { recursive: true });
await writeFile(path.join(specRoot, 'brief.md'), '# Zuri Desktop\nA desktop assistant for developers.\n');
await writeFile(path.join(specRoot, 'artifacts.json'), JSON.stringify({ schemaVersion: 1, artifacts: [
  { kind: 'brief', path: '.kai/spec/brief.md', version: 1, updatedAt: now, generatedBy: 'user', dependsOn: [], stale: false, staleReason: null },
] }));
await writeFile(path.join(specRoot, 'board.json'), JSON.stringify({ schemaVersion: 1, cards: [
  { id: 'card_1', title: 'Build the first screen', kind: 'page', story: 'As a developer I can see my project', status: 'ready', createdAt: now, updatedAt: now },
] }));
await writeFile(path.join(userData, 'studio', 'interviews.json'), JSON.stringify({ schemaVersion: 1, interviews: [
  { projectId: studioId, idea: 'Build a desktop assistant', goal: 'Build Zuri Desktop, a Windows Electron assistant for individual developers', status: 'done', updatedAt: now },
  { projectId: 'studio_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', idea: 'Build a school platform', goal: 'Jenga360 is a multi-tenant school-management platform for growing schools', status: 'done', updatedAt: now },
  { projectId: 'studio_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', idea: 'Build a site builder', goal: 'SharpSite, run by Tjiha Consult, is a locked-template website builder for local businesses', status: 'done', updatedAt: now },
] }), 'utf8');

const { ELECTRON_RUN_AS_NODE: _ignored, ...launchEnvironment } = process.env;
const packagedExecutable = process.env.KAI_PACKAGED_EXECUTABLE;
const app = await electron.launch({
  args: packagedExecutable ? [] : [appRoot],
  cwd: appRoot,
  executablePath: packagedExecutable ?? createRequire(import.meta.url)('electron'),
  env: { ...launchEnvironment, KAI_DESKTOP_USER_DATA: userData, KAI_DESKTOP_NOTIFICATIONS: 'off' },
  timeout: 30_000,
});
let first;
let second;
const pageErrors = [];
try {
  first = await app.firstWindow();
  first.on('pageerror', (error) => pageErrors.push(`first: ${error.message}`));
  first.on('console', (message) => { if (message.type() === 'error') pageErrors.push(`first console: ${message.text()}`); });
  await first.locator('.setup-overlay').getByRole('button', { name: 'Set up later' }).first().click({ timeout: 20_000 });
  await first.locator('.tour-card').getByRole('button', { name: 'Turn tour off' }).click({ timeout: 4_000 }).catch(() => undefined);
  await first.getByRole('button', { name: 'Work: Project Studio' }).click();
  const cards = first.locator('.studio-project-card');
  await cards.first().waitFor({ timeout: 20_000 });
  if (await cards.count() !== 3) throw new Error('The three Studio project cards did not load.');
  const primaryTops = await cards.evaluateAll((elements) => elements.map((card) => Math.round(card.querySelector('.studio-project-action-row .primary-button').getBoundingClientRect().top)));
  if (new Set(primaryTops).size !== 1) throw new Error(`Project card buttons are not aligned: ${primaryTops.join(', ')}`);
  const railGap = await first.locator('.nav-button').first().evaluate((element) => {
    const next = element.nextElementSibling;
    return next ? next.getBoundingClientRect().top - element.getBoundingClientRect().bottom : 0;
  });
  if (railGap < 7) throw new Error(`Navigation icon spacing is too tight: ${railGap}px`);
  await cards.first().getByRole('button', { name: /Open Studio for/ }).click();
  await first.getByRole('tab', { name: 'Team' }).click();
  await first.getByRole('button', { name: 'Share this project' }).click();
  const invite = await first.locator('.studio-team-invite code').innerText();
  if (!invite.startsWith('kai-team:')) throw new Error('The team invite was not shown.');
  const nextWindow = app.waitForEvent('window');
  await first.getByRole('button', { name: 'More', exact: true }).click();
  await first.getByRole('menuitem', { name: /New window/ }).click();
  second = await nextWindow;
  second.on('pageerror', (error) => pageErrors.push(`second: ${error.message}`));
  second.on('console', (message) => { if (message.type() === 'error') pageErrors.push(`second console: ${message.text()}`); });
  await second.locator('.setup-overlay').getByRole('button', { name: 'Set up later' }).first().click({ timeout: 20_000 });
  await second.getByRole('button', { name: 'Work: Project Studio' }).click();
  await second.locator('.studio-project-card').first().getByRole('button', { name: /Open Studio for/ }).click();
  await second.getByRole('tab', { name: 'Team' }).click();
  await second.getByPlaceholder('Paste a teammate’s invite code').fill(invite);
  await second.getByRole('button', { name: 'Join session' }).click();
  await Promise.all([
    first.getByRole('heading', { name: 'Teammates (1)' }).waitFor({ timeout: 45_000 }),
    second.getByRole('heading', { name: 'Teammates (1)' }).waitFor({ timeout: 45_000 }),
  ]);
  await second.getByRole('button', { name: 'brief' }).click();
  await second.getByText('A desktop assistant for developers.').waitFor({ timeout: 20_000 });
  await second.getByPlaceholder('Message this project').fill('Please review the first screen');
  await second.getByRole('button', { name: 'Send', exact: true }).click();
  await first.getByText('Please review the first screen').waitFor({ timeout: 15_000 });
  await first.screenshot({ path: path.join(root, 'studio-team.png') });
  console.log('Project cards, navigation spacing, and connected Studio session passed.');
} catch (error) {
  console.error(`First window:\n${await first?.locator('body').innerText().catch(() => '<body unavailable>')}`);
  console.error(`Second window:\n${await second?.locator('body').innerText().catch(() => '<body unavailable>')}`);
  console.error(`Renderer errors:\n${pageErrors.join('\n')}`);
  throw error;
} finally {
  await app.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
}
