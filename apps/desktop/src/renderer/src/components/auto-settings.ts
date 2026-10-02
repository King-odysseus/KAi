import type {
  AgentId,
  AutoStartRequest,
  AutonomyMode,
  ContextChip,
  ExecutionMode,
  GoalInput,
  RouteMode,
} from '@kai/contracts';

/**
 * The levels Auto can run at. Below these the model stops to ask, and an unattended run has nobody to ask — so the
 * composer refuses to start rather than leaving a run parked on a question that will never be answered.
 */
export const AUTO_WORKING_AUTONOMY: ReadonlySet<AutonomyMode> = new Set<AutonomyMode>(['autoEdit', 'full']);

/**
 * Auto's tuning, kept per project rather than per conversation.
 *
 * It used to live in the panel's own state, which was fine while the panel was also the button that started the run.
 * The task goes in the composer now and the composer starts it, so both sides have to read the same values — the
 * arrangement the Team panel already uses for its check command.
 */
export interface AutoSettings {
  /** Blank means the project's own test command, when one can be found. */
  checkCommand: string;
  apiFallback: boolean;
  /** Zero is no cap: a productive run is not cut off by a round number. */
  maxTurns: number;
  /** Zero is no cap. */
  maxHours: number;
  /** Zero is no cap; the spend ceiling is the person's call, not a default. */
  maxCostUsd: number;
  minGapSeconds: number;
}

/** The slice of storage these need, so a test can supply its own rather than a browser's. */
export interface AutoSettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function defaultAutoSettings(): AutoSettings {
  return { checkCommand: '', apiFallback: true, maxTurns: 0, maxHours: 12, maxCostUsd: 0, minGapSeconds: 0 };
}

export function autoSettingsKey(projectId: string | null | undefined): string {
  return `kai.autoSettings.${projectId ?? 'none'}`;
}

function browserStorage(): AutoSettingsStorage | null {
  try {
    return window.localStorage;
  } catch {
    // A window with storage locked down keeps the defaults in memory instead.
    return null;
  }
}

/** A number the settings offer, or the default — a stored value from an older build is not trusted. */
function bounded(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : fallback;
}

export function readAutoSettings(
  projectId: string | null | undefined,
  storage: AutoSettingsStorage | null = browserStorage(),
): AutoSettings {
  const defaults = defaultAutoSettings();
  if (!storage) return defaults;
  try {
    const value = JSON.parse(storage.getItem(autoSettingsKey(projectId)) ?? '{}') as Record<string, unknown>;
    return {
      checkCommand: typeof value.checkCommand === 'string' ? value.checkCommand.slice(0, 1_000) : defaults.checkCommand,
      apiFallback: typeof value.apiFallback === 'boolean' ? value.apiFallback : defaults.apiFallback,
      maxTurns: Math.round(bounded(value.maxTurns, 0, 500, defaults.maxTurns)),
      maxHours: bounded(value.maxHours, 0, 168, defaults.maxHours),
      maxCostUsd: bounded(value.maxCostUsd, 0, 10_000, defaults.maxCostUsd),
      minGapSeconds: Math.round(bounded(value.minGapSeconds, 0, 120, defaults.minGapSeconds)),
    };
  } catch {
    return defaults;
  }
}

export function writeAutoSettings(
  projectId: string,
  settings: AutoSettings,
  storage: AutoSettingsStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(autoSettingsKey(projectId), JSON.stringify(settings));
  } catch {
    // Remembering the settings is a convenience only.
  }
}

/** The composer's own choices, which Auto runs under exactly as a normal send would. */
export interface AutoStartDraft {
  projectId: string;
  prompt: string;
  settings: AutoSettings;
  execution: ExecutionMode;
  agent: AgentId;
  route: RouteMode;
  autonomy: AutonomyMode;
  /** Continue this conversation; without it Auto opens one for the task. */
  conversationId?: string | null;
  model?: string;
  goal?: GoalInput;
  skills?: string[];
  selectedPaths?: string[];
  contextChips?: ContextChip[];
}

/**
 * The request Auto is started with. Kept out of the component so the one place that decides what a run is given —
 * its mode, its model, its check, its caps — can be read and tested on its own.
 */
export function buildAutoStartRequest(draft: AutoStartDraft): AutoStartRequest {
  const { settings } = draft;
  return {
    ...(draft.conversationId ? { conversationId: draft.conversationId } : {}),
    projectId: draft.projectId,
    prompt: draft.prompt.trim(),
    execution: draft.execution,
    agent: draft.agent,
    ...(draft.model ? { model: draft.model } : {}),
    route: draft.route,
    autonomy: draft.autonomy,
    checkCommand: settings.checkCommand.trim(),
    maxTurns: settings.maxTurns,
    maxCostUsd: settings.maxCostUsd,
    maxHours: settings.maxHours,
    apiFallback: settings.apiFallback,
    minGapSeconds: settings.minGapSeconds,
    ...(draft.goal ? { goal: draft.goal } : {}),
    ...(draft.skills?.length ? { skills: draft.skills } : {}),
    ...(draft.selectedPaths?.length ? { selectedPaths: draft.selectedPaths } : {}),
    ...(draft.contextChips?.length ? { contextChips: draft.contextChips } : {}),
  };
}
