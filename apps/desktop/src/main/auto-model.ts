import { classifyWork, tierModelFor, WORK_LEVEL_LABEL, type AgentRunRequest, type AppSettings, type WorkLevel } from '@kai/contracts';

export interface AutoModelChoice {
  model: string;
  /** Shown on the run's first line, for example "light work: a small, contained edit (typo)". */
  note: string;
}

/** Lets the caller move a request to a stronger level, for example when the agent's record at that level is poor. */
export type LevelAdjuster = (level: WorkLevel, agent: AgentRunRequest['agent']) => { level: WorkLevel; why?: string };

/**
 * The model a CLI run should use when nobody chose one, picked by how heavy the request looks. Only direct runs
 * are steered: the proxy maps models itself, and a CLI signed in there may not know the proxy's names.
 */
export function autoCliModel(
  request: Pick<AgentRunRequest, 'agent' | 'route' | 'prompt' | 'effort'>,
  settings: Pick<AppSettings, 'autoModel'>,
  fileCount = 0,
  adjust?: LevelAdjuster,
): AutoModelChoice | undefined {
  if (request.route !== 'direct' || !settings.autoModel.enabled) return undefined;
  const estimate = request.effort
    ? { level: request.effort, why: 'judged from the step' }
    : classifyWork(request.prompt, { fileCount });
  const adjusted = adjust?.(estimate.level, request.agent);
  const level = adjusted?.level ?? estimate.level;
  const model = tierModelFor(settings.autoModel, request.agent, level);
  if (!model) return undefined;
  const why = adjusted?.why && level !== estimate.level ? adjusted.why : estimate.why;
  return { model, note: `${WORK_LEVEL_LABEL[level].toLowerCase()} work: ${why}` };
}
