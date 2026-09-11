import type { AutonomyMode, PermissionKey, PermissionProfile } from './types';

const permissionKeys: PermissionKey[] = [
  'workspaceEdit',
  'shellCommand',
  'dependencyInstall',
  'configWrite',
  'network',
  'gitCommit',
  'gitPush',
  'destructiveFilesystem'
];

/** Human-readable label + description for a PermissionKey, used by the
 * Custom mode editor in the composer's mode menu. */
export const PERMISSION_KEY_INFO: Record<PermissionKey, { label: string; description: string }> = {
  workspaceEdit: { label: 'Edit files', description: 'Create, modify, or delete files in the workspace.' },
  shellCommand: { label: 'Run commands', description: 'Run shell commands (build, test, lint, etc.).' },
  dependencyInstall: { label: 'Install dependencies', description: 'Run package installs (npm install, pip install, etc.).' },
  configWrite: { label: 'Write config', description: 'Write to agent/proxy config files KAI manages.' },
  network: { label: 'Network access', description: 'Make outbound network requests.' },
  gitCommit: { label: 'Git commit', description: 'Create git commits.' },
  gitPush: { label: 'Git push', description: 'Push commits to a remote.' },
  destructiveFilesystem: { label: 'Destructive filesystem', description: 'Delete files/directories outside normal edits.' },
};

/** Read-only baseline — used by 'plan'/'ask' and as the starting point for
 * 'autoEdit'/'full'/'custom' before their extra permissions are layered on. */
function emptyAllowed(): Record<PermissionKey, boolean> {
  return Object.fromEntries(permissionKeys.map((key) => [key, false])) as Record<PermissionKey, boolean>;
}

export function createPermissionProfile(mode: AutonomyMode, customAllowed?: Partial<Record<PermissionKey, boolean>>): PermissionProfile {
  const allowed = emptyAllowed();

  if (mode === 'autoEdit') {
    allowed.workspaceEdit = true;
    allowed.shellCommand = true;
    allowed.network = true;
  } else if (mode === 'full') {
    allowed.workspaceEdit = true;
    allowed.shellCommand = true;
    allowed.network = true;
    allowed.dependencyInstall = true;
    allowed.configWrite = true;
    allowed.destructiveFilesystem = true;
    // gitCommit/gitPush stay gated even in Full — the PRD requires explicit
    // approval for those regardless of autonomy mode.
  } else if (mode === 'custom' && customAllowed) {
    for (const key of permissionKeys) {
      if (customAllowed[key]) allowed[key] = true;
    }
    // gitCommit/gitPush remain gated unless a Custom profile deliberately
    // allows them — canRunWithoutApproval already reads customAllowed
    // directly, this loop is what makes that opt-in explicit.
  }
  // 'plan' and 'ask' both stay fully gated (false across the board).

  return { mode, allowed };
}

export function canRunWithoutApproval(profile: PermissionProfile, permission: PermissionKey): boolean {
  return profile.allowed[permission] === true;
}
