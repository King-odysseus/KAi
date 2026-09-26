import type { PreflightResult, TeamPart } from '@kai/contracts';

/** Every folder or file the plan's editing parts will touch, once each: what to ask the coordination service about. */
export function teamPaths(parts: readonly Pick<TeamPart, 'role' | 'paths'>[]): string[] {
  const editing = parts.filter((part) => part.role !== 'securityReviewer' && part.role !== 'codeReviewer');
  return [...new Set(editing.flatMap((part) => part.paths.map((path) => path.trim()).filter(Boolean)))].slice(0, 200);
}

/** One line per other agent that has claimed something the team is about to change. */
export function conflictDetail(conflicts: PreflightResult['conflicts']): string {
  return conflicts.map((conflict) => `${conflict.agent} (${conflict.project}): ${conflict.overlap.join(', ')}`).join('\n');
}
