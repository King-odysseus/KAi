import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RECENT_ACTIVITY_MS,
  changedFiles,
  copyWithRetry,
  installDecision,
  listFiles,
  main,
  newestConversationSave,
  syncTree,
} from '../apps/desktop/scripts/install-local.mjs';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function tree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-install-'));
  made.push(dir);
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(dir, ...relative.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

const read = (dir: string, relative: string): string => fs.readFileSync(path.join(dir, ...relative.split('/')), 'utf8');

const BUILD = { 'KAI.exe': 'exe-v2', 'resources/app.asar': 'asar-v2', 'resources/engines/a.js': 'engine', 'locales/en.pak': 'locale' };

describe('finding what differs', () => {
  it('lists nothing for an identical install', async () => {
    const from = tree(BUILD);
    const to = tree(BUILD);
    expect(await changedFiles(from, to)).toEqual([]);
  });

  it('finds a file that is missing, a file of another size, and a file of the same size with other contents', async () => {
    const from = tree(BUILD);
    const { 'locales/en.pak': _gone, ...withoutLocale } = BUILD;
    // "asar-v9" is the same length as "asar-v2" but different bytes: a size check alone would call it identical.
    const to = tree({ ...withoutLocale, 'KAI.exe': 'exe-v1-longer', 'resources/app.asar': 'asar-v9' });
    expect(await changedFiles(from, to)).toEqual(['KAI.exe', 'locales/en.pak', 'resources/app.asar']);
  });

  it('lists files with forward slashes whatever the platform', async () => {
    expect(await listFiles(tree(BUILD))).toEqual(expect.arrayContaining(['resources/engines/a.js', 'KAI.exe']));
  });
});

describe('copying the build over an install', () => {
  it('copies only what changed and proves every file matches afterwards', async () => {
    const from = tree(BUILD);
    const to = tree({ ...BUILD, 'resources/app.asar': 'asar-v1' });
    const result = await syncTree(from, to);
    expect(result).toEqual({ checked: 4, copied: 1, mismatched: [] });
    expect(read(to, 'resources/app.asar')).toBe('asar-v2');
  });

  it('never deletes or touches files that only the install has, like the uninstaller', async () => {
    const from = tree(BUILD);
    const to = tree({ ...BUILD, 'Uninstall KAI.exe': 'uninstaller', 'resources/engines/cognitive1/brain/note.md': 'runtime data' });
    await syncTree(from, to);
    expect(read(to, 'Uninstall KAI.exe')).toBe('uninstaller');
    expect(read(to, 'resources/engines/cognitive1/brain/note.md')).toBe('runtime data');
  });

  it('builds an install that does not exist yet', async () => {
    const from = tree(BUILD);
    const to = path.join(os.tmpdir(), `kai-install-new-${Date.now()}`);
    made.push(to);
    const result = await syncTree(from, to);
    expect(result.copied).toBe(4);
    expect(result.mismatched).toEqual([]);
    expect(read(to, 'resources/engines/a.js')).toBe('engine');
  });

  it('reports a copy that looked fine but is wrong, by name, instead of calling it done', async () => {
    const from = tree(BUILD);
    const to = tree({ ...BUILD, 'resources/app.asar': 'asar-v1' });
    const corrupting = async (_source: string, target: string) => { fs.writeFileSync(target, 'half-written'); };
    const result = await syncTree(from, to, { retry: { copy: corrupting } });
    expect(result.mismatched).toEqual(['resources/app.asar']);
  });

  it('retries a file something has locked, and stops at a real error straight away', async () => {
    const from = tree({ 'a.bin': 'data' });
    const to = tree({});
    let calls = 0;
    const flaky = async (source: string, target: string) => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
      fs.copyFileSync(source, target);
    };
    const attempts = await copyWithRetry(path.join(from, 'a.bin'), path.join(to, 'a.bin'), { copy: flaky, sleep: async () => undefined });
    expect(attempts).toBe(3);
    expect(read(to, 'a.bin')).toBe('data');

    let tries = 0;
    const missing = async () => { tries += 1; throw Object.assign(new Error('no such file'), { code: 'ENOENT' }); };
    await expect(copyWithRetry(path.join(from, 'a.bin'), path.join(to, 'b.bin'), { copy: missing, sleep: async () => undefined })).rejects.toThrow(/Could not copy a\.bin/);
    expect(tries).toBe(1);
  });

  it('says the file is locked and KAI may be open when the retries run out', async () => {
    const from = tree({ 'a.bin': 'data' });
    const to = tree({});
    const locked = async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
    await expect(copyWithRetry(path.join(from, 'a.bin'), path.join(to, 'a.bin'), { copy: locked, sleep: async () => undefined, attempts: 3 }))
      .rejects.toThrow(/still locked after retries: is KAI closed\?/);
  });
});

describe('deciding whether it is safe to close KAI and install', () => {
  const now = 1_000_000_000;

  it('goes ahead when KAI is closed and nothing was saved lately', () => {
    expect(installDecision({ running: false, newestSaveMs: now - RECENT_ACTIVITY_MS * 10, nowMs: now, close: false, force: false }).ok).toBe(true);
    expect(installDecision({ running: false, newestSaveMs: 0, nowMs: now, close: false, force: false }).ok).toBe(true);
  });

  it('will not close a running KAI unless it was told to', () => {
    const refused = installDecision({ running: true, newestSaveMs: 0, nowMs: now, close: false, force: false });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/--close/);
    expect(installDecision({ running: true, newestSaveMs: 0, nowMs: now, close: true, force: false })).toMatchObject({ ok: true, reason: 'KAI will be closed.' });
  });

  it('refuses when a conversation was saved in the last two minutes, even with --close, until forced', () => {
    const recent = now - 30_000;
    const refused = installDecision({ running: true, newestSaveMs: recent, nowMs: now, close: true, force: false });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/30 seconds ago/);
    expect(installDecision({ running: true, newestSaveMs: recent, nowMs: now, close: true, force: true }).ok).toBe(true);
  });

  it('reads the newest save from the conversations folder', async () => {
    const data = tree({ 'conversations/a.json': '{}', 'conversations/b.json': '{}' });
    const older = new Date(Date.now() - 3_600_000);
    fs.utimesSync(path.join(data, 'conversations', 'a.json'), older, older);
    const newest = await newestConversationSave(data);
    expect(Date.now() - newest).toBeLessThan(60_000);
    expect(await newestConversationSave(path.join(data, 'nowhere'))).toBe(0);
  });
});

describe('the command', () => {
  it('stops before touching anything when there is no build to install', async () => {
    const to = tree({ 'KAI.exe': 'old' });
    await expect(main(['--from', path.join(os.tmpdir(), 'no-such-build-dir'), '--to', to, '--no-launch'])).rejects.toThrow(/No build at/);
    expect(read(to, 'KAI.exe')).toBe('old');
  });

  it('rejects an option it does not know instead of ignoring it', async () => {
    await expect(main(['--clsoe'])).rejects.toThrow(/Unknown option --clsoe/);
  });
});
