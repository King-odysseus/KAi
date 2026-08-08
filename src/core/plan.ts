import type { AgentId, AutonomyMode, RouteMode } from "./types";

export type PlanStatus = "ready" | "running" | "paused" | "completed" | "aborted";
export type PlanStepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface PlanStep {
  id: string;
  agent: AgentId;
  prompt: string;
  label?: string;
  dependsOn?: string[];
  status: PlanStepStatus;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface Plan {
  id: string;
  title: string;
  steps: PlanStep[];
  route: RouteMode;
  autonomy: AutonomyMode;
  status: PlanStatus;
  currentStepIndex: number;
  createdAt: string;
  completedAt?: string;
}

export function createPlan(title: string, steps: Omit<PlanStep, "id" | "status">[], route: RouteMode, autonomy: AutonomyMode): Plan {
  return {
    id: `plan_${Date.now()}`,
    title,
    steps: steps.map((s, i) => ({ ...s, id: `step_${i}`, status: "pending" })),
    route,
    autonomy,
    status: "ready",
    currentStepIndex: 0,
    createdAt: new Date().toISOString(),
  };
}
