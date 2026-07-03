import type { WorkbenchEvent } from '../core/events';
import type { AgentCapability, AgentId, AutonomyMode, RouteMode } from '../core/types';

export interface AgentRunRequest {
  taskId: string;
  prompt: string;
  route: RouteMode;
  autonomy: AutonomyMode;
  cwd?: string;
}

export interface AgentAdapter {
  readonly id: AgentId;
  getCapability(): Promise<AgentCapability>;
  run(request: AgentRunRequest): AsyncIterable<WorkbenchEvent>;
  stop(taskId: string): Promise<void>;
}
