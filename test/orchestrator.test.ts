import { describe, expect, it } from 'vitest';
import { StubAgentAdapter } from '../src/adapters/stub-adapter';
import type { Cognitive1Client, Cognitive1Health, CognitiveHandoff, CognitiveRecall, CognitiveSessionStart } from '../src/cognitive1/cognitive1-client';
import type { WorkbenchEvent } from '../src/core/events';
import { WorkbenchOrchestrator } from '../src/orchestrator/orchestrator';

describe('WorkbenchOrchestrator', () => {
  it('emits memory and agent events for a task', async () => {
    const orchestrator = new WorkbenchOrchestrator({
      activeAgent: 'claude', route: 'direct', autonomy: 'review', isRunning: false,
    });
    orchestrator.registerAdapter(new StubAgentAdapter('claude', 'Claude', true));

    const events: WorkbenchEvent[] = [];
    orchestrator.on('event', (event: WorkbenchEvent) => events.push(event));

    await orchestrator.startTask({ prompt: 'hello' });

    expect(events.map((e) => e.type)).toContain('memory.event');
    expect(events.map((e) => e.type)).toContain('text.delta');
    expect(events.filter((e) => e.type === 'memory.event')).toHaveLength(2);
    expect(orchestrator.getState().isRunning).toBe(false);
  });

  it('uses the Cognitive1 bridge for session and recall summaries', async () => {
    const orchestrator = new WorkbenchOrchestrator(
      { activeAgent: 'claude', route: 'direct', autonomy: 'review', isRunning: false },
      new FakeCognitive1Client(),
    );
    orchestrator.registerAdapter(new StubAgentAdapter('claude', 'Claude', true));

    const events: WorkbenchEvent[] = [];
    orchestrator.on('event', (event: WorkbenchEvent) => events.push(event));
    await orchestrator.startTask({ prompt: 'build something' });

    const summaries = events.filter((e) => e.type === 'memory.event').map((e) => e.summary);
    expect(summaries).toEqual(['session ok for claude', 'recall ok for build something']);
  });

  it('prevents concurrent active agent runs', async () => {
    const orchestrator = new WorkbenchOrchestrator({
      activeAgent: 'claude', route: 'direct', autonomy: 'auto', isRunning: false,
    });
    orchestrator.registerAdapter(new SlowAdapter());

    const firstRun = orchestrator.startTask({ prompt: 'first' });
    await expect(orchestrator.startTask({ prompt: 'second' })).rejects.toThrow(/already has an active agent run/);
    await firstRun;
  });

  it('reports registered adapter capabilities', async () => {
    const orchestrator = new WorkbenchOrchestrator({
      activeAgent: 'claude', route: 'direct', autonomy: 'review', isRunning: false,
    });
    orchestrator.registerAdapter(new StubAgentAdapter('claude', 'Claude', true));
    orchestrator.registerAdapter(new StubAgentAdapter('codex', 'Codex', false));

    const caps = await orchestrator.getCapabilities();
    expect(caps.map((c) => c.id)).toEqual(['claude', 'codex']);
    expect(caps[0].available).toBe(true);
    expect(caps[1].available).toBe(false);
  });

  it('handles handoff between agents', async () => {
    const c1 = new FakeCognitive1Client();
    const orchestrator = new WorkbenchOrchestrator(
      { activeAgent: 'claude', route: 'direct', autonomy: 'review', isRunning: false },
      c1,
    );
    orchestrator.registerAdapter(new StubAgentAdapter('claude', 'Claude', true));
    orchestrator.registerAdapter(new StubAgentAdapter('codex', 'Codex', true));

    const events: WorkbenchEvent[] = [];
    orchestrator.on('event', (event: WorkbenchEvent) => events.push(event));

    // Start a task with Claude
    const taskPromise = orchestrator.startTask({ prompt: 'review this code' });
    // Give it a moment to start
    await new Promise((r) => setTimeout(r, 10));

    // Handoff to Codex
    await orchestrator.handoff('codex');
    await taskPromise;

    const memoryActions = events
      .filter((e) => e.type === 'memory.event')
      .map((e) => e.action);
    expect(memoryActions).toContain('handoff');
    expect(memoryActions).toContain('session_start');
    expect(memoryActions).toContain('recall');

    // State should reflect the target agent
    expect(orchestrator.getState().activeAgent).toBe('codex');
  });

  it('rejects handoff to the same agent', async () => {
    const orchestrator = new WorkbenchOrchestrator(
      { activeAgent: 'claude', route: 'direct', autonomy: 'review', isRunning: false },
    );
    orchestrator.registerAdapter(new StubAgentAdapter('claude', 'Claude', true));

    const taskPromise = orchestrator.startTask({ prompt: 'test' });
    await new Promise((r) => setTimeout(r, 5));

    await expect(orchestrator.handoff('claude')).rejects.toThrow(/Already using claude/);
    await orchestrator.stopActiveTask();
    await taskPromise;
  });

  it('rejects handoff with no active task', async () => {
    const orchestrator = new WorkbenchOrchestrator(
      { activeAgent: 'claude', route: 'direct', autonomy: 'review', isRunning: false },
    );
    await expect(orchestrator.handoff('codex')).rejects.toThrow(/No active task/);
  });
});

class SlowAdapter extends StubAgentAdapter {
  constructor() { super('claude', 'Claude', true); }
  override async *run(request: Parameters<StubAgentAdapter['run']>[0]): AsyncIterable<WorkbenchEvent> {
    await new Promise((r) => setTimeout(r, 20));
    yield* super.run(request);
  }
}

class FakeCognitive1Client implements Cognitive1Client {
  async health(): Promise<Cognitive1Health> {
    return { available: true, detail: 'fake ready' };
  }
  async sessionStart(input: CognitiveSessionStart): Promise<string> {
    return `session ok for ${input.agent}`;
  }
  async recall(input: CognitiveRecall): Promise<string> {
    return `recall ok for ${input.query}`;
  }
  async handoff(input: CognitiveHandoff): Promise<string> {
    return `handoff ok from ${input.fromAgent}`;
  }
}
