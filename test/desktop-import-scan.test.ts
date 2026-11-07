import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importCardId, scanForImport, suggestCheck } from '../apps/desktop/src/main/import-scan';

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'kai-import-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function put(file: string, content = ''): Promise<void> {
  const target = path.join(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

describe('import scan', () => {
  it('flags the missing basics of a bare project, worst first', async () => {
    await put('package.json', JSON.stringify({ name: 'x', scripts: {} }));
    await put('src/index.ts', 'export const a = 1;\n');
    await put('.env', 'KEY=1\n');
    const report = await scanForImport('p1', root, 'x');
    const ids = report.findings.map((finding) => finding.id);
    expect(ids).toEqual(expect.arrayContaining(['no-tests', 'no-check-command', 'no-git', 'env-not-ignored', 'no-ci', 'no-readme', 'no-lockfile']));
    expect(report.findings[0]?.severity).toBe('high');
    expect(report.suggestedCheck).toBeNull();
    expect(report.gitAvailable).toBe(false);
    expect(report.findings.every((finding) => finding.card.acceptance.length > 0)).toBe(true);
  });

  it('reports a healthy project with nothing to fix', async () => {
    await put('package.json', JSON.stringify({ name: 'x', scripts: { test: 'vitest', typecheck: 'tsc' } }));
    await put('package-lock.json', '{}');
    await put('README.md', '# x');
    await put('.gitignore', 'node_modules\n.env\n');
    await put('.git/HEAD', 'ref: refs/heads/main');
    await put('.github/workflows/ci.yml', 'on: push');
    await put('src/index.ts', 'export const a = 1;\n');
    await put('test/index.test.ts', 'it("a", () => {});\n');
    const report = await scanForImport('p1', root, 'x');
    expect(report.findings).toEqual([]);
    expect(report.testFileCount).toBe(1);
    expect(report.suggestedCheck).toBe('npm run test');
    expect(report.languages[0]?.name).toBe('TypeScript');
  });

  it('flags a very large source file', async () => {
    await put('package.json', JSON.stringify({ scripts: { test: 'x' } }));
    await put('src/big.ts', 'x'.repeat(90_000));
    const report = await scanForImport('p1', root, 'x');
    expect(report.findings.find((finding) => finding.id === 'large-files')?.files).toEqual(['src/big.ts']);
  });

  it('prefers test, then typecheck, then build as the check', () => {
    expect(suggestCheck(['npm run build', 'npm run typecheck'])).toBe('npm run typecheck');
    expect(suggestCheck(['npm run lint'])).toBe('npm run lint');
    expect(suggestCheck([])).toBeNull();
  });

  it('gives each finding a stable board id', () => {
    expect(importCardId('no-tests')).toBe('import-no-tests');
  });
});
