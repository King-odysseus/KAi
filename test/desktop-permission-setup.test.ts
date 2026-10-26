import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { suggestPermissionRules } from '../apps/desktop/src/main/permission-setup';

const directories: string[] = [];

async function project(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-permission-setup-'));
  directories.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })));
});

describe('suggesting permission rules', () => {
  it('finds nothing in a folder with no recognizable project', async () => {
    const dir = await project({ 'notes.txt': 'hello' });
    expect(await suggestPermissionRules(dir)).toEqual([]);
  });

  it('proposes allow rules for an npm project\'s own test, lint and build scripts', async () => {
    const dir = await project({
      'package.json': JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .', build: 'tsc', start: 'node server.js', deploy: 'wrangler deploy' } }),
    });
    const rules = await suggestPermissionRules(dir);
    const commands = rules.map((rule) => rule.commands[0]);
    expect(commands).toEqual(['npm test', 'npm run lint', 'npm run build']);
    // Nothing that starts a server or leaves the machine is ever suggested.
    expect(commands.join(' ')).not.toMatch(/start|deploy/);
    expect(rules.every((rule) => rule.effect === 'allow')).toBe(true);
  });

  it('uses yarn or pnpm\'s own command forms when their lockfile is present', async () => {
    const yarn = await project({ 'package.json': JSON.stringify({ scripts: { test: 'jest' } }), 'yarn.lock': '' });
    expect((await suggestPermissionRules(yarn))[0]?.commands).toEqual(['yarn test']);
    const pnpm = await project({ 'package.json': JSON.stringify({ scripts: { test: 'jest' } }), 'pnpm-lock.yaml': '' });
    expect((await suggestPermissionRules(pnpm))[0]?.commands).toEqual(['pnpm run test']);
  });

  it('skips a package.json it cannot parse rather than failing', async () => {
    const dir = await project({ 'package.json': '{ not json' });
    expect(await suggestPermissionRules(dir)).toEqual([]);
  });

  it('proposes rules for a Rust, Go, Python or Makefile project', async () => {
    const rust = await project({ 'Cargo.toml': '[package]\nname = "x"\n' });
    expect((await suggestPermissionRules(rust)).map((rule) => rule.commands[0])).toEqual(['cargo test', 'cargo build', 'cargo clippy', 'cargo fmt --check']);

    const go = await project({ 'go.mod': 'module x\n' });
    expect((await suggestPermissionRules(go)).map((rule) => rule.commands[0])).toEqual(['go test', 'go build', 'go vet']);

    const py = await project({ 'pyproject.toml': '[project]\nname = "x"\n' });
    expect((await suggestPermissionRules(py)).map((rule) => rule.commands[0])).toEqual(['pytest', 'python -m pytest']);

    const make = await project({ Makefile: 'test:\n\tpytest\n\nbuild:\n\tdocker build .\n\ndeploy:\n\tdoit\n' });
    expect((await suggestPermissionRules(make)).map((rule) => rule.commands[0])).toEqual(['make test', 'make build']);
  });

  it('never duplicates a command that more than one source would suggest', async () => {
    const dir = await project({
      'package.json': JSON.stringify({ scripts: { test: 'jest' } }),
      Makefile: 'test:\n\tnpm test\n',
    });
    const rules = await suggestPermissionRules(dir);
    expect(rules.filter((rule) => rule.commands[0] === 'npm test')).toHaveLength(1);
  });

  it('gives every suggestion a stable, readable id and a note explaining it', async () => {
    const dir = await project({ 'package.json': JSON.stringify({ scripts: { test: 'jest' } }) });
    const [rule] = await suggestPermissionRules(dir);
    expect(rule).toMatchObject({ id: 'suggested-npm-test', tools: [], paths: [] });
    expect(rule!.note).toMatch(/test/i);
  });
});
