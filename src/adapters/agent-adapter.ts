import type { WorkbenchEvent } from '../core/events';
import type { AgentCapability, AgentId, AutonomyMode, PermissionKey, RouteMode } from '../core/types';

export interface AgentRunRequest {
  taskId: string;
  prompt: string;
  route: RouteMode;
  autonomy: AutonomyMode;
  cwd?: string;
  /** Native session/conversation id to resume (Claude --resume, Codex exec
   * resume, Qwen/Gemini --resume) so a follow-up continues the same agent
   * conversation instead of starting fresh. Undefined starts a new session. */
  resumeSessionId?: string;
  /** Custom-mode permission flags, forwarded so adapters can derive their
   * native sandbox/permission flag when autonomy === 'custom'. */
  customAllowed?: Partial<Record<PermissionKey, boolean>>;
}

export type ApprovalResponse = 'once' | 'always' | 'deny';

export interface AgentAdapter {
  readonly id: AgentId;
  getCapability(): Promise<AgentCapability>;
  run(request: AgentRunRequest): AsyncIterable<WorkbenchEvent>;
  stop(taskId: string): Promise<void>;
  /** Answers a pending approval.request this adapter emitted, feeding the
   * decision back into the live agent run. Optional — most adapters can't
   * do this yet (see docs/design's approval-card note); when absent, the
   * orchestrator still records the response for its own bookkeeping. */
  respondToApproval?(taskId: string, eventId: string, response: ApprovalResponse): Promise<void>;
}
