import { isBuiltInRole, type TeamRecordEntry, type TeamRecordStats, type TeamResolvedAssignee, type WorkflowRun } from '@kai/contracts';

export const MIN_TEAM_JOBS = 5;

/** Original parts are counted once; fixes contribute effort but never masquerade as extra jobs. */
export function recordsForRun(run: WorkflowRun): TeamRecordEntry[] {
  const projectId = run.projectId;
  if (!projectId) return [];
  const workflow = run.workflow;
  const blocked = workflow.steps.some((step) => step.gate === 'security' && step.verdict?.result === 'block');
  return workflow.steps.flatMap((step): TeamRecordEntry[] => {
    if (!step.role || step.round || step.fixOf || !step.startedAt || (step.status !== 'completed' && step.status !== 'failed')) return [];
    const attempts = [step, ...workflow.steps.filter((fix) => fix.fixOf === step.id && fix.startedAt)];
    const durationMs = attempts.reduce((sum, attempt) => {
      const start = attempt.startedAt ?? workflow.createdAt;
      return sum + Math.max(0, Date.parse(attempt.completedAt ?? start) - Date.parse(start));
    }, 0);
    const costs = attempts.flatMap((attempt) => attempt.costUsd === undefined ? [] : [attempt.costUsd]);
    const assignee = (step.execution ?? workflow.execution) === 'api' ? 'api' : step.agent;
    return [{
      id: `${workflow.id}:${step.id}`,
      projectId,
      role: step.role,
      custom: !isBuiltInRole(step.role),
      assignee,
      route: step.route ?? workflow.route,
      ...(step.model ?? workflow.model ? { model: step.model ?? workflow.model } : {}),
      startedAt: step.startedAt,
      durationMs,
      ...(costs.length ? { costUsd: costs.reduce((sum, cost) => sum + cost, 0) } : {}),
      outcome: step.status,
      neededFix: attempts.length > 1,
      blockedByReview: blocked,
      overridden: step.suggestedAssignee !== undefined && step.suggestedAssignee !== assignee,
    }];
  });
}

export function roleRecord(entries: readonly TeamRecordEntry[], role: string, assignee: TeamResolvedAssignee, projectId?: string): TeamRecordStats | null {
  const all = entries.filter((entry) => entry.role === role && entry.assignee === assignee);
  const own = projectId ? all.filter((entry) => entry.projectId === projectId) : [];
  const scope = own.length >= MIN_TEAM_JOBS ? 'project' : 'all';
  const selected = scope === 'project' ? own : all;
  const first = selected.at(0);
  if (!first) return null;
  const durations = selected.map((entry) => entry.durationMs).sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  const medianDurationMs = durations.length % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2;
  const passed = selected.filter((entry) => entry.outcome === 'completed' && !entry.neededFix && !entry.blockedByReview).length;
  return {
    role: first.role, assignee, scope, jobs: selected.length, passed,
    successRate: passed / selected.length, medianDurationMs,
    totalCostUsd: selected.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0),
  };
}

export function recordPhrase(record: TeamRecordStats): string {
  return `passed first time in ${record.passed} of ${record.jobs} jobs ${record.scope === 'project' ? 'here' : 'across all projects'}`;
}

export function betterRecord(current: TeamRecordStats | null, alternatives: readonly TeamRecordStats[]): TeamRecordStats | null {
  if (!current || current.jobs < MIN_TEAM_JOBS) return null;
  return alternatives.filter((record) => record.assignee !== current.assignee && record.jobs >= MIN_TEAM_JOBS
    && record.successRate - current.successRate >= 0.15 - Number.EPSILON)
    .sort((a, b) => b.successRate - a.successRate || b.jobs - a.jobs || a.assignee.localeCompare(b.assignee))[0] ?? null;
}
