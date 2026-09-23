import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { COMPACTION_WARNING_TOKENS, estimateConversationTokens, type RecoveryRecord } from '../packages/contracts/src';
import { RestartPolicy, ServiceManager, type ServiceLaunchSpec } from '../packages/integrations/src';
import { RecoveryStore, buildRecap, buildResume, describeEvent } from '../apps/desktop/src/main/recovery-store';

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-recovery-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const start = '2026-09-23T10:00:00.000Z';

function begin(store: RecoveryStore, conversationId = 'conv_1') {
  return store.begin({
    conversationId,
    projectId: 'p1',
    title: 'Fix login bug',
    agent: 'codex',
    execution: 'api',
    route: 'direct',
    autonomy: 'ask',
    prompt: 'Fix the login bug in auth.ts',
    goal: 'Login works',
    startedAt: start,
    updatedAt: start,
    eventCount: 0,
    checkpoint: { ref: 'abcdef1234567890', untracked: [], createdAt: start },
  });
}

describe('recovery store', () => {
  it('writes a record when a run starts, refreshes it per event, and removes it when the run ends', async () => {
    const store = new RecoveryStore(await temporaryDirectory());
    await begin(store);
    expect(await store.list()).toHaveLength(1);

    await store.touch('conv_1', 'Tool read_file completed', new Date('2026-09-23T10:01:00.000Z'));
    const [record] = await store.list();
    expect(record).toMatchObject({ eventCount: 1, lastActivity: 'Tool read_file completed', updatedAt: '2026-09-23T10:01:00.000Z' });

    await store.end('conv_1');
    expect(await store.list()).toEqual([]);
    await expect(store.end('conv_1')).resolves.toBeUndefined();
  });

  it('survives a simulated kill: a new store instance still lists the run left behind', async () => {
    const directory = await temporaryDirectory();
    await begin(new RecoveryStore(directory));
    // The first process never called end(), as if it was killed.
    const afterRestart = await new RecoveryStore(directory).list();
    expect(afterRestart.map((record) => record.conversationId)).toEqual(['conv_1']);
  });

  it('skips corrupt files instead of failing startup, and ignores touches for unknown runs', async () => {
    const directory = await temporaryDirectory();
    const store = new RecoveryStore(directory);
    await begin(store);
    await fs.writeFile(path.join(directory, 'broken.json'), '{not json', 'utf8');
    await fs.writeFile(path.join(directory, 'wrong.json'), JSON.stringify({ schemaVersion: 1 }), 'utf8');
    expect((await store.list()).map((record) => record.conversationId)).toEqual(['conv_1']);
    await expect(store.touch('missing', 'x')).resolves.toBeUndefined();
    expect(await new RecoveryStore(path.join(directory, 'nope')).list()).toEqual([]);
  });

  it('refuses conversation ids that are not plain file names', async () => {
    const store = new RecoveryStore(await temporaryDirectory());
    await expect(store.read('../secret')).resolves.toBeNull();
    await expect(store.end('..\\..\\x')).rejects.toThrow('Invalid conversation id');
  });

  it('caps stored prompt and activity length', async () => {
    const store = new RecoveryStore(await temporaryDirectory());
    await store.begin({
      conversationId: 'c', projectId: null, title: 't', agent: 'codex', execution: 'cli', route: 'direct', autonomy: 'ask',
      prompt: 'x'.repeat(10_000), goal: null, startedAt: start, updatedAt: start, eventCount: 0, checkpoint: null,
    });
    await store.touch('c', 'y'.repeat(1_000));
    const [record] = await store.list();
    expect(record?.prompt).toHaveLength(4_000);
    expect(record?.lastActivity).toHaveLength(300);
  });
});

describe('recovery recap and resume', () => {
  const record: RecoveryRecord = {
    schemaVersion: 1, conversationId: 'conv_1', projectId: 'p1', title: 'Fix login bug', agent: 'codex', execution: 'api',
    route: 'proxy', autonomy: 'ask', prompt: 'Fix the login bug in auth.ts', goal: 'Login works', startedAt: start,
    updatedAt: '2026-09-23T10:05:00.000Z', eventCount: 7, lastActivity: 'Tool replace_in_file completed',
    checkpoint: { ref: 'abcdef1234567890', untracked: [], createdAt: start },
  };

  it('builds a recap from stored data only, listing changed files and the checkpoint', () => {
    const recap = buildRecap(record, ['src/auth.ts', 'src/login.ts']);
    expect(recap).toContain('Fix the login bug in auth.ts');
    expect(recap).toContain('Files changed so far: src/auth.ts, src/login.ts.');
    expect(recap).toContain('abcdef123456');
    expect(recap).toContain('API, proxy');
    expect(buildRecap({ ...record, checkpoint: null }, [])).toContain('No Git checkpoint exists');
  });

  it('builds a resume prompt that repeats the request, keeps the run settings, and warns about partial edits', () => {
    const resume = buildResume(record);
    expect(resume).toMatchObject({ conversationId: 'conv_1', agent: 'codex', execution: 'api', route: 'proxy', autonomy: 'ask' });
    expect(resume.prompt).toContain('Fix the login bug in auth.ts');
    expect(resume.prompt).toContain('Tool replace_in_file completed');
    expect(resume.prompt).toMatch(/Check the current state/);
  });

  it('describes only the events worth recording', () => {
    const base = { schemaVersion: 1 as const, id: 'e', taskId: 't', timestamp: start };
    expect(describeEvent({ ...base, type: 'tool.call', name: 'read_file', status: 'completed' })).toBe('Tool read_file completed');
    expect(describeEvent({ ...base, type: 'file.change', path: 'a.ts', action: 'edited' })).toBe('File edited: a.ts');
    expect(describeEvent({ ...base, type: 'text.delta', text: 'hi', channel: 'assistant' })).toBeNull();
  });
});

describe('context size warning', () => {
  it('counts only turns after the compaction boundary plus the summary', () => {
    const turns = [{ text: 'a'.repeat(400) }, { text: 'b'.repeat(400) }, { text: 'c'.repeat(400) }];
    expect(estimateConversationTokens({ turns })).toBe(300);
    expect(estimateConversationTokens({ turns, compaction: { throughTurnIndex: 1, summary: 's'.repeat(40) } })).toBe(110);
    expect(COMPACTION_WARNING_TOKENS).toBeGreaterThan(estimateConversationTokens({ turns }));
  });
});

describe('restart policy', () => {
  it('backs off exponentially, gives up at the limit, and lets old crashes age out', () => {
    const policy = new RestartPolicy({ maxRestarts: 3, baseDelayMs: 1_000, maxDelayMs: 3_000, windowMs: 60_000 });
    expect(policy.onCrash(0)).toEqual({ action: 'restart', attempt: 1, delayMs: 1_000 });
    expect(policy.onCrash(1_000)).toEqual({ action: 'restart', attempt: 2, delayMs: 2_000 });
    expect(policy.onCrash(2_000)).toEqual({ action: 'restart', attempt: 3, delayMs: 3_000 });
    expect(policy.onCrash(3_000)).toEqual({ action: 'give-up', attempts: 3 });
    expect(policy.restartCount(3_000)).toBe(3);
    expect(policy.onCrash(70_000)).toEqual({ action: 'restart', attempt: 1, delayMs: 1_000 });
    policy.reset();
    expect(policy.restartCount(70_000)).toBe(0);
  });
});

describe('service crash detection', () => {
  const script = `
    const fs = require('node:fs');
    const http = require('node:http');
    const server = http.createServer((req, res) => { res.writeHead(200); res.end('{"status":"ok"}'); });
    server.listen(Number(process.env.TEST_SERVICE_PORT), '127.0.0.1');
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
    setInterval(() => { if (fs.existsSync(process.env.TEST_CRASH_FILE)) process.exit(3); }, 50);
  `;

  async function launch(crashes: string[]) {
    const root = await temporaryDirectory();
    const file = path.join(root, 'service.cjs');
    await fs.writeFile(file, script, 'utf8');
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const crashFile = path.join(root, 'crash');
    const manager = new ServiceManager(undefined, (kind, detail) => crashes.push(`${kind}:${detail}`));
    const spec: ServiceLaunchSpec = {
      kind: 'universalProxy', label: 'Crashy', version: 'v', commit: 'c', endpoint: `http://127.0.0.1:${port}`, healthPath: '/health',
      executable: process.execPath, args: [file], cwd: root,
      env: { ...process.env, TEST_SERVICE_PORT: String(port), TEST_CRASH_FILE: crashFile },
      startupTimeoutMs: 10_000, stopTimeoutMs: 3_000,
    };
    await manager.start(spec);
    return { manager, crashFile };
  }

  it('reports a ready service that dies on its own', async () => {
    const crashes: string[] = [];
    const { manager, crashFile } = await launch(crashes);
    await fs.writeFile(crashFile, 'x');
    for (let waited = 0; crashes.length === 0 && waited < 5_000; waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(crashes).toHaveLength(1);
    expect(crashes[0]).toMatch(/^universalProxy:Process exited with code 3/);
    expect(manager.getState('universalProxy').status).toBe('failed');
  });

  it('does not report a service that is stopped on purpose', async () => {
    const crashes: string[] = [];
    const { manager } = await launch(crashes);
    await manager.stop('universalProxy');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(crashes).toEqual([]);
  });
});
