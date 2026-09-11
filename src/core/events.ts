import type { AgentId, AutonomyMode, RouteMode } from './types';
import type { Plan } from './plan';

export type WorkbenchEvent =
  | TextDeltaEvent
  | ToolCallEvent
  | ApprovalRequestEvent
  | DiffProposalEvent
  | FileEditAppliedEvent
  | AutonomyChangedEvent
  | PermissionEscalationEvent
  | ErrorEvent
  | CostUpdateEvent
  | MemoryEvent
  | RouteChangedEvent
  | AgentLifecycleEvent
  | RawFallbackEvent
  | PlanUpdateEvent;

export interface BaseEvent {
  id: string;
  type: WorkbenchEvent['type'];
  taskId: string;
  timestamp: string;
  agent?: AgentId;
}

export interface TextDeltaEvent extends Omit<BaseEvent, 'type'> {
  type: 'text.delta';
  text: string;
  channel: 'assistant' | 'summary' | 'raw';
}

export interface ToolCallEvent extends Omit<BaseEvent, 'type'> {
  type: 'tool.call';
  name: string;
  status: 'started' | 'updated' | 'completed' | 'failed';
  input?: unknown;
  output?: unknown;
}

export interface ApprovalRequestEvent extends Omit<BaseEvent, 'type'> {
  type: 'approval.request';
  title: string;
  detail: string;
  risk: 'low' | 'medium' | 'high';
}

export interface DiffProposalEvent extends Omit<BaseEvent, 'type'> {
  type: 'diff.proposal';
  filePath: string;
  summary: string;
  diff?: string;
}

export interface FileEditAppliedEvent extends Omit<BaseEvent, 'type'> {
  type: 'file.edit.applied';
  filePath: string;
  summary: string;
}

export interface AutonomyChangedEvent extends Omit<BaseEvent, 'type'> {
  type: 'autonomy.changed';
  from: AutonomyMode;
  to: AutonomyMode;
}

export interface PermissionEscalationEvent extends Omit<BaseEvent, 'type'> {
  type: 'permission.escalation';
  permission: string;
  reason: string;
}

export interface ErrorEvent extends Omit<BaseEvent, 'type'> {
  type: 'error';
  message: string;
  recoverable: boolean;
}

export interface CostUpdateEvent extends Omit<BaseEvent, 'type'> {
  type: 'cost.update';
  amountUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  sessionId?: string;
}

export interface MemoryEvent extends Omit<BaseEvent, 'type'> {
  type: 'memory.event';
  action: 'session_start' | 'recall' | 'handoff' | 'learn' | 'session_end';
  summary: string;
}

export interface RouteChangedEvent extends Omit<BaseEvent, 'type'> {
  type: 'route.changed';
  from: RouteMode;
  to: RouteMode;
}

export interface AgentLifecycleEvent extends Omit<BaseEvent, 'type'> {
  type: 'agent.lifecycle';
  status: 'starting' | 'running' | 'paused' | 'completed' | 'failed';
  detail?: string;
}

export interface RawFallbackEvent extends Omit<BaseEvent, 'type'> {
  type: 'raw.fallback';
  sourceType: string;
  payload: unknown;
}

export interface PlanUpdateEvent extends Omit<BaseEvent, 'type'> {
  type: 'plan.update';
  plan: Plan;
}

export function createEventId(prefix = 'evt'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}