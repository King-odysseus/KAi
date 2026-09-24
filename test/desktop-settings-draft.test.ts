import { describe, expect, it } from 'vitest';
import { reconcileSettingsDraft } from '../apps/desktop/src/renderer/src/components/settings-draft';

describe('settings draft reconciliation', () => {
  it('keeps an edited checkbox through polling while accepting unrelated remote changes', () => {
    const previous = { cognitive1: { overwatch: { enabled: false, model: 'old' } }, theme: 'dark' };
    const draft = { ...previous, cognitive1: { overwatch: { enabled: true, model: 'old' } } };
    const incoming = { cognitive1: { overwatch: { enabled: false, model: 'new' } }, theme: 'light' };
    expect(reconcileSettingsDraft(draft, previous, incoming)).toEqual({ cognitive1: { overwatch: { enabled: true, model: 'new' } }, theme: 'light' });
  });
  it('accepts saved state and later remote changes after acknowledgement', () => {
    const previous = { enabled: false };
    const edited = { enabled: true };
    const acknowledged = reconcileSettingsDraft(edited, previous, edited);
    expect(acknowledged.enabled).toBe(true);
    expect(reconcileSettingsDraft(acknowledged, edited, { enabled: false }).enabled).toBe(false);
  });
});
