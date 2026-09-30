import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopEvals, EvalStore, type EvalPorts } from '../apps/desktop/src/main/evals';

vi.setConfig({ testTimeout: 120_000 });

const execFileAsync = promisify(execFile);
const git = async (cwd: string, args: string[]): Promise<string> => (await execFileAsync('git', args, { cwd })).stdout;

describe('desktop evals', () => {
  let repo: string;
  let data: string;
  let cwds: string[];

  beforeEach(async () => {
    repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'kai-eval-repo-')));
    data = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-eval-data-'));
    cwds = [];
    await git(repo, ['init', '-q']);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'KAI Test']);
    await fs.writeFile(path.join(repo, 'value.txt'), 'broken\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-q', '-m', 'init']);
  });

  afterEach(async () => {
    await git(repo, ['worktree', 'prune']).catch(() => undefined);
    await fs.rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    await fs.rm(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  function evals(agentBehaviour: (cwd: string) => Promise<void>): DesktopEvals {
    const ports: EvalPorts = {
      project: async (id) => ({ id, name: 'demo', path: repo }),
      createConversation: async () => 'conv_eval',
      runAgent: async (_request, cwd) => {
        cwds.push(cwd);
        await agentBehaviour(cwd);
        return { conversation: {} as never, status: 'completed', output: 'done', costUsd: 0.25 };
      },
      // The check passes when the file says "fixed".
      runCheck: async (cwd) => {
        const text = await fs.readFile(path.join(cwd, 'value.txt'), 'utf8');
        return { exitCode: text.trim() === 'fixed' ? 0 : 1, output: `value is ${text.trim()}` };
      },
    };
    return new DesktopEvals(new EvalStore(data), ports);
  }

  it('saves a case from the current commit and lists it', async () => {
    const runner = evals(async () => undefined);
    const head = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    const saved = await runner.saveCase({ projectId: 'p1', name: 'Fix value', prompt: 'make value.txt say fixed', check: 'node check.js' });
    expect(saved.baseRef).toBe(head);
    expect((await runner.overview('p1')).cases.map((item) => item.name)).toEqual(['Fix value']);
  });

  it('runs the task in a disposable copy and judges it by the check, leaving the project untouched', async () => {
    const runner = evals(async (cwd) => { await fs.writeFile(path.join(cwd, 'value.txt'), 'fixed\n'); });
    const saved = await runner.saveCase({ projectId: 'p1', name: 'Fix value', prompt: 'p', check: 'c' });

    const result = await runner.run({ caseId: saved.id, projectId: 'p1', agent: 'claude', execution: 'cli', route: 'direct', model: 'sonnet' });

    expect(result).toMatchObject({ passed: true, agentCompleted: true, checkExitCode: 0, filesChanged: 1, costUsd: 0.25, agent: 'claude', model: 'sonnet' });
    expect(cwds[0]).not.toBe(repo);
    expect(await fs.readFile(path.join(repo, 'value.txt'), 'utf8')).toBe('broken\n');
    await expect(fs.access(cwds[0]!)).rejects.toThrow();
    expect((await git(repo, ['worktree', 'list'])).trim().split('\n')).toHaveLength(1);
    expect((await runner.overview('p1')).results).toHaveLength(1);
  });

  it('records a failing attempt and an agent that throws', async () => {
    const lazy = evals(async () => undefined);
    const saved = await lazy.saveCase({ projectId: 'p1', name: 'Fix value', prompt: 'p', check: 'c' });
    const failed = await lazy.run({ caseId: saved.id, projectId: 'p1', agent: 'codex', execution: 'cli', route: 'direct' });
    expect(failed).toMatchObject({ passed: false, agentCompleted: true, checkExitCode: 1, filesChanged: 0 });

    const crashing = evals(async () => { throw new Error('agent crashed'); });
    const crashed = await crashing.run({ caseId: saved.id, projectId: 'p1', agent: 'codex', execution: 'cli', route: 'direct' });
    expect(crashed).toMatchObject({ passed: false, agentCompleted: false, error: 'agent crashed' });
    expect((await crashing.overview('p1')).results).toHaveLength(2);
  });

  it('starts every run from the saved commit, not from later work', async () => {
    const runner = evals(async () => undefined);
    const saved = await runner.saveCase({ projectId: 'p1', name: 'Base', prompt: 'p', check: 'c' });
    await fs.writeFile(path.join(repo, 'value.txt'), 'fixed\n');
    await git(repo, ['commit', '-qam', 'later work']);

    const result = await runner.run({ caseId: saved.id, projectId: 'p1', agent: 'claude', execution: 'cli', route: 'direct' });
    expect(result.passed).toBe(false);
    expect(result.outputTail).toContain('value is broken');
  });

  it('deletes a case together with its results', async () => {
    const runner = evals(async () => undefined);
    const saved = await runner.saveCase({ projectId: 'p1', name: 'Gone', prompt: 'p', check: 'c' });
    await runner.run({ caseId: saved.id, projectId: 'p1', agent: 'claude', execution: 'cli', route: 'direct' });
    expect(await runner.deleteCase('p1', saved.id)).toBe(true);
    expect(await runner.overview('p1')).toEqual({ cases: [], results: [] });
    expect(await runner.deleteCase('p1', saved.id)).toBe(false);
  });
});
