import {
  CLI_MODEL_SUGGESTIONS,
  DIRECT_PROVIDER_ORDER,
  architectSplitSchema,
  defaultArchitectSplit,
  directProviderPreset,
  isLocalProvider,
  isPlanningGradeModel,
  isPlanningGradeTarget,
  type AgentCapability,
  type AgentId,
  type ArchitectRole,
  type ArchitectSplit,
  type ProviderId,
  type RoleTarget,
} from '@kai/contracts';
import type { OptionMenuOption } from './ui/OptionMenu';

/**
 * What the composer remembers about the Architect / Implementer split.
 *
 * It follows the rule the composer's other choices follow: **a choice stays until the person changes it.** It is
 * kept three ways, and `splitFor` says who has the last word:
 *
 * 1. **This tab**, in this window — the person's own decision for this thread.
 * 2. **What the conversation's record says it ran with**, for a tab reopened from another window or a past session.
 * 3. **What this window used last**, so a new tab starts where the person left off rather than from nothing.
 */

export interface SplitStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const TABS_KEY = 'kai.architect.tabs';
const LAST_KEY = 'kai.architect.last';
/** A new, unsaved tab has no conversation yet; its choice lives under this key until one is created. */
export const NEW_TAB = 'new';

function scoped(key: string, windowId?: number): string {
  return windowId === undefined ? key : `${key}:window:${windowId}`;
}

function browserStorage(): SplitStorage | null {
  try {
    return window.localStorage;
  } catch {
    // A window with storage locked down keeps the choice in memory for the session instead.
    return null;
  }
}

function parseSplit(value: unknown): ArchitectSplit | undefined {
  const parsed = architectSplitSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function tabKeyFor(conversationId: string | null | undefined): string {
  return conversationId ?? NEW_TAB;
}

export function readStoredSplit(tab: string, windowId?: number, storage: SplitStorage | null = browserStorage()): ArchitectSplit | undefined {
  if (!storage) return undefined;
  try {
    const all = JSON.parse(storage.getItem(scoped(TABS_KEY, windowId)) ?? '{}') as Record<string, unknown>;
    return parseSplit(all[tab]);
  } catch {
    return undefined;
  }
}

export function writeStoredSplit(tab: string, split: ArchitectSplit, windowId?: number, storage: SplitStorage | null = browserStorage()): void {
  if (!storage) return;
  try {
    const key = scoped(TABS_KEY, windowId);
    const all = JSON.parse(storage.getItem(key) ?? '{}') as Record<string, unknown>;
    storage.setItem(key, JSON.stringify({ ...all, [tab]: split }));
    storage.setItem(scoped(LAST_KEY, windowId), JSON.stringify(split));
  } catch {
    // Remembering the choice is a convenience; the run itself carries the split it was started with.
  }
}

export function readLastSplit(windowId?: number, storage: SplitStorage | null = browserStorage()): ArchitectSplit | undefined {
  if (!storage) return undefined;
  try {
    return parseSplit(JSON.parse(storage.getItem(scoped(LAST_KEY, windowId)) ?? 'null'));
  } catch {
    return undefined;
  }
}

/** Moves a new tab's choice to its conversation once one exists, so it is not lost when the tab gets its id. */
export function adoptSplit(from: string, to: string, windowId?: number, storage: SplitStorage | null = browserStorage()): void {
  const split = readStoredSplit(from, windowId, storage);
  if (split && !readStoredSplit(to, windowId, storage)) writeStoredSplit(to, split, windowId, storage);
}

export function splitFor(input: {
  stored?: ArchitectSplit | undefined;
  recorded?: ArchitectSplit | undefined;
  last?: ArchitectSplit | undefined;
}): ArchitectSplit {
  return input.stored ?? input.recorded ?? input.last ?? defaultArchitectSplit();
}

// ---------------------------------------------------------------------------------------------------------------------
// The choices a role offers
// ---------------------------------------------------------------------------------------------------------------------

/** An API a role can use: one provider with one saved key, or a server on this computer. */
export interface ApiChoice {
  provider: ProviderId;
  credentialId: string;
  label: string;
  local: boolean;
  keySaved: boolean;
}

/**
 * Every API worth offering: a provider with a key saved for it (one entry per key, so two accounts of the same vendor
 * are two choices) and each server that runs on this computer. A provider with no key is left out rather than listed
 * as a dead end; the person adds keys in Settings.
 */
export function apiChoices(credentialIds: readonly string[], extra: readonly RoleTarget[] = []): ApiChoice[] {
  const saved = new Set(credentialIds);
  const choices: ApiChoice[] = [];
  for (const provider of DIRECT_PROVIDER_ORDER) {
    const preset = directProviderPreset(provider);
    const local = isLocalProvider(provider);
    if (local) {
      choices.push({ provider, credentialId: preset.credentialId, label: preset.displayName, local: true, keySaved: saved.has(preset.credentialId) });
      continue;
    }
    const ids = credentialIds.filter((id) => id === preset.credentialId || id.startsWith(`${preset.credentialId}.`) || id.startsWith(`${preset.credentialId}-`));
    for (const id of ids) {
      const suffix = id === preset.credentialId ? '' : ` (${id.slice(preset.credentialId.length + 1) || id})`;
      choices.push({ provider, credentialId: id, label: `${preset.displayName}${suffix}`, local: false, keySaved: true });
    }
  }
  // A role already set to something that is not in the list (its key was removed) stays visible, so it is never
  // silently swapped for another choice.
  for (const target of extra) {
    if (target.execution !== 'api' || !target.api) continue;
    const credentialId = target.api.credentialId ?? directProviderPreset(target.api.provider).credentialId;
    if (!choices.some((choice) => choice.provider === target.api!.provider && choice.credentialId === credentialId)) {
      choices.push({ provider: target.api.provider, credentialId, label: directProviderPreset(target.api.provider).displayName, local: isLocalProvider(target.api.provider), keySaved: false });
    }
  }
  return choices;
}

/** One menu value for a target: `cli:codex` or `api:anthropic:provider.anthropic`. Empty for no choice. */
export function targetValue(target: RoleTarget | null): string {
  if (!target) return '';
  if (target.execution === 'cli') return `cli:${target.agent ?? ''}`;
  const api = target.api;
  if (!api) return '';
  return `api:${api.provider}:${api.credentialId ?? directProviderPreset(api.provider).credentialId}`;
}

/** The target a menu value stands for, keeping the model already chosen when the same agent or API is picked again. */
export function targetFromValue(value: string, previous: RoleTarget | null): RoleTarget | null {
  if (value.startsWith('cli:')) {
    const agent = value.slice(4) as AgentId;
    if (previous?.execution === 'cli' && previous.agent === agent) return previous;
    return { execution: 'cli', agent };
  }
  if (value.startsWith('api:')) {
    const [, provider, ...rest] = value.split(':');
    const credentialId = rest.join(':');
    const providerId = provider as ProviderId;
    const preset = directProviderPreset(providerId);
    if (previous?.execution === 'api' && previous.api?.provider === providerId && (previous.api.credentialId ?? preset.credentialId) === credentialId) return previous;
    return {
      execution: 'api',
      api: { provider: providerId, ...(credentialId && credentialId !== preset.credentialId ? { credentialId } : {}) },
    };
  }
  return null;
}

export interface TargetOptionContext {
  capabilities: readonly AgentCapability[];
  credentialIds: readonly string[];
  /** Roles already chosen, so one that lost its key still shows. */
  current: readonly (RoleTarget | null)[];
}

/** A target with the model chosen for it. */
export function withModel(target: RoleTarget, model: string): RoleTarget {
  if (target.execution === 'cli') {
    const { model: _old, ...rest } = target;
    return model ? { ...rest, model } : rest;
  }
  const api = target.api!;
  const { model: _old, ...rest } = api;
  return { ...target, api: model ? { ...rest, model } : rest };
}

export function modelOf(target: RoleTarget | null): string {
  if (!target) return '';
  return target.execution === 'cli' ? (target.model ?? '') : (target.api?.model ?? '');
}

/**
 * The agents and APIs a role can be set to. For the Architect the models KAI thinks suit planning come first in each
 * group and say so; for the others the order is the app's usual one. It is guidance: nothing is hidden or blocked.
 */
export function targetOptions(role: ArchitectRole, context: TargetOptionContext): OptionMenuOption<string>[] {
  const options: OptionMenuOption<string>[] = [];
  const cli = [...context.capabilities];
  const api = apiChoices(context.credentialIds, context.current.filter((target): target is RoleTarget => target !== null));
  const planningFirst = role === 'architect' || role === 'fallback';

  const order = <T,>(items: T[], target: (item: T) => RoleTarget): T[] =>
    planningFirst ? [...items].sort((a, b) => Number(isPlanningGradeTarget(target(b))) - Number(isPlanningGradeTarget(target(a)))) : items;

  for (const capability of order(cli, (item) => ({ execution: 'cli', agent: item.id }))) {
    const target: RoleTarget = { execution: 'cli', agent: capability.id };
    const notes: string[] = [];
    if (planningFirst && isPlanningGradeTarget(target)) notes.push('Suited to planning');
    if (!capability.available) notes.push(capability.unavailableReason ?? `${capability.displayName} is not ready`);
    options.push({
      value: targetValue(target),
      label: capability.displayName,
      group: 'CLI agents',
      ...(notes.length ? { description: notes.join(' · ') } : {}),
    });
  }
  for (const choice of order(api, (item) => ({ execution: 'api', api: { provider: item.provider, credentialId: item.credentialId } }))) {
    const target: RoleTarget = { execution: 'api', api: { provider: choice.provider, credentialId: choice.credentialId } };
    const notes: string[] = [];
    if (planningFirst && isPlanningGradeTarget(target)) notes.push('Suited to planning');
    notes.push(choice.local ? 'Runs on this computer' : choice.keySaved ? 'Key saved' : 'No key saved');
    options.push({
      value: targetValue(target),
      label: choice.label,
      group: 'API and local models',
      description: notes.join(' · '),
    });
  }
  return options;
}

export const CUSTOM_ROLE_MODEL = '__custom__';

/**
 * The models a role's target offers. A CLI agent offers its own list; an API offers what the provider reported when it
 * could be asked, else the list KAI ships. For the Architect, the ones that suit planning are marked.
 */
export function roleModelOptions(role: ArchitectRole, target: RoleTarget | null, live: readonly string[] | undefined): OptionMenuOption<string>[] {
  if (!target) return [{ value: '', label: 'Default' }];
  const suggestions: readonly string[] = target.execution === 'cli'
    ? (target.agent && target.agent in CLI_MODEL_SUGGESTIONS ? CLI_MODEL_SUGGESTIONS[target.agent as keyof typeof CLI_MODEL_SUGGESTIONS] : [])
    : (live && live.length ? live : directProviderPreset(target.api!.provider).models);
  const current = modelOf(target);
  const known = new Set(suggestions);
  const planningFirst = role === 'architect' || role === 'fallback';
  const sorted = planningFirst
    ? [...suggestions].sort((a, b) => Number(isPlanningGradeModel(b)) - Number(isPlanningGradeModel(a)))
    : [...suggestions];
  const local = target.execution === 'api' && isLocalProvider(target.api!.provider);
  return [
    { value: '', label: local ? 'Whatever is loaded' : 'Default' },
    ...sorted.map((name): OptionMenuOption<string> => ({
      value: name,
      label: name,
      ...(planningFirst && isPlanningGradeModel(name) ? { description: 'Suited to planning' } : {}),
    })),
    ...(current && !known.has(current) ? [{ value: current, label: current } satisfies OptionMenuOption<string>] : []),
    { value: CUSTOM_ROLE_MODEL, label: 'Other model…' },
  ];
}

/** Sets one role. Turning the split on never invents roles: it stays "not chosen" until the person picks. */
export function withRole(split: ArchitectSplit, role: ArchitectRole, target: RoleTarget | null): ArchitectSplit {
  return { ...split, [role]: target };
}

/** Why the split cannot run yet, in a sentence for the composer, or null when it can. */
export function splitProblem(split: ArchitectSplit): string | null {
  if (!split.enabled) return null;
  if (!split.architect && !split.implementer) return 'Choose an Architect and an Implementer.';
  if (!split.architect) return 'Choose an Architect.';
  if (!split.implementer) return 'Choose an Implementer.';
  return null;
}

/**
 * A heads-up, never a block, about a pairing that tends to go badly: a weak model planning and reviewing, or a model on
 * this computer doing the building. Null when nothing stands out. The split still runs either way.
 */
export function pairingWarning(split: ArchitectSplit): string | null {
  if (!split.enabled || !split.architect || !split.implementer) return null;
  const notes: string[] = [];
  if (!isPlanningGradeTarget(split.architect)) notes.push('The Architect is not a model known for planning, so its briefs and reviews may be thin. A stronger one usually pays for itself here.');
  const builder = split.implementer;
  if (builder.execution === 'api' && builder.api && isLocalProvider(builder.api.provider)) {
    notes.push('The Implementer is a model on this computer. Those can loop on large tasks, so keep the task small and watch the first round.');
  }
  return notes.length ? notes.join(' ') : null;
}
