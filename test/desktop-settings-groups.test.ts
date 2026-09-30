import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../packages/contracts/src';
import { changedGroups, SETTINGS_GROUP_NAMES, updateForGroups } from '../apps/desktop/src/renderer/src/components/settings-groups';

describe('per-card settings saves', () => {
  it('reports nothing to save when the draft matches what is stored', () => {
    const settings = createDefaultSettings();
    expect(changedGroups(settings, createDefaultSettings())).toEqual([]);
  });

  it('points at the card that changed and leaves every other card alone', () => {
    const saved = createDefaultSettings();
    expect(changedGroups({ ...saved, theme: 'purple' }, saved)).toEqual(['agentDefaults']);
    expect(changedGroups({ ...saved, shortcuts: { ...saved.shortcuts } }, saved)).toEqual([]);
    expect(changedGroups({ ...saved, editor: { ...saved.editor, autoSave: false } }, saved)).toEqual(['editor']);
    expect(changedGroups({ ...saved, proxy: { ...saved.proxy, enabled: true, port: 8083 } }, saved)).toEqual(['proxy']);
    expect(changedGroups({ ...saved, cognitive1: { ...saved.cognitive1, endpoint: 'http://127.0.0.1:9999' } }, saved)).toEqual(['cognitive1']);
  });

  it('sends only the fields of the cards being saved', () => {
    const draft = { ...createDefaultSettings(), proxy: { ...createDefaultSettings().proxy, port: 8083 } };
    const update = updateForGroups(draft, ['proxy']);
    expect(Object.keys(update)).toEqual(['proxy']);
    expect(update.proxy?.port).toBe(8083);
    expect(update).not.toHaveProperty('cognitive1');
    expect(update).not.toHaveProperty('theme');
  });

  it('merges several cards into one update, and saves everything when asked for every group', () => {
    const draft = createDefaultSettings();
    expect(Object.keys(updateForGroups(draft, ['proxy', 'editor'])).sort()).toEqual(['editor', 'proxy']);
    expect(Object.keys(updateForGroups(draft, SETTINGS_GROUP_NAMES)).sort()).toEqual([
      'agentModels', 'agentTeam', 'autoModel', 'cognitive1', 'defaultAgent', 'defaultAutonomy', 'defaultRoute', 'diagnosticsEnabled',
      'directApi', 'editor', 'experienceCapture', 'learningTutor', 'logRetentionEntries', 'mcpServers', 'notifications', 'promptGuide', 'proxy',
      'shortcuts', 'theme',
    ]);
  });

  it('saves the agent team on its own card without touching the other cards', () => {
    const saved = createDefaultSettings();
    const draft = { ...saved, agentTeam: { ...saved.agentTeam, preset: 'budget' as const } };

    expect(changedGroups(draft, saved)).toEqual(['agentTeam']);
    expect(updateForGroups(draft, ['agentTeam'])).toEqual({ agentTeam: draft.agentTeam });
    // Editing a role's key order alone is not a change.
    const reordered = { ...saved, agentTeam: { custom: saved.agentTeam.custom, roles: saved.agentTeam.roles, preset: saved.agentTeam.preset } };
    expect(changedGroups(reordered, saved)).toEqual([]);
  });

  it('does not read a rebuilt settings refresh as an unsaved change', () => {
    const saved = createDefaultSettings();
    // A refresh arrives with the same notifications, written with its keys in a different order.
    const incoming = {
      ...saved,
      notifications: {
        onBudget: saved.notifications.onBudget,
        onFailure: saved.notifications.onFailure,
        trayEnabled: saved.notifications.trayEnabled,
        onComplete: saved.notifications.onComplete,
        onApproval: saved.notifications.onApproval,
      },
    };
    expect(changedGroups(incoming, saved)).toEqual([]);
    expect(changedGroups({ ...incoming, agentModels: { codex: 'gpt-6-astra' } }, saved)).toEqual(['agentDefaults']);
  });
});
