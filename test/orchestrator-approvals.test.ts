import { describe, expect, it } from 'vitest';
import { createEventId, nowIso, type WorkbenchEvent } from '../src/core/events';
import type { AgentCapability, AgentId } from '../src/core/types';
import type { AgentAdapter, AgentRunRequest, ApprovalResponse } from '../src/adapters/agent-adapter';
import { WorkbenchOrchestrator } from '../src/orchestrator/orchestrator';

/** An adapter that asks for approval before "running" a command, and
 * records how the orchestrator answered — the mechanism Phase 6 wires real
 * agents into once they can carry an approval channel non-interactively. */
class ApprovalAskingAdapter implements AgentAdapter {
  readonly id: AgentId = 'claude';
  responses: ApprovalResponse[] = [];

  async getCapability(): Promise<AgentCapability> {
    return {
      id: this.id, displayName: 'Claude', available: true,
      supportsRoutes: ['direct', 'proxy'], supportsAutonomy: ['plan', 'ask', 'autoEdit', 'full', 'custom'],
      supportsTools: true, supportsApprovals: true, supportsDiffs: true, supportsMcp: false, requiredConfigKeys: [],
    };
  }

  async *run(request: AgentRunRequest): AsyncIterable<WorkbenchEvent> {
    yield {
      id: 'approval_1', type: 'approval.request', taskId: request.taskId, timestamp: nowIso(), agent: this.id,
      title: 'Run npm test', detail: '$ npm test', risk: 'low',
    };
    yield { id: createEventId(), type: 'agent.lifecycle', taskId: request.taskId, timestamp: nowIso(), agent: this.id, status: 'completed', detail: 'done' };
  }

  async stop(): Promise<void> {}

  async respondToApproval(_taskId: string, _eventId: string, response: ApprovalResponse): Promise<void> {
    this.responses.push(response);
  }
}

describe('WorkbenchOrchestrator approvals', () => {
  it('emits approval.request and resolves it via respondToApproval', async () => {
    const adapter = new ApprovalAskingAdapter();
    const orchestrator = new WorkbenchOrchestrator({ activeAgent: 'claude', route: 'direct', autonomy: 'ask', isRunning: false });
    orchestrator.registerAdapter(adapter);

    const events: WorkbenchEvent[] = [];
    orchestrator.on('event', (e: WorkbenchEvent) => events.push(e));
    await orchestrator.startTask({ prompt: 'run tests' });

    const approval = events.find((e) => e.type === 'approval.request');
    expect(approval).toBeDefined();

    await orchestrator.respondToApproval('approval_1', 'once');
    expect(adapter.responses).toEqual(['once']);
  });

  it('rejects responding to an unknown or already-resolved approval', async () => {
    const orchestrator = new WorkbenchOrchestrator({ activeAgent: 'claude', route: 'direct', autonomy: 'ask', isRunning: false });
    await expect(orchestrator.respondToApproval('nope', 'once')).rejects.toThrow(/No pending approval/);
  });

  it('"always" auto-resolves a matching future approval without blocking the run', async () => {
    const adapter = new ApprovalAskingAdapter();
    const orchestrator = new WorkbenchOrchestrator({ activeAgent: 'claude', route: 'direct', autonomy: 'ask', isRunning: false });
    orchestrator.registerAdapter(adapter);

    await orchestrator.startTask({ prompt: 'run tests once' });
    await orchestrator.respondToApproval('approval_1', 'always');
    expect(orchestrator.getAlwaysAllowRules()).toEqual(['claude:Run npm test']);

    // A second run hits the same approval.request id (the stub always uses
    // 'approval_1') — it should auto-resolve as 'once' via the always rule,
    // not sit pending, and not throw when nothing calls respondToApproval.
    // The first entry is the explicit 'always' response above.
    await orchestrator.startTask({ prompt: 'run tests again' });
    expect(adapter.responses).toEqual(['always', 'once']);
  });

  it('setAlwaysAllowRules restores persisted rules', async () => {
    const adapter = new ApprovalAskingAdapter();
    const orchestrator = new WorkbenchOrchestrator({ activeAgent: 'claude', route: 'direct', autonomy: 'ask', isRunning: false });
    orchestrator.registerAdapter(adapter);
    orchestrator.setAlwaysAllowRules(['claude:Run npm test']);

    await orchestrator.startTask({ prompt: 'run tests' });
    expect(adapter.responses).toEqual(['once']);
  });
});
