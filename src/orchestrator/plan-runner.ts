import { EventEmitter } from 'events';
import type { AgentAdapter } from '../adapters/agent-adapter';
import type { Cognitive1Client } from '../cognitive1/cognitive1-client';
import { nowIso, type WorkbenchEvent } from '../core/events';
import type { Plan, PlanStep } from '../core/plan';
import type { AgentId } from '../core/types';

export interface PlanEvent {
  type: "plan.started" | "plan.step.starting" | "plan.step.completed" | "plan.step.failed" | "plan.step.paused_for_retry" | "plan.completed" | "plan.aborted" | "plan.paused";
  planId: string;
  step?: PlanStep;
  error?: string;
  timestamp: string;
}

export class PlanRunner extends EventEmitter {
  private isPaused = false;
  private isAborted = false;
  private resumeResolver: (() => void) | null = null;
  private currentAdapter: AgentAdapter | null = null;
  private currentTaskId: string | null = null;

  constructor(
    private plan: Plan,
    private adapters: Map<AgentId, AgentAdapter>,
    private cognitive1: Cognitive1Client,
    private projectPath?: string,
    private onEvent?: (event: WorkbenchEvent) => void,
  ) {
    super();
  }

  getPlan(): Plan { return this.plan; }

  async execute(): Promise<void> {
    this.plan.status = 'running';
    this.emitPlanEvent('plan.started');

    for (let i = this.plan.currentStepIndex; i < this.plan.steps.length; i++) {
      if (this.isAborted) break;
      if (this.isPaused) {
        await this.waitForResume();
        if (this.isAborted) break;
      }

      const step = this.plan.steps[i];
      if (step.dependsOn && step.dependsOn.length > 0) {
        const depsFailed = step.dependsOn.some(depId => {
          const dep = this.plan.steps.find(s => s.id === depId);
          return dep && dep.status === 'failed';
        });
        if (depsFailed) { step.status = 'skipped'; continue; }
      }

      this.plan.currentStepIndex = i;
      await this.executeStep(step);

      if (step.status === 'completed') {
        try {
          await this.cognitive1.sessionStart({
            task: `Plan "${this.plan.title}" step ${i + 1}/${this.plan.steps.length} completed`,
            agent: step.agent, projectPath: this.projectPath,
          });
        } catch { /* best-effort */ }
      }

      if (step.status === 'failed') {
        this.plan.status = 'paused';
        this.isPaused = true;
        this.emitPlanEvent('plan.paused');
        this.emitPlanEvent('plan.step.paused_for_retry', step);
        await this.waitForResume();
        if (this.isAborted) break;
        // After resume, re-run this step (i-- because the loop increments)
        i--;
      }
    }

    if (this.isAborted) {
      this.plan.status = 'aborted';
      this.emitPlanEvent('plan.aborted');
    } else if (this.allStepsDone()) {
      this.plan.status = 'completed';
      this.plan.completedAt = new Date().toISOString();
      this.emitPlanEvent('plan.completed');
    }
  }

  pause(): void { this.isPaused = true; }

  resume(): void {
    this.isPaused = false;
    this.resumeResolver?.();
    this.resumeResolver = null;
  }

  /** Retry a failed step with optional new prompt, then resume. */
  retryStep(stepId: string, newPrompt?: string): void {
    const step = this.plan.steps.find(s => s.id === stepId);
    if (!step || step.status !== 'failed') return;
    step.status = 'pending';
    step.error = undefined;
    if (newPrompt) step.prompt = newPrompt;
    // Rewind currentStepIndex to this step
    const idx = this.plan.steps.indexOf(step);
    if (idx >= 0) this.plan.currentStepIndex = idx;
    this.resume();
  }

  /** Skip a failed step and continue with the next. */
  skipStep(stepId: string): void {
    const step = this.plan.steps.find(s => s.id === stepId);
    if (!step || step.status !== 'failed') return;
    step.status = 'skipped';
    this.resume();
  }

  async abort(): Promise<void> {
    this.isAborted = true;
    if (this.currentAdapter && this.currentTaskId) {
      await this.currentAdapter.stop(this.currentTaskId);
    }
    this.resumeResolver?.();
    this.resumeResolver = null;
  }

  // ─── private helpers ──────────────────────────────────────────

  private async executeStep(step: PlanStep): Promise<void> {
    const adapter = this.adapters.get(step.agent);
    if (!adapter) {
      step.status = 'failed';
      step.error = `No adapter registered for ${step.agent}`;
      this.emitPlanEvent('plan.step.failed', step);
      return;
    }

    step.status = 'running';
    step.startedAt = new Date().toISOString();
    this.emitPlanEvent('plan.step.starting', step);

    try { await this.cognitive1.recall({ query: step.prompt, project: this.projectPath }); } catch { /* */ }

    const taskId = `planstep_${step.id}_${Date.now()}`;
    this.currentAdapter = adapter;
    this.currentTaskId = taskId;

    try {
      const events = adapter.run({ taskId, prompt: step.prompt, route: this.plan.route, autonomy: this.plan.autonomy, cwd: this.projectPath });
      for await (const event of events) {
        if (this.isAborted) break;
        this.onEvent?.(event);
        if (event.type === 'agent.lifecycle') {
          if (event.status === 'completed') {
            step.status = 'completed';
            step.completedAt = new Date().toISOString();
            this.emitPlanEvent('plan.step.completed', step);
            return;
          }
          if (event.status === 'failed') {
            step.status = 'failed';
            step.error = event.detail || 'Step failed';
            this.emitPlanEvent('plan.step.failed', step);
            return;
          }
        }
      }
      step.status = 'completed';
      step.completedAt = new Date().toISOString();
      this.emitPlanEvent('plan.step.completed', step);
    } catch (err) {
      if (this.isAborted) {
        step.status = 'failed'; step.error = 'Plan aborted';
      } else {
        step.status = 'failed';
        step.error = err instanceof Error ? err.message : String(err);
        this.emitPlanEvent('plan.step.failed', step);
      }
    } finally {
      this.currentAdapter = null;
      this.currentTaskId = null;
    }
  }

  private async waitForResume(): Promise<void> {
    return new Promise<void>((resolve) => { this.resumeResolver = resolve; });
  }

  private allStepsDone(): boolean {
    return this.plan.steps.every(s => s.status === 'completed' || s.status === 'skipped');
  }

  private emitPlanEvent(type: PlanEvent['type'], step?: PlanStep, error?: string): void {
    const event: PlanEvent = { type, planId: this.plan.id, step, error, timestamp: nowIso() };
    this.emit('planEvent', event);
  }
}