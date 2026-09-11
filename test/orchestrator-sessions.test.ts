import { describe, expect, it } from 'vitest';
import { createEventId, nowIso, type WorkbenchEvent } from '../src/core/events';
import type { AgentCapability, AgentId } from '../src/core/types';
import type { AgentAdapter, AgentRunRequest } from '../src/adapters/agent-adapter';
import type { Cognitive1Client, Cognitive1Health, CognitiveHandoff, CognitiveRecall, CognitiveSessionStart } from '../src/cognitive1/cognitive1-client';
import { WorkbenchOrchestrator } from '../src/orchestrator/orchestrator';

/** Records the resumeSessionId it was asked to run with, and emits a
 * sessionId of its own each time — mimicking Claude/Codex, whose session
 * id can change across turns even when resuming. */
class SessionTrackingAdapter implements AgentAdapter {
  readonly id: AgentId = 'claude';
  seenResumeIds: Array<string | undefined> = [];
  private counter = 0;

  async getCapability(): Promise<AgentCapability> {
    return {
      id: this.id, displayName: 'Claude', available: true,
      supportsRoutes: ['direct', 'proxy'], supportsAutonomy: ['plan', 'ask', 'autoEdit', 'full', 'custom'],
      supportsTools: true, supportsApprovals: false, supportsDiffs: true, supportsMcp: false, requiredConfigKeys: [],
    };
  }

  async *run(request: AgentRunRequest): AsyncIterable<WorkbenchEvent> {
    this.seenResumeIds.push(request.resumeSessionId);
    this.counter++;
    yield {
      id: createEventId(), type: 'text.delta', taskId: request.taskId, timestamp: nowIso(), agent: this.id,
      channel: 'assistant', text: `reply ${this.counter}`,
    };
    yield {
      id: createEventId(), type: 'cost.update', taskId: request.taskId, timestamp: nowIso(), agent: this.id,
      sessionId: `session-${this.counter}`,
    };
    yield { id: createEventId(), type: 'agent.lifecycle', taskId: request.taskId, timestamp: nowIso(), agent: this.id, status: 'completed', detail: 'done' };
  }

  async stop(): Promise<void> {}
}

describe('WorkbenchOrchestrator multi-turn sessions', () => {
  it('resumes the same agent session on a follow-up message', async () => {
    const adapter = new SessionTrackingAdapter();
    const orchestrator = new WorkbenchOrchestrator({ activeAgent: 'claude', route: 'direct', autonomy: 'ask', isRunning: false });
    orchestrator.registerAdapter(adapter);

    await orchestrator.startTask({ prompt: 'first message' });
    expect(orchestrator.getAgentSessionId('claude')).toBe('session-1');

    await orchestrator.startTask({ prompt: 'second message' });

    expect(adapter.seenResumeIds).toEqual([undefined, 'session-1']);
    expect(orchestrator.getAgentSessionId('claude')).toBe('session-2');
  });

  it('startNewConversation clears remembered sessions', async () => {
    const adapter = new SessionTrackingAdapter();
    const orchestrator = new WorkbenchOrchestrator({ activeAgent: 'claude', route: 'direct', autonomy: 'ask', isRunning: false });
    orchestrator.registerAdapter(adapter);

    await orchestrator.startTask({ prompt: 'first message' });
    orchestrator.startNewConversation();
    expect(orchestrator.getAgentSessionId('claude')).toBeUndefined();

    await orchestrator.startTask({ prompt: 'new conversation message' });
    expect(adapter.seenResumeIds).toEqual([undefined, undefined]);
  });

  it('builds the handoff prompt from the previous agent\'s actual reply, not just the original prompt', async () => {
    const c1: Cognitive1Client = {
      async health(): Promise<Cognitive1Health> { return { available: true, detail: 'ok' }; },
      async sessionStart(_input: CognitiveSessionStart): Promise<string> { return 'ok'; },
      async recall(_input: CognitiveRecall): Promise<string> { return 'ok'; },
      async handoff(_input: CognitiveHandoff): Promise<string> { return 'handoff ok'; },
    };
    const orchestrator = new WorkbenchOrchestrator(
      { activeAgent: 'claude', route: 'direct', autonomy: 'ask', isRunning: false },
      c1,
    );
    const claudeAdapter = new SessionTrackingAdapter();
    orchestrator.registerAdapter(claudeAdapter);

    const codexPrompts: string[] = [];
    const codexAdapter: AgentAdapter = {
      id: 'codex',
      async getCapability(): Promise<AgentCapability> {
        return {
          id: 'codex', displayName: 'Codex', available: true,
          supportsRoutes: ['direct', 'proxy'], supportsAutonomy: ['plan', 'ask', 'autoEdit', 'full', 'custom'],
          supportsTools: true, supportsApprovals: false, supportsDiffs: true, supportsMcp: false, requiredConfigKeys: [],
        };
      },
      async *run(request: AgentRunRequest): AsyncIterable<WorkbenchEvent> {
        codexPrompts.push(request.prompt);
        yield { id: createEventId(), type: 'agent.lifecycle', taskId: request.taskId, timestamp: nowIso(), agent: 'codex', status: 'completed', detail: 'done' };
      },
      async stop() {},
    };
    orchestrator.registerAdapter(codexAdapter);

    const taskPromise = orchestrator.startTask({ prompt: 'investigate the bug' });
    await new Promise((r) => setTimeout(r, 20));
    await orchestrator.handoff('codex');
    await taskPromise;

    expect(codexPrompts).toHaveLength(1);
    expect(codexPrompts[0]).toContain('investigate the bug');
    expect(codexPrompts[0]).toContain("claude's last reply");
    expect(codexPrompts[0]).toContain('reply 1');
  });
});
