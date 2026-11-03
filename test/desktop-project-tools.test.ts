import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DesktopProjectToolRuntime } from '../apps/desktop/src/main/project-tools';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('desktop project tool runtime', () => {
  it('views local images and rejects unsupported files and paths outside the project', async () => {
    const root = await fixtureProject();
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUg==', 'base64');
    await writeFile(path.join(root, 'shot.png'), bytes);
    await writeFile(path.join(root, 'fake.png'), 'not an image');
    const tools = new DesktopProjectToolRuntime(root);
    expect(tools.policy('view_image', 'plan')).toEqual({ decision: 'allow' });
    await expect(tools.execute('view_image', { path: 'shot.png' })).resolves.toMatchObject({ ok: true, output: { content: [{ type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }] } });
    await expect(tools.execute('view_image', { path: 'fake.png' })).resolves.toMatchObject({ ok: false });
    await expect(tools.execute('view_image', { path: '../outside.png' })).resolves.toMatchObject({ ok: false, output: { error: expect.stringContaining('escapes the active project') } });
    await writeFile(path.join(root, 'large.png'), Buffer.alloc(8 * 1024 * 1024 + 1));
    await expect(tools.execute('view_image', { path: 'large.png' })).resolves.toMatchObject({ ok: false, output: { error: expect.stringContaining('limit') } });
  });

  it('reads and searches only inside the project root', async () => {
    const root = await fixtureProject();
    await writeFile(path.join(root, 'src', 'main.ts'), 'export const marker = "needle";\n', 'utf8');
    const tools = new DesktopProjectToolRuntime(root);

    await expect(tools.execute('read_file', { path: 'src/main.ts' })).resolves.toMatchObject({
      ok: true,
      output: expect.objectContaining({ path: 'src/main.ts', totalLines: 2 }),
    });
    await expect(tools.execute('search_files', { query: 'NEEDLE' })).resolves.toMatchObject({
      ok: true,
      output: expect.objectContaining({ matches: [expect.objectContaining({ path: 'src/main.ts', line: 1 })] }),
    });
    await expect(tools.execute('read_file', { path: '../outside.txt' })).resolves.toMatchObject({
      ok: false,
      output: expect.objectContaining({ error: expect.stringContaining('escapes the active project') }),
    });
    await expect(tools.execute('run_command', { command: nodeCommand("process.stdout.write('bad')"), cwd: '..' })).resolves.toMatchObject({
      ok: false,
      output: expect.objectContaining({ error: expect.stringContaining('escapes the active project') }),
    });
  });

  it('rejects malformed edits and follows the configured approval policy', async () => {
    const root = await fixtureProject();
    const filePath = path.join(root, 'package.json');
    await writeFile(filePath, '{"name":"fixture"}\n', 'utf8');
    const tools = new DesktopProjectToolRuntime(root);

    expect(tools.policy('replace_in_file', 'plan')).toMatchObject({ decision: 'deny' });
    expect(tools.policy('replace_in_file', 'ask')).toMatchObject({ decision: 'ask', risk: 'medium' });
    expect(tools.policy('read_file', 'plan')).toEqual({ decision: 'allow' });
    // The plan is the model's own note about where the task has got to — it writes `.kai/plan.json` and no project
    // source, so it is allowed at every level. It used to fall through to the unknown-tool deny, which is why an API
    // run could never record one and the finish signal had nothing to read.
    for (const autonomy of ['plan', 'ask', 'autoEdit', 'full', 'custom'] as const) {
      expect(tools.policy('update_plan', autonomy)).toEqual({ decision: 'allow' });
    }
    await expect(tools.execute('update_plan', {
      items: [{ text: 'Wire the parser', state: 'pending' }],
    })).resolves.toMatchObject({ ok: true });
    const plan = JSON.parse(await readFile(path.join(root, '.kai', 'plan.json'), 'utf8')) as { items: unknown[] };
    expect(plan.items).toEqual([{ text: 'Wire the parser', state: 'pending' }]);
    await expect(tools.execute('replace_in_file', {
      path: 'package.json',
      old_text: '"missing"',
      new_text: '"found"',
    })).resolves.toMatchObject({
      ok: false,
      output: expect.objectContaining({ error: expect.stringContaining('was not found') }),
    });
  });

  it('returns a unified diff with an applied edit so the activity card can open it', async () => {
    const root = await fixtureProject();
    await writeFile(path.join(root, 'src', 'app.ts'), 'const a = 1;\nconst b = 2;\n', 'utf8');
    const tools = new DesktopProjectToolRuntime(root);

    const result = await tools.execute('replace_in_file', {
      path: 'src/app.ts',
      old_text: 'const b = 2;',
      new_text: 'const b = 3;',
    });
    expect(result).toMatchObject({
      ok: true,
      changedFile: {
        path: 'src/app.ts',
        action: 'edited',
        diff: expect.stringContaining('--- a/src/app.ts'),
      },
    });
    const diff = (result as { changedFile?: { diff?: string } }).changedFile?.diff ?? '';
    expect(diff).toContain('-const b = 2;');
    expect(diff).toContain('+const b = 3;');
  });

  it('does not allow a symlink to escape the project boundary', async () => {
    const root = await fixtureProject();
    const outside = await mkdtemp(path.join(tmpdir(), 'kai-project-outside-'));
    temporaryDirectories.push(outside);
    await writeFile(path.join(outside, 'secret.txt'), 'outside secret\n', 'utf8');
    await symlink(outside, path.join(root, 'linked-outside'), 'junction');
    const tools = new DesktopProjectToolRuntime(root);

    await expect(tools.execute('read_file', { path: 'linked-outside/secret.txt' })).resolves.toMatchObject({
      ok: false,
      output: expect.objectContaining({ error: expect.stringContaining('escapes the active project') }),
    });
  });

  it('runs approved commands in the project and reports exit failures', async () => {
    const root = await fixtureProject();
    const tools = new DesktopProjectToolRuntime(root);

    expect(tools.policy('run_command', 'plan')).toMatchObject({ decision: 'deny' });
    expect(tools.policy('run_command', 'ask')).toMatchObject({ decision: 'ask', risk: 'high' });
    expect(tools.policy('run_command', 'autoEdit')).toMatchObject({ decision: 'ask' });
    expect(tools.policy('run_command', 'full')).toEqual({ decision: 'allow' });

    const success = await tools.execute('run_command', {
      command: nodeCommand("process.stdout.write(process.cwd())"),
      cwd: 'src',
    });
    expect(success).toMatchObject({
      ok: true,
      output: expect.objectContaining({ exitCode: 0, stderr: '' }),
    });
    expect(String((success.output as { stdout: string }).stdout).trim()).toMatch(/[\\/]src$/);

    await expect(tools.execute('run_command', {
      command: nodeCommand("process.stderr.write('failed'); process.exit(7)"),
    })).resolves.toMatchObject({
      ok: false,
      output: expect.objectContaining({ exitCode: 7, stderr: 'failed' }),
    });
  });

  it('times out and cancels long-running commands', async () => {
    const root = await fixtureProject();
    const tools = new DesktopProjectToolRuntime(root);

    await expect(tools.execute('run_command', {
      command: nodeCommand('setTimeout(() => {}, 5000)'),
      timeout_ms: 100,
    })).resolves.toMatchObject({
      ok: false,
      output: expect.objectContaining({ timedOut: true, error: expect.stringContaining('timed out') }),
    });

    const controller = new AbortController();
    const pending = tools.execute('run_command', {
      command: nodeCommand('setTimeout(() => {}, 5000)'),
      timeout_ms: 10_000,
    }, controller.signal);
    setTimeout(() => controller.abort(), 100);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      output: expect.objectContaining({ error: 'Command was cancelled.' }),
    });
  });
});

async function fixtureProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'kai-project-tools-'));
  temporaryDirectories.push(root);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(root, 'src'), { recursive: true });
  return root;
}

function nodeCommand(script: string): string {
  return `"${process.execPath}" -e "${script}"`;
}
