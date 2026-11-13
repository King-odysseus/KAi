import type { CrewConfig, RouteMode } from '@kai/contracts';

export function crewLimitPolicy(limits: CrewConfig['limits']): string {
  const hasLimit = limits.maxUsd > 0 || limits.maxMinutes > 0;
  if (!hasLimit) return 'No cost or time limit is set. The crew keeps working until you pause or stop it.';
  if (limits.onLimit === 'finish') return 'At the cost or time limit, the crew finishes with accepted work. It never cuts a task short.';
  return 'At the cost or time limit, the crew pauses between tasks and asks you to Continue or Finish. It never cuts a task short.';
}

export function composerLimitPolicy(apiRun: boolean, route: RouteMode): string | null {
  if (!apiRun) return null;
  if (route === 'direct') return 'Direct API budgets block the next request at the limit you set in Usage.';
  if (route === 'proxy') return 'Proxy spend is not measured by the direct API budgets in Usage.';
  return null;
}
