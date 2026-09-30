import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProjectContext } from '../apps/desktop/src/main/context-builder';
import { buildRepoMap, extractSymbols, invalidateRepoMap } from '../apps/desktop/src/main/repo-map';

describe('repo map', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'kai-map-'));
    invalidateRepoMap();
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true });
    await writeFile(path.join(root, 'src', 'app.ts'), 'export function start() {}\nexport class Server {}\nexport const PORT = 1;\nfunction helper() {}\nconst hidden = 1;\n');
    await writeFile(path.join(root, 'src', 'tools.py'), 'def run():\n    pass\n\ndef _private():\n    pass\n\nclass Tool:\n    def method(self):\n        pass\n');
    await writeFile(path.join(root, 'node_modules', 'dep', 'index.js'), 'export function ignored() {}\n');
    await writeFile(path.join(root, 'README.md'), '# not source\n');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('extracts top-level declarations per language', () => {
    expect(extractSymbols('a.ts', 'export function a() {}\nexport default class B {}\nexport type C = 1;\nconst d = 1;\n  export const nested = 1;\n')).toEqual(['a', 'B', 'C']);
    expect(extractSymbols('a.py', 'def a():\n  def inner():\n    pass\nclass B:\n  pass\ndef _c():\n  pass\n')).toEqual(['a', 'B']);
    expect(extractSymbols('a.go', 'func Public() {}\nfunc private() {}\nfunc (s *S) Method() {}\ntype T struct{}\n')).toEqual(['Public', 'Method', 'T']);
    expect(extractSymbols('a.rs', 'pub fn a() {}\nfn b() {}\npub struct C;\n')).toEqual(['a', 'C']);
    expect(extractSymbols('notes.md', '# heading')).toEqual([]);
  });

  it('outlines source files, skipping dependencies and non-source files', async () => {
    const map = await buildRepoMap(root);
    expect(map).not.toBeNull();
    expect(map!.text).toContain('src/app.ts: start, Server, PORT, helper');
    expect(map!.text).toContain('src/tools.py: run, Tool');
    expect(map!.text).not.toContain('node_modules');
    expect(map!.text).not.toContain('README');
    expect(map!.files).toBe(2);
    expect(map!.truncated).toBe(false);
  });

  it('shortens symbol lists, then drops files, to stay within the budget', async () => {
    for (let index = 0; index < 60; index += 1) {
      await writeFile(path.join(root, 'src', `module-${String(index).padStart(2, '0')}.ts`), `export const value${index} = ${index};\n`);
    }
    invalidateRepoMap(root);
    const map = await buildRepoMap(root, { maxCharacters: 700 });
    expect(map!.text.length).toBeLessThan(900);
    expect(map!.truncated).toBe(true);
    expect(map!.text).toContain('omitted');
  });

  it('returns null for a folder with no source files', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'kai-map-empty-'));
    try {
      await writeFile(path.join(empty, 'notes.txt'), 'hello');
      expect(await buildRepoMap(empty)).toBeNull();
    } finally {
      await rm(empty, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  it('adds the map to the project context only when asked', async () => {
    const without = await buildProjectContext(root);
    expect(without.text).not.toContain('Repository map');
    const withMap = await buildProjectContext(root, { includeRepoMap: true });
    expect(withMap.text).toContain('## Repository map');
    expect(withMap.text).toContain('src/app.ts');
    expect(withMap.preview.sections.find((section) => section.kind === 'map')?.items).toHaveLength(1);
  });
});
