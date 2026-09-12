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

/** Records the prompt it was asked to run with, so switch-context tests can
 * assert what a newly selected provider actually received. */
class PromptTrackingAdapter implements AgentAdapter {
  readonly seenResumeIds: Array<string | undefined> = [];
  readonly seenPrompts: string[] = [];
  private counter = 0;

  constructor(readonly id: AgentId) {}

  async getCapability(): Promise<AgentCapability> {
    return {
      id: this.id, displayName: this.id, available: true,
      supportsRoutes: ['direct', 'proxy'], supportsAutonomy: ['plan', 'ask', 'autoEdit', 'full', 'custom'],
      supportsTools: true, supportsApprovals: false, supportsDiffs: true, supportsMcp: false, requiredConfigKeys: [],
    };
  }

  async *run(request: AgentRunRequest): AsyncIterable<WorkbenchEvent> {
    this.seenResumeIds.push(request.resumeSessionId);
    this.seenPrompts.push(request.prompt);
    this.counter++;
    yield {
      id: createEventId(), type: 'text.delta', taskId: request.taskId, timestamp: nowIso(), agent: this.id,
      channel: 'assistant', text: `${this.id} reply ${this.counter}`,
    };
    yield {
      id: createEventId(), type: 'cost.update', taskId: request.taskId, timestamp: nowIso(), agent: this.id,
      sessionId: `${this.id}-session-${this.counter}`,
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

  it('snapshots and restores sessions for the same route and workspace', async () => {
    const adapter = new SessionTrackingAdapter();
    const orchestrator = new WorkbenchOrchestrator(
      { activeAgent: 'claude', route: 'direct', autonomy: 'ask', isRunning: false },
      undefined,
      '/workspace/kai',
    );
    orchestrator.registerAdapter(adapter);

    await orchestrator.startTask({ prompt: 'first message' });
    const snapshot = orchestrator.getAgentSessions();
    expect(snapshot.claude).toEqual({ sessionId: 'session-1', route: 'direct', projectPath: '/workspace/kai' });

    orchestrator.startNewConversation();
    orchestrator.restoreAgentSessions(snapshot);
    expect(orchestrator.getAgentSessionId('claude')).toBe('session-1');

    await orchestrator.startTask({ prompt: 'second message' });
    expect(adapter.seenResumeIds).toEqual([undefined, 'session-1']);
  });

  it('does not restore a session from a different route or workspace', () => {
    const orchestrator = new WorkbenchOrchestrator(
      { activeAgent: 'claude', route: 'proxy', autonomy: 'ask', isRunning: false },
      undefined,
      '/workspace/kai',
    );

    orchestrator.restoreAgentSessions({
      claude: { sessionId: 'direct-session', route: 'direct', projectPath: '/workspace/kai' },
      codex: { sessionId: 'other-workspace', route: 'proxy', projectPath: '/workspace/other' },
    });

    expect(orchestrator.getAgentSessionId('claude')).toBeUndefined();
    expect(orchestrator.getAgentSessionId('codex')).toBeUndefined();
  });

  it('records the route each agent actually ran with', async () => {
    const adapter = new SessionTrackingAdapter();
    const orchestrator = new WorkbenchOrchestrator(
      { activeAgent: 'claude', route: 'direct', autonomy: 'ask', isRunning: false },
      undefined,
      '/workspace/kai',
    );
    orchestrator.registerAdapter(adapter);

    await orchestrator.startTask({ prompt: 'direct turn', route: 'direct' });
    await orchestrator.startTask({ prompt: 'proxy turn', route: 'proxy' });

    const sessions = orchestrator.getAgentSessions();
    expect(sessions.claude).toEqual({ sessionId: 'session-2', route: 'proxy', projectPath: '/workspace/kai' });
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

  it('carries the conversation transcript to a newly selected agent, then resumes that agent natively', async () => {
    const orchestrator = new WorkbenchOrchestrator({ activeAgent: 'claude', route: 'direct', autonomy: 'ask', isRunning: false });
    const claude = new PromptTrackingAdapter('claude');
    const codex = new PromptTrackingAdapter('codex');
    orchestrator.registerAdapter(claude);
    orchestrator.registerAdapter(codex);

    await orchestrator.startTask({ prompt: 'what file are we fixing?' });
    await orchestrator.startTask({ prompt: 'continue with the tests', agent: 'codex' });

    expect(codex.seenResumeIds).toEqual([undefined]);
    expect(codex.seenPrompts[0]).toContain('Conversation history from earlier turns');
    expect(codex.seenPrompts[0]).toContain('User: what file are we fixing?');
    expect(codex.seenPrompts[0]).toContain('Assistant: claude reply 1');
    expect(codex.seenPrompts[0]).toContain('continue with the tests');

    await orchestrator.startTask({ prompt: 'one more detail', agent: 'codex' });

    expect(codex.seenResumeIds).toEqual([undefined, 'codex-session-1']);
    expect(codex.seenPrompts[1]).toBe('one more detail');
  });

  it('does not inject transcript history into an agent that already has a native session', async () => {
    const orchestrator = new WorkbenchOrchestrator({ activeAgent: 'codex', route: 'direct', autonomy: 'ask', isRunning: false });
    const codex = new PromptTrackingAdapter('codex');
    orchestrator.registerAdapter(codex);

    await orchestrator.startTask({ prompt: 'first' });
    await orchestrator.startTask({ prompt: 'second' });

    expect(codex.seenPrompts).toEqual(['first', 'second']);
  });

  it('does not carry an old conversation transcript into a new conversation', async () => {
    const orchestrator = new WorkbenchOrchestrator({ activeAgent: 'claude', route: 'direct', autonomy: 'ask', isRunning: false });
    const claude = new PromptTrackingAdapter('claude');
    const codex = new PromptTrackingAdapter('codex');
    orchestrator.registerAdapter(claude);
    orchestrator.registerAdapter(codex);

    await orchestrator.startTask({ prompt: 'old conversation' });
    orchestrator.startNewConversation();
    await orchestrator.startTask({ prompt: 'new conversation', agent: 'codex' });

    expect(codex.seenResumeIds).toEqual([undefined]);
    expect(codex.seenPrompts[0]).toBe('new conversation');
  });

  it('carries a restored transcript to a newly selected agent after reopening a conversation', async () => {
    const orchestrator = new WorkbenchOrchestrator({ activeAgent: 'claude', route: 'direct', autonomy: 'ask', isRunning: false });
    const codex = new PromptTrackingAdapter('codex');
    orchestrator.registerAdapter(codex);
    orchestrator.restoreConversationTurns([
      { role: 'user', text: 'restored question' },
      { role: 'assistant', text: 'restored answer' },
    ]);

    await orchestrator.startTask({ prompt: 'follow up', agent: 'codex' });

    expect(codex.seenPrompts[0]).toContain('User: restored question');
    expect(codex.seenPrompts[0]).toContain('Assistant: restored answer');
    expect(codex.seenPrompts[0]).toContain('follow up');
  });
});
