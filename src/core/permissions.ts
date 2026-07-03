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

export function createPermissionProfile(mode: AutonomyMode): PermissionProfile {
  const allowed = Object.fromEntries(permissionKeys.map((key) => [key, false])) as Record<PermissionKey, boolean>;

  if (mode === 'auto') {
    allowed.workspaceEdit = true;
    allowed.shellCommand = true;
    allowed.network = true;
  }

  return { mode, allowed };
}

export function canRunWithoutApproval(profile: PermissionProfile, permission: PermissionKey): boolean {
  return profile.allowed[permission] === true;
}

