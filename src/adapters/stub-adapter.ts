import { createEventId, nowIso, type WorkbenchEvent } from '../core/events';
import type { AgentCapability, AgentId, AutonomyMode, RouteMode } from '../core/types';
import type { AgentAdapter, AgentRunRequest } from './agent-adapter';

export class StubAgentAdapter implements AgentAdapter {
  constructor(
    public readonly id: AgentId,
    private readonly displayName: string,
    private readonly available = false
  ) {}

  async getCapability(): Promise<AgentCapability> {
    return {
      id: this.id,
      displayName: this.displayName,
      available: this.available,
      unavailableReason: this.available ? undefined : `${this.displayName} adapter is scaffolded but not wired yet.`,
      supportsRoutes: ['direct', 'proxy'],
      supportsAutonomy: ['plan', 'ask', 'autoEdit', 'full', 'custom'],
      supportsTools: false,
      supportsApprovals: true,
      supportsDiffs: true,
      supportsMcp: true,
      requiredConfigKeys: []
    };
  }

  async *run(request: AgentRunRequest): AsyncIterable<WorkbenchEvent> {
    yield this.lifecycle(request.taskId, 'starting', request.route, request.autonomy);
    yield {
      id: createEventId(),
      type: 'text.delta',
      taskId: request.taskId,
      timestamp: nowIso(),
      agent: this.id,
      channel: 'assistant',
      text: `${this.displayName} is not connected yet. Scaffold received: ${request.prompt}`
    };
    yield this.lifecycle(request.taskId, 'completed', request.route, request.autonomy);
  }

  async stop(): Promise<void> {
    return Promise.resolve();
  }

  private lifecycle(
    taskId: string,
    status: 'starting' | 'running' | 'paused' | 'completed' | 'failed',
    route: RouteMode,
    autonomy: AutonomyMode
  ): WorkbenchEvent {
    return {
      id: createEventId(),
      type: 'agent.lifecycle',
      taskId,
      timestamp: nowIso(),
      agent: this.id,
      status,
      detail: `${this.displayName} ${status} with ${route}/${autonomy}`
    };
  }
}

