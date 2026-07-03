import { describe, expect, it } from 'vitest';
import { canRunWithoutApproval, createPermissionProfile } from '../src/core/permissions';

describe('permission profiles', () => {
  it('keeps review mode approval-first', () => {
    const profile = createPermissionProfile('review');

    expect(canRunWithoutApproval(profile, 'workspaceEdit')).toBe(false);
    expect(canRunWithoutApproval(profile, 'shellCommand')).toBe(false);
    expect(canRunWithoutApproval(profile, 'gitCommit')).toBe(false);
  });

  it('allows normal coding actions in auto mode but gates risky operations', () => {
    const profile = createPermissionProfile('auto');

    expect(canRunWithoutApproval(profile, 'workspaceEdit')).toBe(true);
    expect(canRunWithoutApproval(profile, 'shellCommand')).toBe(true);
    expect(canRunWithoutApproval(profile, 'network')).toBe(true);
    expect(canRunWithoutApproval(profile, 'gitCommit')).toBe(false);
    expect(canRunWithoutApproval(profile, 'destructiveFilesystem')).toBe(false);
  });
});

