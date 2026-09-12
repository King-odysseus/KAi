import { describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentRunRequest } from '../src/adapters/agent-adapter';
import { createEventId, nowIso, type WorkbenchEvent } from '../src/core/events';
import type { AgentCapability } from '../src/core/types';
import { WorkbenchOrchestrator } from '../src/orchestrator/orchestrator';

class CapturingAdapter implements AgentAdapter {
  readonly id = 'codex' as const;
  readonly prompts: string[] = [];

  async getCapability(): Promise<AgentCapability> {
    return {
      id: 'codex', displayName: 'Codex', available: true,
      supportsRoutes: ['direct', 'proxy'], supportsAutonomy: ['plan', 'ask', 'autoEdit', 'full', 'custom'],
      supportsTools: true, supportsApprovals: false, supportsDiffs: true, supportsMcp: true, requiredConfigKeys: [],
    };
  }

  async *run(request: AgentRunRequest): AsyncIterable<WorkbenchEvent> {
    this.prompts.push(request.prompt);
    yield { id: createEventId(), type: 'agent.lifecycle', taskId: request.taskId, timestamp: nowIso(), agent: this.id, status: 'completed', detail: 'done' };
  }

  async stop(): Promise<void> {}
}

class BlockingAdapter implements AgentAdapter {
  readonly id = 'codex' as const;
  readonly prompts: string[] = [];
  stopCalls = 0;
  private release: (() => void) | undefined;
  private readonly stopped = new Promise<void>((resolve) => { this.release = resolve; });

  async getCapability(): Promise<AgentCapability> {
    return {
      id: 'codex', displayName: 'Codex', available: true,
      supportsRoutes: ['direct', 'proxy'], supportsAutonomy: ['plan', 'ask', 'autoEdit', 'full', 'custom'],
      supportsTools: true, supportsApprovals: false, supportsDiffs: true, supportsMcp: true, requiredConfigKeys: [],
    };
  }

  async *run(request: AgentRunRequest): AsyncIterable<WorkbenchEvent> {
    this.prompts.push(request.prompt);
    await this.stopped;
    yield { id: createEventId(), type: 'agent.lifecycle', taskId: request.taskId, timestamp: nowIso(), agent: this.id, status: 'paused', detail: 'stopped' };
  }

  async stop(): Promise<void> {
    this.stopCalls++;
    this.release?.();
  }
}

describe('WorkbenchOrchestrator goals', () => {
  it('injects the goal contract into the first and subsequent turns', async () => {
    const adapter = new CapturingAdapter();
    const orchestrator = new WorkbenchOrchestrator({ activeAgent: 'codex', route: 'direct', autonomy: 'ask', isRunning: false });
    orchestrator.registerAdapter(adapter);

    await orchestrator.startTask({
      prompt: 'Implement the feature.',
      goal: { outcome: 'Ship the feature', constraints: 'Keep the API stable', verification: 'Tests pass' },
    });
    await orchestrator.startTask({ prompt: 'What remains?' });

    expect(orchestrator.getGoal()?.status).toBe('running');
    expect(adapter.prompts).toHaveLength(2);
    expect(adapter.prompts[0]).toContain('Outcome: Ship the feature');
    expect(adapter.prompts[1]).toContain('Definition of done: Tests pass');
    expect(adapter.prompts[1]).toContain('What remains?');
  });

  it('pauses and resumes a goal across turns', async () => {
    const adapter = new CapturingAdapter();
    const orchestrator = new WorkbenchOrchestrator({ activeAgent: 'codex', route: 'direct', autonomy: 'ask', isRunning: false });
    orchestrator.registerAdapter(adapter);
    orchestrator.setGoal({ outcome: 'Finish the migration' });

    await orchestrator.pauseGoal();
    expect(orchestrator.getGoal()?.status).toBe('paused');

    await orchestrator.resumeGoal();
    expect(orchestrator.getGoal()?.status).toBe('running');
    expect(adapter.prompts).toHaveLength(1);
    expect(adapter.prompts[0]).toContain('Outcome: Finish the migration');
  });

  it('does not inject a paused goal into an ordinary message', async () => {
    const adapter = new CapturingAdapter();
    const orchestrator = new WorkbenchOrchestrator({ activeAgent: 'codex', route: 'direct', autonomy: 'ask', isRunning: false });
    orchestrator.registerAdapter(adapter);
    orchestrator.setGoal({ outcome: 'Finish the migration' });
    await orchestrator.pauseGoal();

    await orchestrator.startTask({ prompt: 'Unrelated side question' });

    expect(adapter.prompts).toHaveLength(1);
    expect(adapter.prompts[0]).toBe('Unrelated side question');
  });

  it('stops active work when the goal is completed or cleared', async () => {
    for (const action of ['complete', 'clear'] as const) {
      const adapter = new BlockingAdapter();
      const orchestrator = new WorkbenchOrchestrator({ activeAgent: 'codex', route: 'direct', autonomy: 'ask', isRunning: false });
      orchestrator.registerAdapter(adapter);
      const run = orchestrator.startTask({ prompt: 'Long task', goal: { outcome: `Goal ${action}` } });
      await new Promise((resolve) => setTimeout(resolve, 0));

      if (action === 'complete') await orchestrator.completeGoal();
      else await orchestrator.clearGoal();
      await run;

      expect(adapter.stopCalls).toBe(1);
      expect(orchestrator.getState().isRunning).toBe(false);
    }
  });

  it('clears goal state with a new conversation', async () => {
    const orchestrator = new WorkbenchOrchestrator({ activeAgent: 'codex', route: 'direct', autonomy: 'ask', isRunning: false });
    orchestrator.setGoal({ outcome: 'Old work' });
    orchestrator.startNewConversation();
    expect(orchestrator.getGoal()).toBeNull();
  });
});
