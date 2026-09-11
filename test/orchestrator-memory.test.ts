import { describe, expect, it } from 'vitest';
import { StubAgentAdapter } from '../src/adapters/stub-adapter';
import type { Cognitive1Client, Cognitive1Health, CognitiveHandoff, CognitiveRecall, CognitiveSessionStart } from '../src/cognitive1/cognitive1-client';
import type { WorkbenchEvent } from '../src/core/events';
import { WorkbenchOrchestrator } from '../src/orchestrator/orchestrator';

class FakeCognitive1Client implements Cognitive1Client {
  learnCalls: Array<{ title: string; description: string; tags?: string[] }> = [];

  async health(): Promise<Cognitive1Health> { return { available: true, detail: 'ok' }; }
  async sessionStart(_input: CognitiveSessionStart): Promise<string> { return 'session ok'; }
  async recall(_input: CognitiveRecall): Promise<string> {
    return 'Recall found 1 relevant result(s): [pattern] fixed the proxy /v1 bug last week';
  }
  async handoff(_input: CognitiveHandoff): Promise<string> { return 'handoff ok'; }
  async learn(pattern: { title: string; description: string; tags?: string[] }): Promise<string> {
    this.learnCalls.push(pattern);
    return `saved ${pattern.title}`;
  }
}

class EmptyRecallClient implements Cognitive1Client {
  async health(): Promise<Cognitive1Health> { return { available: true, detail: 'ok' }; }
  async sessionStart(_input: CognitiveSessionStart): Promise<string> { return 'session ok'; }
  async recall(_input: CognitiveRecall): Promise<string> { return 'No recall results found.'; }
  async handoff(_input: CognitiveHandoff): Promise<string> { return 'handoff ok'; }
}

describe('WorkbenchOrchestrator memory', () => {
  it('actually sends what was recalled to the agent, not just fetching it', async () => {
    const c1 = new FakeCognitive1Client();
    const orchestrator = new WorkbenchOrchestrator(
      { activeAgent: 'claude', route: 'direct', autonomy: 'ask', isRunning: false },
      c1,
    );
    orchestrator.registerAdapter(new StubAgentAdapter('claude', 'Claude', true));

    const events: WorkbenchEvent[] = [];
    orchestrator.on('event', (e: WorkbenchEvent) => events.push(e));
    await orchestrator.startTask({ prompt: 'fix the proxy again' });

    const reply = events.find((e) => e.type === 'text.delta');
    expect(reply).toBeDefined();
    if (reply?.type === 'text.delta') {
      expect(reply.text).toContain('Relevant memory from past sessions');
      expect(reply.text).toContain('fixed the proxy /v1 bug last week');
      expect(reply.text).toContain('fix the proxy again'); // the original prompt still gets through
    }
  });

  it('does not inject a briefing when recall found nothing', async () => {
    const orchestrator = new WorkbenchOrchestrator(
      { activeAgent: 'claude', route: 'direct', autonomy: 'ask', isRunning: false },
      new EmptyRecallClient(),
    );
    orchestrator.registerAdapter(new StubAgentAdapter('claude', 'Claude', true));

    const events: WorkbenchEvent[] = [];
    orchestrator.on('event', (e: WorkbenchEvent) => events.push(e));
    await orchestrator.startTask({ prompt: 'hello' });

    const reply = events.find((e) => e.type === 'text.delta');
    if (reply?.type === 'text.delta') {
      expect(reply.text).not.toContain('Relevant memory');
    }
  });

  it('saves a pattern via learn() after a turn finishes', async () => {
    const c1 = new FakeCognitive1Client();
    const orchestrator = new WorkbenchOrchestrator(
      { activeAgent: 'claude', route: 'direct', autonomy: 'ask', isRunning: false },
      c1,
    );
    orchestrator.registerAdapter(new StubAgentAdapter('claude', 'Claude', true));

    await orchestrator.startTask({ prompt: 'fix the thing' });
    await new Promise((r) => setTimeout(r, 20));

    expect(c1.learnCalls.length).toBeGreaterThan(0);
    expect(c1.learnCalls[0].title).toContain('fix the thing');
  });
});
