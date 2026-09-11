import { describe, expect, it } from 'vitest';
import { canRunWithoutApproval, createPermissionProfile } from '../src/core/permissions';

describe('permission profiles', () => {
  it('keeps plan mode fully read-only', () => {
    const profile = createPermissionProfile('plan');

    expect(canRunWithoutApproval(profile, 'workspaceEdit')).toBe(false);
    expect(canRunWithoutApproval(profile, 'shellCommand')).toBe(false);
    expect(canRunWithoutApproval(profile, 'gitCommit')).toBe(false);
  });

  it('keeps ask mode approval-first', () => {
    const profile = createPermissionProfile('ask');

    expect(canRunWithoutApproval(profile, 'workspaceEdit')).toBe(false);
    expect(canRunWithoutApproval(profile, 'shellCommand')).toBe(false);
    expect(canRunWithoutApproval(profile, 'gitCommit')).toBe(false);
  });

  it('allows normal coding actions in autoEdit mode but gates risky operations', () => {
    const profile = createPermissionProfile('autoEdit');

    expect(canRunWithoutApproval(profile, 'workspaceEdit')).toBe(true);
    expect(canRunWithoutApproval(profile, 'shellCommand')).toBe(true);
    expect(canRunWithoutApproval(profile, 'network')).toBe(true);
    expect(canRunWithoutApproval(profile, 'gitCommit')).toBe(false);
    expect(canRunWithoutApproval(profile, 'destructiveFilesystem')).toBe(false);
  });

  it('full mode allows everything except git commit/push', () => {
    const profile = createPermissionProfile('full');

    expect(canRunWithoutApproval(profile, 'workspaceEdit')).toBe(true);
    expect(canRunWithoutApproval(profile, 'shellCommand')).toBe(true);
    expect(canRunWithoutApproval(profile, 'dependencyInstall')).toBe(true);
    expect(canRunWithoutApproval(profile, 'destructiveFilesystem')).toBe(true);
    expect(canRunWithoutApproval(profile, 'gitCommit')).toBe(false);
    expect(canRunWithoutApproval(profile, 'gitPush')).toBe(false);
  });

  it('custom mode allows exactly what is configured, including git if opted in', () => {
    const profile = createPermissionProfile('custom', { workspaceEdit: true, gitCommit: true });

    expect(canRunWithoutApproval(profile, 'workspaceEdit')).toBe(true);
    expect(canRunWithoutApproval(profile, 'gitCommit')).toBe(true);
    expect(canRunWithoutApproval(profile, 'shellCommand')).toBe(false);
  });

  it('custom mode with no configuration is fully gated', () => {
    const profile = createPermissionProfile('custom');
    expect(canRunWithoutApproval(profile, 'workspaceEdit')).toBe(false);
  });
});
