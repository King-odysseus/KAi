import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { StubAgentAdapter } from '../src/adapters/stub-adapter';
import type { AgentRunRequest } from '../src/adapters/agent-adapter';
import type { WorkbenchEvent } from '../src/core/events';
import { WorkbenchOrchestrator } from '../src/orchestrator/orchestrator';

const execFileAsync = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

/** A stub adapter that actually edits a file on disk before completing, so
 * checkpoint diffing has something real to find. */
class FileWritingAdapter extends StubAgentAdapter {
  constructor(private readonly repo: string) { super('claude', 'Claude', true); }
  override async *run(request: AgentRunRequest): AsyncIterable<WorkbenchEvent> {
    await fs.writeFile(path.join(this.repo, 'a.ts'), 'export const a = 2;\n');
    yield* super.run(request);
  }
}

describe('WorkbenchOrchestrator checkpoints', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-orch-checkpoint-'));
    await git(repo, ['init', '-q']);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'KAI Test']);
    await fs.writeFile(path.join(repo, 'a.ts'), 'export const a = 1;\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-q', '-m', 'init']);
  });

  afterEach(async () => {
    // Windows can briefly hold a handle open right after a git process exits;
    // retry instead of failing the test over an unrelated cleanup race.
    await fs.rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  /** Waits for a specific event type, since emitTurnChanges is deliberately
   * fire-and-forget (must never block the event stream on a diff). Each git
   * invocation on this machine can take a second or more, so this needs a
   * generous timeout rather than a fixed sleep. */
  function waitForEvent(orchestrator: WorkbenchOrchestrator, type: WorkbenchEvent['type'], timeoutMs = 8000): Promise<WorkbenchEvent | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), timeoutMs);
      orchestrator.on('event', function handler(e: WorkbenchEvent) {
        if (e.type === type) {
          clearTimeout(timer);
          orchestrator.off('event', handler);
          resolve(e);
        }
      });
    });
  }

  it('emits turn.changes for a run that edits a file, and can restore it', async () => {
    const orchestrator = new WorkbenchOrchestrator(
      { activeAgent: 'claude', route: 'direct', autonomy: 'ask', isRunning: false },
      undefined,
      repo,
    );
    orchestrator.registerAdapter(new FileWritingAdapter(repo));

    const changesPromise = waitForEvent(orchestrator, 'turn.changes');
    const taskId = await orchestrator.startTask({ prompt: 'edit a.ts' });
    const changesEvent = await changesPromise;

    expect(changesEvent).toBeDefined();
    if (changesEvent?.type === 'turn.changes') {
      expect(changesEvent.files.map((f) => f.path)).toContain('a.ts');
    }

    expect(orchestrator.getCheckpoint(taskId)).toBeDefined();

    const result = await orchestrator.restoreToCheckpoint(taskId);
    expect(result.restored).toContain('a.ts');
    expect(await fs.readFile(path.join(repo, 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
  }, 15000);

  it('does not emit turn.changes when nothing changed', async () => {
    const orchestrator = new WorkbenchOrchestrator(
      { activeAgent: 'claude', route: 'direct', autonomy: 'ask', isRunning: false },
      undefined,
      repo,
    );
    orchestrator.registerAdapter(new StubAgentAdapter('claude', 'Claude', true));

    // No event will ever come; give ensureCheckpoint/diffFromCheckpoint's git
    // calls (slow on this machine) time to finish before concluding "never".
    const changesPromise = waitForEvent(orchestrator, 'turn.changes', 3000);
    await orchestrator.startTask({ prompt: 'no-op' });

    expect(await changesPromise).toBeUndefined();
  }, 10000);

  it('restoreToCheckpoint throws with no checkpoint (e.g. no workspace folder)', async () => {
    const orchestrator = new WorkbenchOrchestrator(
      { activeAgent: 'claude', route: 'direct', autonomy: 'ask', isRunning: false },
    );
    orchestrator.registerAdapter(new StubAgentAdapter('claude', 'Claude', true));
    await orchestrator.startTask({ prompt: 'hi' });

    await expect(orchestrator.restoreToCheckpoint('does-not-exist')).rejects.toThrow(/No checkpoint/);
  });
});
