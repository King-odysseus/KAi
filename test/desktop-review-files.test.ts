import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DesktopChangeReviewer,
  buildFilesReviewPrompt,
  packFileDiffs,
  parseFilesReview,
  type ChangeReviewPorts,
} from '../apps/desktop/src/main/change-review';
import { gitDiffAgainstHead } from '../apps/desktop/src/main/git-tools';

vi.setConfig({ testTimeout: 90_000 });

const execFileAsync = promisify(execFile);
const git = async (cwd: string, args: string[]): Promise<string> => (await execFileAsync('git', args, { cwd })).stdout;

const REPLY = JSON.stringify({
  ok: false,
  summary: 'The stylesheet was removed but a page still links to it.',
  issues: [
    { file: 'src/index.css', line: 12, severity: 'high', note: 'The selector .hero was renamed but index.html still uses it.' },
    { file: 'C:\\project\\src\\App.css', line: null, severity: 'medium', note: 'Deleted while main.tsx still imports it.' },
    { file: 'not/reviewed.ts', line: 3, severity: 'high', note: 'A file that was never in the review.' },
    { file: 'src/index.css', line: 0, severity: 'weird', note: '   ' },
  ],
});

describe('AI review of several files', () => {
  it('keeps findings only for files that were reviewed, with their line, and drops empty or invented ones', () => {
    const parsed = parseFilesReview(REPLY, ['src/index.css', 'src/App.css']);
    expect(parsed.ok).toBe(false);
    expect(parsed.findings).toEqual([
      { file: 'src/index.css', line: 12, severity: 'high', note: 'The selector .hero was renamed but index.html still uses it.' },
      { file: 'src/App.css', severity: 'medium', note: 'Deleted while main.tsx still imports it.' },
    ]);
  });

  it('calls a change with only low findings fine, and rejects a reply of the wrong shape', () => {
    const low = parseFilesReview(JSON.stringify({ ok: true, summary: 'Fine.', issues: [{ file: 'a.ts', line: null, severity: 'low', note: 'Naming.' }] }), ['a.ts']);
    expect(low.ok).toBe(true);
    expect(() => parseFilesReview(JSON.stringify({ summary: 'x' }), ['a.ts'])).toThrow(/expected shape/);
  });

  it('packs diffs into one request and says what it left out and why', () => {
    const big = `diff --git a/big.ts b/big.ts\n${'+line\n'.repeat(3_000)}`;
    const packed = packFileDiffs([
      { path: 'a.ts', diff: 'diff --git a/a.ts b/a.ts\n+one' },
      { path: 'empty.ts', diff: '   ' },
      { path: 'logo.png', diff: 'Binary files a/logo.png and b/logo.png differ' },
      { path: 'big.ts', diff: big },
    ]);
    expect(packed.included).toEqual(['a.ts', 'big.ts']);
    expect(packed.skipped).toEqual([
      { file: 'empty.ts', reason: 'No text changes to read' },
      { file: 'logo.png', reason: 'Binary file' },
    ]);
    expect(packed.text).toContain('=== FILE: a.ts ===');
    expect(packed.text).toContain('[diff trimmed]');
  });

  it('stops adding files once the request would be too large', () => {
    const files = Array.from({ length: 12 }, (_, index) => ({ path: `f${index}.ts`, diff: `diff\n${'+x\n'.repeat(4_000)}` }));
    const packed = packFileDiffs(files);
    expect(packed.included.length).toBeLessThan(12);
    expect(packed.skipped.every((item) => /Too much for one review/.test(item.reason))).toBe(true);
    expect(packed.included.length + packed.skipped.length).toBe(12);
  });

  it('asks the reviewer to name the file exactly and to use null when unsure of a line', () => {
    const prompt = buildFilesReviewPrompt('', '=== FILE: a.ts ===\n+x', ['a.ts'], 'novice');
    expect(prompt.system).toContain('exactly as written in a heading');
    expect(prompt.system).toContain('null');
    expect(prompt.user).toContain('Files (1): a.ts');
    expect(prompt.user).toContain('correctness, regressions, security');
  });

  it('explains what to set up when there is no model, instead of quietly returning nothing', async () => {
    const ports: ChangeReviewPorts = {
      pickConnection: async () => ({ reason: 'The Prompt Guide is off.' }),
      requester: { structuredRequest: async () => { throw new Error('should not be called'); } },
    };
    await expect(new DesktopChangeReviewer(ports).reviewFiles('', [{ path: 'a.ts', diff: 'diff\n+x' }], 'novice'))
      .rejects.toThrow(/The Prompt Guide is off\..*Settings/);
  });

  it('runs one request for all the files and reports what it read and skipped', async () => {
    const calls: string[] = [];
    const ports: ChangeReviewPorts = {
      pickConnection: async () => ({ connection: {} as never }),
      requester: {
        structuredRequest: async (_connection, _names, prompt, _schemaName, _schema, parse) => {
          calls.push(prompt.user);
          return parse(REPLY) as never;
        },
      },
    };
    const result = await new DesktopChangeReviewer(ports).reviewFiles('Tidy the styles', [
      { path: 'src/index.css', diff: 'diff --git a/src/index.css b/src/index.css\n+.hero {}' },
      { path: 'src/App.css', diff: 'diff --git a/src/App.css b/src/App.css\ndeleted file mode 100644\n-/* x */' },
      { path: 'logo.png', diff: 'Binary files a/logo.png and b/logo.png differ' },
    ], 'intermediate');
    // One request reads every file; a second, sceptical one checks the findings. Here the check's reply is the wrong
    // shape, so it fails — and a failed check must leave the findings standing, untagged.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('Tidy the styles');
    expect(calls[1]).toContain('Findings to check');
    expect(result.reviewedFiles).toEqual(['src/index.css', 'src/App.css']);
    expect(result.skippedFiles).toEqual([{ file: 'logo.png', reason: 'Binary file' }]);
    expect(result.findings).toHaveLength(2);
    expect(result.dismissed).toBeUndefined();
  });

  it('drops a finding the second check rejects and says how many it dismissed', async () => {
    let call = 0;
    const ports: ChangeReviewPorts = {
      pickConnection: async () => ({ connection: {} as never }),
      requester: {
        structuredRequest: async (_connection, _names, _prompt, _schemaName, _schema, parse) => {
          call += 1;
          return parse(call === 1
            ? REPLY
            : JSON.stringify({ verdicts: [{ index: 0, verdict: 'rejected', reason: 'the diff shows the rename' }, { index: 1, verdict: 'confirmed', reason: 'still imported' }] })) as never;
        },
      },
    };
    const result = await new DesktopChangeReviewer(ports).reviewFiles('Tidy the styles', [
      { path: 'src/index.css', diff: 'diff --git a/src/index.css b/src/index.css\n+.hero {}' },
      { path: 'src/App.css', diff: 'diff --git a/src/App.css b/src/App.css\ndeleted file mode 100644\n-/* x */' },
    ], 'intermediate');
    expect(result.dismissed).toBe(1);
    expect(result.findings).toEqual([{ file: 'src/App.css', severity: 'medium', note: 'Deleted while main.tsx still imports it.', verdict: 'confirmed' }]);
    expect(result.ok).toBe(false);
  });

  it('does not call the model when every file is empty or binary', async () => {
    const structuredRequest = vi.fn();
    const ports: ChangeReviewPorts = { pickConnection: async () => ({ connection: {} as never }), requester: { structuredRequest } };
    const result = await new DesktopChangeReviewer(ports).reviewFiles('', [{ path: 'logo.png', diff: 'Binary files a and b differ' }], 'novice');
    expect(structuredRequest).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, findings: [], reviewedFiles: [] });
    expect(result.skippedFiles).toEqual([{ file: 'logo.png', reason: 'Binary file' }]);
  });
});

describe('the diff a review reads', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'kai-review-diff-')));
    await git(repo, ['init', '-q']);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'KAI Test']);
    await fs.writeFile(path.join(repo, 'a.css'), '.a {}\n');
    await fs.writeFile(path.join(repo, 'gone.css'), '/* unused */\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-q', '-m', 'init']);
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('includes a staged change, which the unstaged diff would show as nothing', async () => {
    await fs.writeFile(path.join(repo, 'a.css'), '.a { color: red; }\n');
    await git(repo, ['add', 'a.css']);
    expect(await gitDiffAgainstHead(repo, 'a.css')).toContain('+.a { color: red; }');
  });

  it('shows a deleted file, whether or not the deletion is staged', async () => {
    await fs.rm(path.join(repo, 'gone.css'));
    expect(await gitDiffAgainstHead(repo, 'gone.css')).toContain('-/* unused */');
    await git(repo, ['add', 'gone.css']);
    expect(await gitDiffAgainstHead(repo, 'gone.css')).toContain('deleted file mode');
  });

  it('shows a new untracked file as all additions', async () => {
    await fs.writeFile(path.join(repo, 'new.css'), '.new {}\n');
    expect(await gitDiffAgainstHead(repo, 'new.css')).toContain('+.new {}');
  });

  it('shows a change made in the working tree and staged again on top', async () => {
    await fs.writeFile(path.join(repo, 'a.css'), '.a { color: red; }\n');
    await git(repo, ['add', 'a.css']);
    await fs.writeFile(path.join(repo, 'a.css'), '.a { color: blue; }\n');
    const diff = await gitDiffAgainstHead(repo, 'a.css');
    expect(diff).toContain('+.a { color: blue; }');
    expect(diff).not.toContain('color: red');
  });
});
