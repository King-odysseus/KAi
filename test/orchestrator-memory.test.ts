import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { StubAgentAdapter } from '../src/adapters/stub-adapter';
import type { Cognitive1Client, Cognitive1Health, CognitiveHandoff, CognitiveRecall, CognitiveSessionStart } from '../src/cognitive1/cognitive1-client';
import type { WorkbenchEvent } from '../src/core/events';
import { WorkbenchOrchestrator } from '../src/orchestrator/orchestrator';
import { CognitiveRuleStore } from '../src/cognitive1/rule-store';
import { createPlan } from '../src/core/plan';

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

class CapturePromptAdapter extends StubAgentAdapter {
  lastPrompt = '';

  override async *run(request: Parameters<StubAgentAdapter['run']>[0]): AsyncIterable<WorkbenchEvent> {
    this.lastPrompt = request.prompt;
    yield* super.run(request);
  }
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

  it('injects the authoritative execution rules into every agent prompt', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-rules-orchestrator-'));
    try {
      const rulesPath = path.join(dir, 'Instruct.md');
      await fs.writeFile(
        rulesPath,
        '# Cognitive1\n\n## Rules\n\n1. **No API keys ever** - Never commit secrets.\n',
        'utf8',
      );
      const orchestrator = new WorkbenchOrchestrator(
        { activeAgent: 'claude', route: 'direct', autonomy: 'ask', isRunning: false },
        new EmptyRecallClient(),
        undefined,
        undefined,
        new CognitiveRuleStore(rulesPath),
      );
      orchestrator.registerAdapter(new StubAgentAdapter('claude', 'Claude', true));

      const events: WorkbenchEvent[] = [];
      orchestrator.on('event', (e: WorkbenchEvent) => events.push(e));
      await orchestrator.startTask({ prompt: 'implement the feature' });

      const reply = events.find((e) => e.type === 'text.delta');
      expect(reply?.type).toBe('text.delta');
      if (reply?.type === 'text.delta') {
        expect(reply.text).toContain('[COGNITIVE1 STANDING INSTRUCTIONS]');
        expect(reply.text).toContain('No API keys ever');
        expect(reply.text).toContain('implement the feature');
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('injects the same execution rules into every plan step', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-rules-plan-'));
    try {
      const rulesPath = path.join(dir, 'Instruct.md');
      await fs.writeFile(
        rulesPath,
        '# Cognitive1\n\n## Rules\n\n1. **No API keys ever** - Never commit secrets.\n',
        'utf8',
      );
      const orchestrator = new WorkbenchOrchestrator(
        { activeAgent: 'codex', route: 'direct', autonomy: 'ask', isRunning: false },
        new EmptyRecallClient(),
        undefined,
        undefined,
        new CognitiveRuleStore(rulesPath),
      );
      const adapter = new CapturePromptAdapter('codex', 'Codex', true);
      orchestrator.registerAdapter(adapter);

      await orchestrator.executePlan(createPlan(
        'Rules verification',
        [{ agent: 'codex', prompt: 'run the workflow step' }],
        'direct',
        'ask',
      ));

      expect(adapter.lastPrompt).toContain('[COGNITIVE1 STANDING INSTRUCTIONS]');
      expect(adapter.lastPrompt).toContain('No API keys ever');
      expect(adapter.lastPrompt).toContain('run the workflow step');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
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
