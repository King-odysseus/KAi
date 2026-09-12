import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createEventId, nowIso, type WorkbenchEvent } from '../src/core/events';
import type { AgentCapability, AgentId } from '../src/core/types';
import type { AgentAdapter, AgentRunRequest } from '../src/adapters/agent-adapter';
import { WorkbenchOrchestrator } from '../src/orchestrator/orchestrator';

const execFileAsync = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

/** Writes a distinct file into whatever cwd it's given — the worktree
 * directory the orchestrator hands it, not the real repo. */
class WritesToCwdAdapter implements AgentAdapter {
  constructor(readonly id: AgentId, private readonly fileName: string, private readonly content: string) {}

  async getCapability(): Promise<AgentCapability> {
    return {
      id: this.id, displayName: this.id, available: true,
      supportsRoutes: ['direct', 'proxy'], supportsAutonomy: ['plan', 'ask', 'autoEdit', 'full', 'custom'],
      supportsTools: true, supportsApprovals: false, supportsDiffs: true, supportsMcp: false, requiredConfigKeys: [],
    };
  }

  async *run(request: AgentRunRequest): AsyncIterable<WorkbenchEvent> {
    if (!request.cwd) throw new Error('expected a cwd (the compare worktree)');
    await fs.writeFile(path.join(request.cwd, this.fileName), this.content);
    yield { id: createEventId(), type: 'agent.lifecycle', taskId: request.taskId, timestamp: nowIso(), agent: this.id, status: 'completed', detail: 'done' };
  }

  async stop(): Promise<void> {}
}

describe('WorkbenchOrchestrator compareTask', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-orch-compare-'));
    await git(repo, ['init', '-q']);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'KAI Test']);
    await fs.writeFile(path.join(repo, 'a.ts'), 'export const a = 1;\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-q', '-m', 'init']);
  }, 15000);

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('runs each side in its own worktree and never touches the real repo before a winner is picked', async () => {
    const orchestrator = new WorkbenchOrchestrator(
      { activeAgent: 'claude', route: 'direct', autonomy: 'ask', isRunning: false },
      undefined, repo,
    );
    orchestrator.registerAdapter(new WritesToCwdAdapter('claude', 'from-claude.ts', 'export const claude = true;\n'));
    orchestrator.registerAdapter(new WritesToCwdAdapter('codex', 'from-codex.ts', 'export const codex = true;\n'));
    const compareAgents: Array<{ side?: string; agent?: AgentId }> = [];
    orchestrator.on('event', (event: WorkbenchEvent & { side?: string; agent?: AgentId }) => {
      if (event.taskId.startsWith('compare_') && event.side) compareAgents.push({ side: event.side, agent: event.agent });
    });

    const compareId = await orchestrator.compareTask('add a file', 'claude', 'codex');

    expect(compareAgents.sort((a, b) => (a.side ?? '').localeCompare(b.side ?? ''))).toEqual([
      { side: 'left', agent: 'claude' },
      { side: 'right', agent: 'codex' },
    ]);

    // Neither side's file exists in the real repo yet.
    await expect(fs.access(path.join(repo, 'from-claude.ts'))).rejects.toThrow();
    await expect(fs.access(path.join(repo, 'from-codex.ts'))).rejects.toThrow();

    const leftPath = orchestrator.getCompareWorktreePath(compareId, 'left');
    const rightPath = orchestrator.getCompareWorktreePath(compareId, 'right');
    expect(leftPath).toBeDefined();
    expect(rightPath).toBeDefined();
    expect(await fs.readFile(path.join(leftPath!, 'from-claude.ts'), 'utf8')).toBe('export const claude = true;\n');
    expect(await fs.readFile(path.join(rightPath!, 'from-codex.ts'), 'utf8')).toBe('export const codex = true;\n');
    // Each side never sees the other's file.
    await expect(fs.access(path.join(leftPath!, 'from-codex.ts'))).rejects.toThrow();

    await orchestrator.pickCompareWinner(compareId, 'left');

    expect(await fs.readFile(path.join(repo, 'from-claude.ts'), 'utf8')).toBe('export const claude = true;\n');
    await expect(fs.access(path.join(repo, 'from-codex.ts'))).rejects.toThrow();

    // Both worktrees are cleaned up after picking.
    expect(await fs.access(leftPath!).then(() => true, () => false)).toBe(false);
    expect(await fs.access(rightPath!).then(() => true, () => false)).toBe(false);
  }, 30000);

  it('discardCompare removes both worktrees without applying either', async () => {
    const orchestrator = new WorkbenchOrchestrator(
      { activeAgent: 'claude', route: 'direct', autonomy: 'ask', isRunning: false },
      undefined, repo,
    );
    orchestrator.registerAdapter(new WritesToCwdAdapter('claude', 'from-claude.ts', 'x'));
    orchestrator.registerAdapter(new WritesToCwdAdapter('codex', 'from-codex.ts', 'x'));

    const compareId = await orchestrator.compareTask('add a file', 'claude', 'codex');
    const leftPath = orchestrator.getCompareWorktreePath(compareId, 'left')!;

    await orchestrator.discardCompare(compareId);

    expect(await fs.access(leftPath).then(() => true, () => false)).toBe(false);
    await expect(fs.access(path.join(repo, 'from-claude.ts'))).rejects.toThrow();
    await expect(orchestrator.pickCompareWinner(compareId, 'left')).rejects.toThrow(/No active compare run/);
  }, 30000);

  it('rejects compareTask outside a git repository', async () => {
    const plainDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-not-a-repo-'));
    try {
      const orchestrator = new WorkbenchOrchestrator(
        { activeAgent: 'claude', route: 'direct', autonomy: 'ask', isRunning: false },
        undefined, plainDir,
      );
      orchestrator.registerAdapter(new WritesToCwdAdapter('claude', 'x.ts', 'x'));
      orchestrator.registerAdapter(new WritesToCwdAdapter('codex', 'y.ts', 'y'));
      await expect(orchestrator.compareTask('go', 'claude', 'codex')).rejects.toThrow(/git repository/);
    } finally {
      await fs.rm(plainDir, { recursive: true, force: true });
    }
  });
});
