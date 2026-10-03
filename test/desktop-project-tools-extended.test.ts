import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DesktopProjectToolRuntime, backgroundServerOptions, globToRegExp, projectToolDefinitions } from '../apps/desktop/src/main/project-tools';
import { runCheckCommand } from '../apps/desktop/src/main/verification';

describe('extended project tools', () => {
  let root: string;
  let runtime: DesktopProjectToolRuntime;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'kai-tools-'));
    await mkdir(path.join(root, 'src', 'deep'), { recursive: true });
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(root, 'src', 'a.ts'), 'export const alpha = 1;\nexport const beta = 2;\n');
    await writeFile(path.join(root, 'src', 'deep', 'b.ts'), 'export const gamma = 3;\n');
    await writeFile(path.join(root, 'readme.md'), '# hello\n');
    await writeFile(path.join(root, 'node_modules', 'pkg', 'x.ts'), 'export const ignored = 1;\n');
    runtime = new DesktopProjectToolRuntime(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('offers every new tool to the model', () => {
    const names = projectToolDefinitions.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['list_files', 'multi_edit', 'write_file', 'move_file', 'delete_file']));
  });

  it('lists files by glob and skips ignored folders', async () => {
    const result = await runtime.execute('list_files', { pattern: 'src/**/*.ts' });
    expect(result.output).toMatchObject({ files: ['src/a.ts', 'src/deep/b.ts'], total: 2 });
    const bare = await runtime.execute('list_files', { pattern: '*.ts' });
    expect((bare.output as { files: string[] }).files).toEqual(['src/a.ts', 'src/deep/b.ts']);
    const everything = await runtime.execute('list_files', {});
    expect((everything.output as { files: string[] }).files).not.toContain('node_modules/pkg/x.ts');
  });

  it('searches with a regex and a glob filter', async () => {
    const result = await runtime.execute('search_files', { query: 'const (alpha|gamma)', regex: true, glob: 'src/**/*.ts' });
    const matches = (result.output as { matches: Array<{ path: string; line: number }> }).matches;
    expect(matches.map((match) => `${match.path}:${match.line}`)).toEqual(['src/a.ts:1', 'src/deep/b.ts:1']);
    const invalid = await runtime.execute('search_files', { query: '(', regex: true });
    expect(invalid.ok).toBe(false);
  });

  it('applies every edit in a multi_edit or none of them', async () => {
    const ok = await runtime.execute('multi_edit', {
      path: 'src/a.ts',
      edits: [
        { old_text: 'alpha = 1', new_text: 'alpha = 10' },
        { old_text: 'beta = 2', new_text: 'beta = 20' },
      ],
    });
    expect(ok.ok).toBe(true);
    expect(await readFile(path.join(root, 'src', 'a.ts'), 'utf8')).toBe('export const alpha = 10;\nexport const beta = 20;\n');

    const failed = await runtime.execute('multi_edit', {
      path: 'src/a.ts',
      edits: [
        { old_text: 'alpha = 10', new_text: 'alpha = 99' },
        { old_text: 'does not exist', new_text: 'x' },
      ],
    });
    expect(failed.ok).toBe(false);
    expect(await readFile(path.join(root, 'src', 'a.ts'), 'utf8')).toBe('export const alpha = 10;\nexport const beta = 20;\n');
  });

  it('inserts replacement text literally, including dollar patterns', async () => {
    await runtime.execute('multi_edit', { path: 'readme.md', edits: [{ old_text: 'hello', new_text: 'costs $& and $1' }] });
    expect(await readFile(path.join(root, 'readme.md'), 'utf8')).toBe('# costs $& and $1\n');
    await runtime.execute('replace_in_file', { path: 'readme.md', old_text: 'costs', new_text: '$$' });
    expect(await readFile(path.join(root, 'readme.md'), 'utf8')).toBe('# $$ $& and $1\n');
  });

  it('writes, moves and deletes files inside the project only', async () => {
    const created = await runtime.execute('write_file', { path: 'new/dir/c.ts', content: 'export {};\n' });
    expect(created.changedFile?.action).toBe('created');
    const rewritten = await runtime.execute('write_file', { path: 'new/dir/c.ts', content: 'export const c = 1;\n' });
    expect(rewritten.changedFile?.action).toBe('edited');

    expect((await runtime.execute('move_file', { from: 'new/dir/c.ts', to: 'moved/c.ts' })).ok).toBe(true);
    expect((await runtime.execute('move_file', { from: 'moved/c.ts', to: 'readme.md' })).ok).toBe(false);
    expect((await runtime.execute('delete_file', { path: 'moved/c.ts' })).ok).toBe(true);
    await expect(stat(path.join(root, 'moved', 'c.ts'))).rejects.toThrow();

    expect((await runtime.execute('delete_file', { path: 'src' })).ok).toBe(false);
    expect((await runtime.execute('write_file', { path: '../escape.txt', content: 'x' })).ok).toBe(false);
    expect((await runtime.execute('delete_file', { path: '../readme.md' })).ok).toBe(false);
  });

  it('asks before deleting unless the run has Full access', () => {
    expect(runtime.policy('delete_file', 'autoEdit').decision).toBe('ask');
    expect(runtime.policy('delete_file', 'full').decision).toBe('allow');
    expect(runtime.policy('write_file', 'autoEdit').decision).toBe('allow');
    expect(runtime.policy('write_file', 'plan').decision).toBe('deny');
    expect(runtime.policy('list_files', 'plan').decision).toBe('allow');
  });

  it('offers ask_user and explore, and always allows them regardless of autonomy', () => {
    const names = projectToolDefinitions.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['ask_user', 'explore']));
    for (const autonomy of ['plan', 'ask', 'autoEdit', 'full', 'custom'] as const) {
      expect(runtime.policy('ask_user', autonomy).decision).toBe('allow');
      expect(runtime.policy('explore', autonomy).decision).toBe('allow');
    }
  });

  it('refuses ask_user and explore if called directly, since the run loop must intercept them first', async () => {
    const askUser = await runtime.execute('ask_user', { question: 'Continue?', options: ['Yes', 'No'] });
    expect(askUser.ok).toBe(false);
    expect(String((askUser.output as { error?: string }).error)).toContain('must be handled by the run loop');
    const explore = await runtime.execute('explore', { question: 'How does X work?' });
    expect(explore.ok).toBe(false);
    expect(String((explore.output as { error?: string }).error)).toContain('must be handled by the run loop');
  });

  it('turns globs into path matchers', () => {
    expect(globToRegExp('src/**/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/x/y/a.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/x/a.ts')).toBe(false);
    expect(globToRegExp('*.md').test('docs/readme.md')).toBe(true);
    expect(globToRegExp('a?.ts').test('ab.ts')).toBe(true);
    expect(globToRegExp('a.ts').test('aXts')).toBe(false);
  });
});

describe('commands that leave a background process behind', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'kai-bg-'));
    // Starts a detached process that keeps holding this command's output pipes for a while, like `start /b npm run dev`.
    await writeFile(
      path.join(root, 'spawner.cjs'),
      [
        "const { spawn } = require('node:child_process');",
        "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }).unref();",
        "console.log('server started');",
      ].join(String.fromCharCode(10)),
    );
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('returns once the command has exited instead of waiting for the background process', async () => {
    const runtime = new DesktopProjectToolRuntime(root);
    const startedAt = Date.now();
    const result = await runtime.execute('run_command', { command: `"${process.execPath}" spawner.cjs` });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(result.ok).toBe(true);
    expect((result.output as { stdout: string }).stdout).toContain('server started');
  });

  it('never detaches the dev server on Windows, where detaching would open a console anyway', () => {
    // A detached child on Windows gets its own console, and CREATE_NO_WINDOW — what windowsHide sets — is ignored
    // while DETACHED_PROCESS is set. So the old options opened a bare console with the server's output in it.
    expect(backgroundServerOptions('win32')).toEqual({
      shell: true,
      windowsHide: true,
      detached: false,
      stdio: 'ignore',
    });
    // Detaching is what lets the server outlive KAI on the platforms where it costs nothing.
    expect(backgroundServerOptions('linux')).toMatchObject({ detached: true, windowsHide: true, stdio: 'ignore' });
    expect(backgroundServerOptions('darwin')).toMatchObject({ detached: true });
  });

  it('does the same for a check command', async () => {
    const startedAt = Date.now();
    const check = await runCheckCommand(root, `"${process.execPath}" spawner.cjs`);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(check.exitCode).toBe(0);
    expect(check.output).toContain('server started');
  });
});
