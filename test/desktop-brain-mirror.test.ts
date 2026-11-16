import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BrainMirrorLoop,
  FileRefusalMemory,
  entryFingerprint,
  entryKey,
  fetchMirrorKeys,
  parseLearnedMarkdown,
  postEntries,
  readBrainEntries,
  syncBrainToMirror,
  type BrainEntry,
} from '../apps/desktop/src/main/brain-mirror';

const file = [
  '# Bugs',
  '',
  '## [2026-09-22] Retry dropped the Retry-After header -- claude-code',
  '#tags: retry,provider',
  '**Bug:** A 429 was retried after the fixed backoff.',
  '**Fix:** Read the header and take the longer of the two.',
  '',
  '## [2026-09-23] Panel showed -- dashes in titles -- overwatch',
  '**Bug:** The title was split on the first separator.',
  '',
].join('\n');

describe('parseLearnedMarkdown', () => {
  it('reads each entry with its agent, tags and body', () => {
    const entries = parseLearnedMarkdown('bugs', file);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ type: 'bugs', title: 'Retry dropped the Retry-After header', agent: 'claude-code', tags: 'retry,provider', date: '2026-09-22' });
    expect(entries[0]?.body).toContain('**Fix:** Read the header');
  });

  it('takes the agent from the last separator, so a title may contain its own dashes', () => {
    expect(parseLearnedMarkdown('bugs', file)[1]?.title).toBe('Panel showed -- dashes in titles');
    expect(parseLearnedMarkdown('bugs', file)[1]?.agent).toBe('overwatch');
  });

  it('reads a file written with Windows line endings, which is what the daemon produces', () => {
    const entries = parseLearnedMarkdown('bugs', file.replace(/\n/g, '\r\n'));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ title: 'Retry dropped the Retry-After header', agent: 'claude-code' });
    expect(entries[0]?.body).not.toContain('\r');
  });

  it('ignores prose that is not an entry', () => {
    expect(parseLearnedMarkdown('decisions', '# Decisions\n\nNothing yet.\n')).toEqual([]);
    expect(parseLearnedMarkdown('decisions', '')).toEqual([]);
  });

  it('reads the project the entry was filed under out of its body', () => {
    const withProject = parseLearnedMarkdown('bugs', [
      '# Bugs',
      '## [2026-09-22] Cache keys ignored the project id -- claude-code',
      'Project: SharpSite',
      '**Bug:** Two projects shared one cache entry.',
      '',
    ].join('\n'));

    expect(withProject[0]?.project).toBe('SharpSite');
    // An entry with no project line stays without one, rather than being given a name it never had.
    expect(parseLearnedMarkdown('bugs', file)[0]?.project).toBeUndefined();
  });
});

describe('postEntries', () => {
  const entries: BrainEntry[] = [
    { type: 'bugs', title: 'a', agent: 'x', tags: '', date: '2026-09-01', body: '' },
    { type: 'bugs', title: 'b', agent: 'x', tags: '', date: '2026-09-02', body: '' },
    { type: 'bugs', title: 'c', agent: 'x', tags: '', date: '2026-09-03', body: '' },
  ];

  it('counts what the receiving brain took, turned away and failed on', async () => {
    const answers = [true, false];
    let call = 0;
    const outcome = await postEntries(entries, {
      post: async () => {
        call += 1;
        if (call === 3) throw new Error('daemon is down');
        return answers[call - 1]!;
      },
    });
    expect(outcome).toEqual({ read: 3, posted: 1, rejected: 1, failed: 1 });
  });

  it('keeps going after a failure, so one bad entry does not stop the copy', async () => {
    const seen: string[] = [];
    await postEntries(entries, {
      post: async (entry) => {
        seen.push(entry.title);
        if (entry.title === 'a') throw new Error('nope');
        return true;
      },
    });
    expect(seen).toEqual(['a', 'b', 'c']);
  });
});

describe('entryKey', () => {
  it('matches the way the receiving brain compares titles', () => {
    expect(entryKey('bugs', 'Retry dropped the Retry-After header')).toBe(entryKey('bugs', 'retry dropped the retry after header!'));
    expect(entryKey('bugs', 'Same title')).not.toBe(entryKey('patterns', 'Same title'));
  });
});

describe('syncBrainToMirror', () => {
  let brain: string;

  beforeEach(async () => {
    brain = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-mirror-'));
    await fs.mkdir(path.join(brain, 'learned'), { recursive: true });
    await fs.writeFile(path.join(brain, 'learned', 'bugs.md'), [
      '# Bugs',
      '## [2026-09-22] Cache keys ignored the project id -- claude-code',
      '**Bug:** Two projects shared one cache entry.',
      '## [2026-09-23] Retry dropped the Retry-After header -- claude-code',
      '**Fix:** Read the header.',
      '',
    ].join('\n'));
  });

  afterEach(async () => {
    await fs.rm(brain, { recursive: true, force: true });
  });

  const exportOnly = (entries: Array<{ type: string; title: string }>) => vi.fn(async () =>
    ({ ok: true, json: async () => ({ entries }) }) as unknown as Response);

  it('sends only what the mirror does not already hold', async () => {
    const sent: Array<{ type?: string; title?: string }> = [];
    const fetchImpl = vi.fn(async (url: URL | string, init?: RequestInit) => {
      if (String(url).includes('/api/brain/export')) {
        return { ok: true, json: async () => ({ entries: [{ type: 'bugs', title: 'Cache keys ignored the project ID' }] }) } as unknown as Response;
      }
      sent.push(JSON.parse(String(init?.body ?? '{}')));
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
    }) as unknown as typeof fetch;

    const outcome = await syncBrainToMirror({ sourceBrain: brain, endpoint: 'http://127.0.0.1:9876', fetchImpl });
    expect(outcome).toEqual({ read: 2, posted: 1, rejected: 0, failed: 0, skipped: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'bugs', title: 'Retry dropped the Retry-After header' });
  });

  it('sends each entry under its own project, not one project for the whole sync', async () => {
    // Without this every mirrored entry landed in the other brain as `global`, dated the day it was copied — so the
    // project it belonged to was gone, and it picked up a recency boost that crowded out real recall.
    await fs.writeFile(path.join(brain, 'learned', 'bugs.md'), [
      '# Bugs',
      '## [2026-09-22] One -- claude-code',
      'Project: SharpSite',
      '**Bug:** a',
      '## [2026-09-23] Two -- claude-code',
      'Project: Other Project',
      '**Bug:** b',
      '',
    ].join('\n'));
    const sent: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (url: URL | string, init?: RequestInit) => {
      if (String(url).includes('/api/brain/export')) return { ok: true, json: async () => ({ entries: [] }) } as unknown as Response;
      sent.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
    }) as unknown as typeof fetch;

    await syncBrainToMirror({ sourceBrain: brain, endpoint: 'http://127.0.0.1:9876', fetchImpl, project: 'Fallback' });

    expect(sent.map((entry) => entry.project)).toEqual(['SharpSite', 'Other Project']);
  });

  it('reports an entry the mirror refused, with the reason it gave', async () => {
    const refused: Array<[string, string]> = [];
    const fetchImpl = vi.fn(async (url: URL | string, init?: RequestInit) => {
      if (String(url).includes('/api/brain/export')) return { ok: true, json: async () => ({ entries: [] }) } as unknown as Response;
      const body = JSON.parse(String(init?.body ?? '{}')) as { title?: string };
      if (body.title === 'Retry dropped the Retry-After header') {
        return { ok: true, json: async () => ({ rejected: true, reason: 'too similar to an existing entry' }) } as unknown as Response;
      }
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
    }) as unknown as typeof fetch;

    const outcome = await syncBrainToMirror({
      sourceBrain: brain,
      endpoint: 'http://127.0.0.1:9876',
      fetchImpl,
      onRejected: (entry, reason) => refused.push([entry.title, reason]),
    });

    expect(outcome.rejected).toBe(1);
    expect(refused).toEqual([['Retry dropped the Retry-After header', 'too similar to an existing entry']]);
  });

  it('sends everything when the mirror cannot say what it holds, since it turns duplicates away itself', async () => {
    const fetchImpl = vi.fn(async (url: URL | string) => {
      if (String(url).includes('/api/brain/export')) return { ok: false, status: 500 } as unknown as Response;
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const outcome = await syncBrainToMirror({ sourceBrain: brain, endpoint: 'http://127.0.0.1:9876', fetchImpl });
    expect(outcome).toMatchObject({ read: 2, posted: 2, skipped: 0 });
  });

  it('counts a duplicate the mirror reports as turned away, not filed', async () => {
    const fetchImpl = vi.fn(async (url: URL | string) => {
      if (String(url).includes('/api/brain/export')) return { ok: true, json: async () => ({ entries: [] }) } as unknown as Response;
      return { ok: true, json: async () => ({ ok: false, duplicate: true }) } as unknown as Response;
    }) as unknown as typeof fetch;
    expect(await syncBrainToMirror({ sourceBrain: brain, endpoint: 'http://127.0.0.1:9876', fetchImpl })).toMatchObject({ posted: 0, rejected: 2 });
  });

  it('writes nothing on a dry run', async () => {
    const fetchImpl = exportOnly([]);
    const outcome = await syncBrainToMirror({ sourceBrain: brain, endpoint: 'http://127.0.0.1:9876', dryRun: true, fetchImpl });
    expect(outcome).toEqual({ read: 2, posted: 0, rejected: 0, failed: 0, skipped: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reads each learned file, and treats a missing one as empty', async () => {
    expect(await readBrainEntries(brain)).toHaveLength(2);
    expect(parseLearnedMarkdown('decisions', '')).toEqual([]);
  });
});

describe('remembering what the mirror refused', () => {
  let brain: string;
  let memoryDir: string;

  const writeBrain = (body: string) => fs.writeFile(path.join(brain, 'learned', 'gotchas.md'), [
    '# Gotchas',
    '## [2026-11-01] Footer sat at the top of short pages -- claude-code',
    '**Gotcha:** Needs a flex column on the page.',
    '## [2026-11-02] the footer should always be at the bottom -- user',
    body,
    '',
  ].join('\n'));

  beforeEach(async () => {
    brain = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-mirror-refuse-'));
    memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-mirror-memory-'));
    await fs.mkdir(path.join(brain, 'learned'), { recursive: true });
    await writeBrain('should always be at the bottom of the page');
  });

  afterEach(async () => {
    await fs.rm(brain, { recursive: true, force: true });
    await fs.rm(memoryDir, { recursive: true, force: true });
  });

  /** A mirror that holds `held` titles, and answers a learn request for the noisy entry as given. */
  const mirror = (held: string[], answer: () => Response) => {
    const posted: string[] = [];
    const fetchImpl = vi.fn(async (url: URL | string, init?: RequestInit) => {
      if (String(url).includes('/api/brain/export')) {
        return { ok: true, json: async () => ({ entries: held.map((title) => ({ type: 'gotchas', title })) }) } as unknown as Response;
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { title?: string };
      posted.push(body.title ?? '');
      if (body.title === 'the footer should always be at the bottom') return answer();
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
    }) as unknown as typeof fetch;
    return { fetchImpl, posted };
  };

  const refusal = () => ({ ok: true, json: async () => ({ rejected: true, reason: 'Noise keyword detected: "should "' }) }) as unknown as Response;
  const options = (fetchImpl: typeof fetch, refusals: FileRefusalMemory, onRejected?: (title: string, reason: string) => void) => ({
    sourceBrain: brain,
    endpoint: 'http://127.0.0.1:9876',
    fetchImpl,
    refusals,
    ...(onRejected ? { onRejected: (entry: BrainEntry, reason: string) => onRejected(entry.title, reason) } : {}),
  });

  it('asks about a refused entry once, not on every pass', async () => {
    const memory = new FileRefusalMemory(path.join(memoryDir, 'refused.json'));
    const refused: string[] = [];
    const first = mirror([], refusal);
    const one = await syncBrainToMirror(options(first.fetchImpl, memory, (title) => refused.push(title)));
    expect(first.posted).toHaveLength(2);
    expect(one.rejected).toBe(1);
    expect(refused).toEqual(['the footer should always be at the bottom']);

    // The next pass: the mirror now holds the accepted entry, and the refused one is not sent or reported again.
    const second = mirror(['Footer sat at the top of short pages'], refusal);
    const two = await syncBrainToMirror(options(second.fetchImpl, memory, (title) => refused.push(title)));
    expect(second.posted).toEqual([]);
    expect(two).toMatchObject({ posted: 0, rejected: 0, knownRefused: 1 });
    expect(refused).toHaveLength(1);
  });

  it('remembers across a restart, because the memory is a file', async () => {
    const file = path.join(memoryDir, 'refused.json');
    await syncBrainToMirror(options(mirror([], refusal).fetchImpl, new FileRefusalMemory(file)));
    const after = mirror(['Footer sat at the top of short pages'], refusal);
    const outcome = await syncBrainToMirror(options(after.fetchImpl, new FileRefusalMemory(file)));
    expect(after.posted).toEqual([]);
    expect(outcome.knownRefused).toBe(1);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toHaveProperty([entryKey('gotchas', 'the footer should always be at the bottom')]);
  });

  it('asks again when the entry\'s text has changed, since an edited entry is a new question', async () => {
    const memory = new FileRefusalMemory(path.join(memoryDir, 'refused.json'));
    await syncBrainToMirror(options(mirror([], refusal).fetchImpl, memory));
    await writeBrain('Pin the footer with a flex column so it sits at the bottom even on short pages.');
    const again = mirror(['Footer sat at the top of short pages'], () => ({ ok: true, json: async () => ({ ok: true }) }) as unknown as Response);
    const outcome = await syncBrainToMirror(options(again.fetchImpl, memory));
    expect(again.posted).toEqual(['the footer should always be at the bottom']);
    expect(outcome.posted).toBe(1);
  });

  it('does not ask again under a title refused as too similar, whatever the wording', async () => {
    const memory = new FileRefusalMemory(path.join(memoryDir, 'refused.json'));
    const similar = () => ({ ok: true, json: async () => ({ rejected: true, reason: 'Title too similar to existing "decisions" entry (100% match)' }) }) as unknown as Response;
    await syncBrainToMirror(options(mirror([], similar).fetchImpl, memory));
    await writeBrain('A different body under the same title.');
    const again = mirror(['Footer sat at the top of short pages'], similar);
    await syncBrainToMirror(options(again.fetchImpl, memory));
    expect(again.posted).toEqual([]);
  });

  it('does not remember a duplicate, because that resolves itself once the mirror lists the entry', async () => {
    const memory = new FileRefusalMemory(path.join(memoryDir, 'refused.json'));
    const duplicate = () => ({ ok: true, json: async () => ({ duplicate: true }) }) as unknown as Response;
    await syncBrainToMirror(options(mirror([], duplicate).fetchImpl, memory));
    const next = mirror(['Footer sat at the top of short pages'], duplicate);
    await syncBrainToMirror(options(next.fetchImpl, memory));
    expect(next.posted).toEqual(['the footer should always be at the bottom']);
  });

  it('remembers a client error as a judgement on the entry, but retries a server error and a rate limit', async () => {
    const status = (code: number) => () => ({ ok: false, status: code, json: async () => ({}) }) as unknown as Response;
    for (const [code, remembered] of [[422, true], [400, true], [500, false], [429, false], [408, false]] as const) {
      const memory = new FileRefusalMemory(path.join(memoryDir, `refused-${code}.json`));
      await syncBrainToMirror(options(mirror([], status(code)).fetchImpl, memory));
      const next = mirror(['Footer sat at the top of short pages'], status(code));
      await syncBrainToMirror(options(next.fetchImpl, memory));
      expect(next.posted.length > 0, `status ${code}`).toBe(!remembered);
    }
  });

  it('works without a memory, exactly as before', async () => {
    const m = mirror([], refusal);
    const outcome = await syncBrainToMirror({ sourceBrain: brain, endpoint: 'http://127.0.0.1:9876', fetchImpl: m.fetchImpl });
    expect(outcome.rejected).toBe(1);
    // With no memory the outcome is exactly what it always was: no extra field.
    expect(outcome).not.toHaveProperty('knownRefused');
  });
});

describe('the refusal file', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-refusal-file-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  const entry: BrainEntry = { type: 'gotchas', title: 'A title', agent: 'user', tags: '', date: '2026-11-01', body: 'some words' };

  it('keeps a refusal for the exact wording only', async () => {
    const memory = new FileRefusalMemory(path.join(dir, 'r.json'));
    memory.add(entryKey(entry.type, entry.title), entryFingerprint(entry), 'noise');
    expect(memory.has(entryKey(entry.type, entry.title), entryFingerprint(entry))).toBe(true);
    expect(memory.has(entryKey(entry.type, entry.title), entryFingerprint({ ...entry, body: 'other words' }))).toBe(false);
    expect(memory.has('gotchas:another title', entryFingerprint(entry))).toBe(false);
  });

  it('writes nothing when nothing was added, and starts empty from a missing or damaged file', async () => {
    const file = path.join(dir, 'r.json');
    const quiet = new FileRefusalMemory(file);
    await quiet.load();
    await quiet.save();
    await expect(fs.stat(file)).rejects.toThrow();

    await fs.writeFile(file, '{ not json');
    const damaged = new FileRefusalMemory(file);
    await damaged.load();
    expect(damaged.size()).toBe(0);
    damaged.add('k', 'f', 'why');
    await damaged.save();
    const reloaded = new FileRefusalMemory(file);
    await reloaded.load();
    expect(reloaded.has('k', 'f')).toBe(true);
  });
});

describe('BrainMirrorLoop', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('takes an early first pass, then keeps to its interval until it is stopped', async () => {
    const sync = vi.fn(async () => ({ posted: 1, failed: 0 }));
    const loop = new BrainMirrorLoop({ ready: async () => true, sync, intervalMs: 60_000 });
    loop.start();
    // start() waits before its first pass, so a launch is not competing with everything else the app is doing.
    await vi.advanceTimersByTimeAsync(44_000);
    expect(sync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sync).toHaveBeenCalledTimes(2);
    loop.stop();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('does nothing while the mirror is off, and keeps a failure to itself', async () => {
    const sync = vi.fn(async () => { throw new Error('the daemon is down'); });
    const onError = vi.fn();
    const loop = new BrainMirrorLoop({ ready: async () => true, sync, intervalMs: 1_000, onError });
    await loop.tick();
    expect(onError).toHaveBeenCalled();
    const off = new BrainMirrorLoop({ ready: async () => false, sync: vi.fn(), intervalMs: 1_000 });
    await off.tick();
  });

  it('never runs two passes at once', async () => {
    let release: (() => void) | undefined;
    const sync = vi.fn(async () => { await new Promise<void>((resolve) => { release = resolve; }); return { posted: 0, failed: 0 }; });
    const loop = new BrainMirrorLoop({ ready: async () => true, sync, intervalMs: 1_000 });
    const first = loop.tick();
    await loop.tick();
    expect(sync).toHaveBeenCalledTimes(1);
    release?.();
    await first;
  });
});
