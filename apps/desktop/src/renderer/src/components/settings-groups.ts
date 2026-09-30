import type { AppSettings, SettingsUpdate } from '@kai/contracts';

/**
 * Settings are saved one card at a time. Each group lists the fields that card owns, so its Save button writes
 * only what that card changed: untouched services are not restarted, and an unrelated card cannot be saved by
 * accident. The whole set is still saveable at once from the bar at the top of the page.
 */
export const SETTINGS_GROUPS = {
  agentTeam: ['agentTeam'],
  agentDefaults: ['defaultAgent', 'defaultRoute', 'defaultAutonomy', 'theme', 'logRetentionEntries', 'diagnosticsEnabled', 'notifications', 'agentModels', 'autoModel'],
  editor: ['editor'],
  shortcuts: ['shortcuts'],
  learningTutor: ['learningTutor'],
  experienceCapture: ['experienceCapture'],
  promptGuide: ['promptGuide'],
  directApi: ['directApi'],
  mcpServers: ['mcpServers'],
  cognitive1: ['cognitive1'],
  proxy: ['proxy'],
} as const satisfies Record<string, readonly (keyof SettingsUpdate)[]>;

export type SettingsGroup = keyof typeof SETTINGS_GROUPS;

export const SETTINGS_GROUP_NAMES = Object.keys(SETTINGS_GROUPS) as SettingsGroup[];

/** The cards whose fields differ from what is saved, in the order their fields are declared. */
export function changedGroups(draft: AppSettings, saved: AppSettings, groups: readonly SettingsGroup[] = SETTINGS_GROUP_NAMES): SettingsGroup[] {
  return groups.filter((group) => SETTINGS_GROUPS[group].some((key) => !sameValue(draft[key], saved[key])));
}

/** The update to send for those cards, and nothing else. */
export function updateForGroups(draft: AppSettings, groups: readonly SettingsGroup[]): SettingsUpdate {
  const update: Record<string, unknown> = {};
  for (const group of groups) {
    for (const key of SETTINGS_GROUPS[group]) update[key] = draft[key];
  }
  return update as SettingsUpdate;
}

/**
 * Field-level comparison. Key order is ignored because an incoming settings refresh rebuilds nested objects in
 * the order they arrived, which must not read as "the user changed something".
 */
function sameValue(left: unknown, right: unknown): boolean {
  return stable(left) === stable(right);
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
  });
}
