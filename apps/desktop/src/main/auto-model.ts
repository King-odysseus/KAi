import { classifyWork, tierModelFor, WORK_LEVEL_LABEL, type AgentRunRequest, type AppSettings } from '@kai/contracts';

export interface AutoModelChoice {
  model: string;
  /** Shown on the run's first line, for example "light work: a small, contained edit (typo)". */
  note: string;
}

/**
 * The model a CLI run should use when nobody chose one, picked by how heavy the request looks. Only direct runs
 * are steered: the proxy maps models itself, and a CLI signed in there may not know the proxy's names.
 */
export function autoCliModel(
  request: Pick<AgentRunRequest, 'agent' | 'route' | 'prompt' | 'effort'>,
  settings: Pick<AppSettings, 'autoModel'>,
  fileCount = 0,
): AutoModelChoice | undefined {
  if (request.route !== 'direct' || !settings.autoModel.enabled) return undefined;
  const estimate = request.effort
    ? { level: request.effort, why: 'judged from the step' }
    : classifyWork(request.prompt, { fileCount });
  const model = tierModelFor(settings.autoModel, request.agent, estimate.level);
  return model ? { model, note: `${WORK_LEVEL_LABEL[estimate.level].toLowerCase()} work: ${estimate.why}` } : undefined;
}
