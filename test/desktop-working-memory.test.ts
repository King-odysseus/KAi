import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compactRules, withAutopilotException } from '../apps/desktop/src/main/execution-rules';
import { ownFoldThreshold, WorkingMemory } from '../apps/desktop/src/main/working-memory';

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true }); });

function project(files: Record<string, string>): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-memory-'));
  folders.push(folder);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(folder, name), text);
  return folder;
}

const read = (file: string, lines: string[], from = 1) => ({
  path: file, startLine: from, endLine: from + lines.length - 1, text: lines.map((line, index) => `${from + index}: ${line}`).join('\n'),
});

describe('read memory', () => {
  it('answers a repeated read with a note once, then with the text', () => {
    const memory = new WorkingMemory();
    const output = read('a.ts', ['one', 'two', 'three']);
    expect(memory.observe('read_file', { path: 'a.ts' }, output, true)).toBe(output);
    const part = read('a.ts', ['two'], 2);
    expect(memory.observe('read_file', { path: './a.ts' }, part, true)).toMatchObject({ unchanged: true, startLine: 2, endLine: 2 });
    expect(memory.observe('read_file', { path: 'a.ts' }, part, true)).toBe(part);
  });

  it('sends changed lines, unread lines and anything read before an edit in full', () => {
    const memory = new WorkingMemory();
    memory.observe('read_file', {}, read('a.ts', ['one', 'two']), true);
    const changed = read('a.ts', ['one', 'TWO']);
    expect(memory.observe('read_file', {}, changed, true)).toBe(changed);
    const more = read('a.ts', ['three'], 3);
    expect(memory.observe('read_file', {}, more, true)).toBe(more);
    memory.observe('replace_in_file', { path: 'a.ts' }, { path: 'a.ts' }, true);
    expect(memory.observe('read_file', {}, changed, true)).toBe(changed);
  });
});

describe('a fold', () => {
  it('carries what was done, what the person said, the last check and the files as they are now', async () => {
    const root = project({ 'plan.md': 'the plan\n', 'work.ts': 'before\n' });
    const memory = new WorkingMemory();
    memory.observe('read_file', { path: 'plan.md' }, read('plan.md', ['the plan', '']), true);
    memory.observe('read_file', { path: 'work.ts' }, read('work.ts', ['before', '']), true);
    memory.observe('replace_in_file', { path: 'work.ts' }, { path: 'work.ts' }, true);
    fs.writeFileSync(path.join(root, 'work.ts'), 'after\n');
    memory.observe('run_command', { command: 'npm test' }, { exitCode: 1, stdout: 'Error: expected 2' }, false);
    memory.noteSteering('Do not change the app code.');

    const text = await memory.fold(root, 10_000, 'I will fix the assertion.');

    expect(text).toContain('Do not change the app code.');
    expect(text).toContain('Files you changed: work.ts');
    expect(text).toContain('Last check: npm test (exit 1)');
    expect(text).toContain('Error: expected 2');
    expect(text).toContain('1: after');
    expect(text).toContain('1: the plan');
    expect(text).not.toContain('1: before');
    // What the fold carried counts as seen.
    expect(memory.observe('read_file', {}, read('work.ts', ['after', '']), true)).toMatchObject({ unchanged: true });
  });

  it('names what it has no room for, never reads outside the project, and keeps the latest file first', async () => {
    const root = project({ 'big.ts': `${'x'.repeat(5_000)}\n`, 'small.ts': 'tiny\n' });
    const memory = new WorkingMemory();
    memory.observe('read_file', {}, read('big.ts', ['x']), true);
    memory.observe('read_file', {}, read('../outside.ts', ['secret']), true);
    memory.observe('read_file', {}, read('small.ts', ['tiny']), true);

    const text = await memory.fold(root, 1_000, '');

    expect(text).toContain('1: tiny');
    expect(text).toContain('not shown here for room. Read the lines you need: big.ts');
    expect(text).not.toContain('secret');
    const big = read('big.ts', ['x']);
    expect(memory.observe('read_file', {}, big, true)).toBe(big);
  });

  it('folds against the whole request, with a floor when the instructions are huge', () => {
    expect(ownFoldThreshold(65_536, 24_000)).toBe(25_152);
    expect(ownFoldThreshold(65_536, 60_000)).toBe(13_107);
  });
});

describe('the short rules for a model on your own hardware', () => {
  const full = fs.readFileSync(path.join(__dirname, 'fixtures', 'standing-rules-sample.md'), 'utf8');

  it('keeps every rule, the commit section and any exception, in far less room', () => {
    const short = compactRules(withAutopilotException(full));
    for (let number = 1; number <= 12; number += 1) expect(short).toMatch(new RegExp(`^${number}\\. `, 'm'));
    expect(short).toContain('1. No keys ever: Never commit secrets.');
    expect(short).toContain('Stage specifically');
    expect(short).toContain('## Exception for Autopilot runs');
    expect(short).not.toContain('Session Checklist');
    expect(short).not.toContain('MCP Tools Reference');
    expect(short).not.toContain('Check the status.');
    expect(short.length).toBeLessThan(full.length);
  });

  it('leaves a document without numbered rules alone', () => {
    expect(compactRules('Be kind.')).toBe('Be kind.');
  });
});
