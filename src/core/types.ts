import type { GoalInput } from './goal';

export type AgentId = 'claude' | 'codex' | 'qwen' | 'gemini';

export type RouteMode = 'direct' | 'proxy';

/**
 * Permission mode for how much an agent can do without asking first.
 *
 * - plan: read-only. The agent looks around and proposes a plan before
 *   touching any file.
 * - ask: asks before each file edit and command (the old "review").
 * - autoEdit: edits files without asking; still asks before risky commands
 *   (the old "auto").
 * - full: never asks. Best inside a worktree or sandbox.
 * - custom: a user-defined PermissionProfile (see permissions.ts).
 *
 * Legacy values 'review' and 'auto' are still accepted at the config/storage
 * boundary and migrated to 'ask'/'autoEdit' — see migrateAutonomyMode().
 */
export type AutonomyMode = 'plan' | 'ask' | 'autoEdit' | 'full' | 'custom';

/** Autonomy mode values as they existed before the 5-mode redesign. */
export type LegacyAutonomyMode = 'review' | 'auto' | 'custom';

/**
 * Migrates a possibly-legacy autonomy mode (from settings.json or
 * workspaceState written by an older KAI version) to the current set.
 */
export function migrateAutonomyMode(mode: string): AutonomyMode {
  if (mode === 'review') return 'ask';
  if (mode === 'auto') return 'autoEdit';
  if (mode === 'plan' || mode === 'ask' || mode === 'autoEdit' || mode === 'full' || mode === 'custom') return mode;
  return 'ask';
}

export type PermissionKey =
  | 'workspaceEdit'
  | 'shellCommand'
  | 'dependencyInstall'
  | 'configWrite'
  | 'network'
  | 'gitCommit'
  | 'gitPush'
  | 'destructiveFilesystem';

export interface PermissionProfile {
  mode: AutonomyMode;
  allowed: Record<PermissionKey, boolean>;
}

export interface WorkbenchState {
  activeAgent: AgentId;
  route: RouteMode;
  autonomy: AutonomyMode;
  activeTaskId?: string;
  isRunning: boolean;
}

export interface TaskRequest {
  prompt: string;
  agent?: AgentId;
  route?: RouteMode;
  autonomy?: AutonomyMode;
  /** Optional goal created together with this run (the `/goal` flow). */
  goal?: GoalInput;
}

export interface AgentCapability {
  id: AgentId;
  displayName: string;
  available: boolean;
  version?: string;
  unavailableReason?: string;
  supportsRoutes: RouteMode[];
  supportsAutonomy: AutonomyMode[];
  supportsTools: boolean;
  supportsApprovals: boolean;
  supportsDiffs: boolean;
  supportsMcp: boolean;
  contextWindow?: number;
  requiredConfigKeys: string[];
}
