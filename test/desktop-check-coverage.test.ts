import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyCheck, coverageNote, isSourceNeedingCoverage, testNamedFor } from '../apps/desktop/src/main/check-coverage';

/**
 * What a passing check can honestly be said to confirm.
 *
 * A task about going through every page was closed by `npm run lint` passing. Nothing in the check itself is wrong —
 * what was wrong was closing on it without saying what it does not cover.
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('what a check confirms', () => {
  it('tells a test run from a static check from anything else', () => {
    for (const command of ['npm test', 'npm run test', 'pnpm e2e', 'vitest run', 'pytest -q', 'cargo test', 'go test ./...']) {
      expect(classifyCheck(command), command).toBe('tests');
    }
    for (const command of ['npm run lint', 'npm run typecheck', 'tsc --noEmit', 'eslint .', 'cargo clippy']) {
      expect(classifyCheck(command), command).toBe('static');
    }
    for (const command of ['npm run build', 'curl -s localhost:3000', 'node scripts/smoke.mjs']) {
      expect(classifyCheck(command), command).toBe('other');
    }
  });

  it('counts source files, not tests, docs or KAI own bookkeeping', () => {
    expect(isSourceNeedingCoverage('src/pages/Home.tsx')).toBe(true);
    expect(isSourceNeedingCoverage('src/pages/Home.test.tsx')).toBe(false);
    expect(isSourceNeedingCoverage('src/pages/home.spec.ts')).toBe(false);
    expect(isSourceNeedingCoverage('tests/home.ts')).toBe(false);
    expect(isSourceNeedingCoverage('README.md')).toBe(false);
    expect(isSourceNeedingCoverage('package.json')).toBe(false);
    expect(isSourceNeedingCoverage('.kai/plan.json')).toBe(false);
  });

  it('says nothing when the tests cover everything the run changed', () => {
    expect(coverageNote('npm test', ['src/app.ts'], () => true)).toBeNull();
    // A run that changed only docs, or only tests, has nothing to be honest about.
    expect(coverageNote('npm test', ['README.md'], () => false)).toBeNull();
    expect(coverageNote('npm test', ['src/app.test.ts'], () => false)).toBeNull();
    expect(coverageNote('npm test', [], () => false)).toBeNull();
  });

  it('says a test run does not confirm files no test is named for', () => {
    const note = coverageNote('npm test', ['src/app.ts', 'src/pages/Home.tsx'], (file) => file === 'src/app.ts');
    expect(note).toContain('npm test');
    expect(note).toContain('src/pages/Home.tsx');
    expect(note).not.toContain('src/app.ts,');
    expect(note).toContain('does not confirm');
  });

  it('says plainly that a lint is not a test, which is the whole point', () => {
    const note = coverageNote('npm run lint', ['src/pages/Home.tsx'], () => false);
    expect(note).toContain('static check');
    expect(note).toContain('not that the change works');
    expect(note).toContain('No test is named for src/pages/Home.tsx');
  });

  it('keeps quiet about a command it cannot read, which is the person\'s own check', () => {
    expect(coverageNote('node scripts/check-pages.mjs', ['src/pages/Home.tsx'], () => false)).toBeNull();
  });

  it('names three files and counts the rest', () => {
    const changed = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'];
    expect(coverageNote('npm test', changed, () => false)).toContain('src/a.ts, src/b.ts, src/c.ts and 2 more');
  });
});

describe('finding the test a file would be named for', () => {
  it('looks beside the file, and in the places a project keeps its tests', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kai-coverage-'));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, 'src', 'pages'), { recursive: true });
    await mkdir(path.join(root, 'tests'), { recursive: true });
    await writeFile(path.join(root, 'src', 'app.ts'), '');
    await writeFile(path.join(root, 'src', 'app.test.ts'), '');
    await writeFile(path.join(root, 'tests', 'helper.ts'), '');
    await writeFile(path.join(root, 'src', 'pages', 'Home.tsx'), '');

    expect(await testNamedFor(root, 'src/app.ts')).toBe(true);
    expect(await testNamedFor(root, 'tests/helper.ts')).toBe(false);
    expect(await testNamedFor(root, 'src/pages/Home.tsx')).toBe(false);
  });

  it('finds a spec in a __tests__ folder beside it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kai-coverage-'));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, 'src', '__tests__'), { recursive: true });
    await writeFile(path.join(root, 'src', 'util.ts'), '');
    await writeFile(path.join(root, 'src', '__tests__', 'util.ts'), '');
    expect(await testNamedFor(root, 'src/util.ts')).toBe(true);
  });
});
