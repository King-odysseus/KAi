import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureSpecIgnore, SPEC_IGNORE_CONTENT } from '../apps/desktop/src/main/spec-store';

let root = '';
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-spec-ignore-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });

/** The paths git would leave out, out of the ones given. */
function ignored(paths: string[]): string[] {
  for (const relative of paths) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), 'x');
  }
  try {
    return execFileSync('git', ['check-ignore', ...paths], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return []; // check-ignore exits 1 when nothing is ignored
  }
}

describe('keeping KAI\'s own pictures out of the project\'s history', () => {
  it('ignores check screenshots and Equalizer pictures, and nothing a person would want versioned', async () => {
    await ensureSpecIgnore(root);
    expect(ignored([
      '.kai/spec/board/home/2026-10-26T19-00-00/phone-dark.png',
      '.kai/spec/equalizer/run-1/home/difference.png',
      '.kai/spec/board.json',
      '.kai/spec/brief.md',
      '.kai/spec/equalizer/run-1/report.md',
      '.kai/spec/design/tokens.json',
      '.kai/spec/design/references/moodboard.png',
      'public/logo.png',
    ])).toEqual([
      '.kai/spec/board/home/2026-10-26T19-00-00/phone-dark.png',
      '.kai/spec/equalizer/run-1/home/difference.png',
    ]);
  });

  it('leaves a file the person already changed alone', async () => {
    const file = path.join(root, '.kai/spec/.gitignore');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# I version my screenshots\n');
    await ensureSpecIgnore(root);
    expect(fs.readFileSync(file, 'utf8')).toBe('# I version my screenshots\n');
  });

  it('writes the file once and is quiet on every later call', async () => {
    await ensureSpecIgnore(root);
    await ensureSpecIgnore(root);
    expect(fs.readFileSync(path.join(root, '.kai/spec/.gitignore'), 'utf8')).toBe(SPEC_IGNORE_CONTENT);
  });
});
