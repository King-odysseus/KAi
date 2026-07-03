export type AgentId = 'claude' | 'codex' | 'qwen' | 'gemini';

export type RouteMode = 'direct' | 'proxy';

export type AutonomyMode = 'review' | 'auto' | 'custom';

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

