import {
  CLI_MODEL_SUGGESTIONS,
  directProviderPreset,
  isLocalProvider,
  type AgentCapability,
  type AppSettings,
  type ProviderId,
  type RoleTarget,
} from '@kai/contracts';
import { apiChoices } from './architect-settings';
import { describeRole } from './guided-build-engine';

export interface LeadApiProviderChoice {
  provider: ProviderId;
  credentialId: string;
  label: string;
  tier: 'Local' | 'Paid API';
  available: boolean;
  unavailableReason?: string;
  models: string[];
  defaultModel: string;
  baseUrl?: string;
}

export interface LeadCliAgentChoice {
  agent: AgentCapability['id'];
  label: string;
  tier: 'Subscription';
  available: boolean;
  unavailableReason?: string;
  models: string[];
}

export interface LeadModelInventory {
  apiProviders: LeadApiProviderChoice[];
  cliAgents: LeadCliAgentChoice[];
}

export function stableLeadTargetIdentity(target: RoleTarget): string {
  if (target.execution === 'cli') return JSON.stringify(['cli', target.agent ?? '', target.model ?? '']);
  const api = target.api;
  if (!api) return JSON.stringify(['api', '', '', '', '']);
  return JSON.stringify(['api', api.provider, api.credentialId ?? '', api.baseUrl ?? '', api.model ?? '']);
}

export function sameLeadTarget(left: RoleTarget | null | undefined, right: RoleTarget | null | undefined): boolean {
  return Boolean(left && right && stableLeadTargetIdentity(left) === stableLeadTargetIdentity(right));
}

export function targetFromLeadStorage(value: string | null): RoleTarget | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return null;
    const target = parsed as RoleTarget;
    if (target.execution === 'cli' && typeof target.agent === 'string') return target;
    if (target.execution === 'api' && target.api && typeof target.api.provider === 'string') return target;
  } catch { /* A corrupt per-project choice falls back to the saved Coach. */ }
  return null;
}

export function leadModelTier(target: RoleTarget): 'Local' | 'Paid API' | 'Subscription' {
  return target.execution === 'cli' ? 'Subscription' : describeRole(target).local ? 'Local' : 'Paid API';
}

export function buildLeadModelInventory(input: {
  settings: Pick<AppSettings, 'directApi' | 'savedLocalModels' | 'agentModels'>;
  credentialIds: readonly string[];
  agents: readonly Pick<AgentCapability, 'id' | 'displayName' | 'available' | 'unavailableReason'>[];
  directApiStatus?: { provider: ProviderId; available: boolean; reason?: string } | null;
  savedCoach?: RoleTarget | null;
}): LeadModelInventory {
  const currentApi: RoleTarget = {
    execution: 'api',
    api: {
      provider: input.settings.directApi.provider,
      baseUrl: input.settings.directApi.baseUrl,
      credentialId: input.settings.directApi.credentialId,
      model: input.settings.directApi.model,
    },
  };
  const configured = apiChoices(input.credentialIds, [currentApi, ...(input.savedCoach ? [input.savedCoach] : [])]);
  const apiProviders = configured.map((choice): LeadApiProviderChoice => {
    const preset = directProviderPreset(choice.provider);
    const local = isLocalProvider(choice.provider);
    const sameDirectConnection = choice.provider === input.settings.directApi.provider
      && choice.credentialId === input.settings.directApi.credentialId;
    const sameCoachConnection = input.savedCoach?.execution === 'api'
      && input.savedCoach.api?.provider === choice.provider
      && (input.savedCoach.api.credentialId ?? preset.credentialId) === choice.credentialId;
    const savedModels = input.settings.savedLocalModels[choice.provider] ?? [];
    const models = [...new Set([
      ...preset.models,
      ...savedModels,
      ...(sameDirectConnection && input.settings.directApi.model ? [input.settings.directApi.model] : []),
      ...(sameCoachConnection && input.savedCoach?.execution === 'api' && input.savedCoach.api?.model ? [input.savedCoach.api.model] : []),
    ])];
    const defaultModel = sameDirectConnection && input.settings.directApi.model
      ? input.settings.directApi.model
      : sameCoachConnection && input.savedCoach?.execution === 'api' && input.savedCoach.api?.model
        ? input.savedCoach.api.model
        : local ? savedModels[0] ?? preset.defaultModel ?? '' : preset.defaultModel ?? '';
    const status = input.directApiStatus?.provider === choice.provider ? input.directApiStatus : null;
    const available = status ? status.available : local ? savedModels.length > 0 : choice.keySaved;
    const unavailableReason = status && !status.available
      ? status.reason || `${preset.displayName} is not responding.`
      : !choice.keySaved && !local
        ? `No API key is saved for ${choice.label}. Add one in Settings to use this provider.`
        : local && savedModels.length === 0 && !sameDirectConnection && !sameCoachConnection
          ? `No models are saved for ${preset.displayName}. Start its local service and refresh models in Settings.`
          : undefined;
    const baseUrl = sameDirectConnection ? input.settings.directApi.baseUrl
      : sameCoachConnection && input.savedCoach?.execution === 'api' ? input.savedCoach.api?.baseUrl : undefined;
    return {
      provider: choice.provider,
      credentialId: choice.credentialId,
      label: choice.label,
      tier: local ? 'Local' : 'Paid API',
      available,
      ...(unavailableReason ? { unavailableReason } : {}),
      models,
      defaultModel,
      ...(baseUrl ? { baseUrl } : {}),
    };
  });
  const configuredAgents = [...input.agents];
  if (input.savedCoach?.execution === 'cli' && !configuredAgents.some((agent) => agent.id === input.savedCoach!.agent)) {
    configuredAgents.push({ id: input.savedCoach.agent!, displayName: input.savedCoach.agent!, available: false, unavailableReason: 'The saved Coach agent is no longer available.' });
  }
  const cliAgents = configuredAgents.map((agent): LeadCliAgentChoice => {
    const models = agent.id in CLI_MODEL_SUGGESTIONS
      ? [...CLI_MODEL_SUGGESTIONS[agent.id as keyof typeof CLI_MODEL_SUGGESTIONS]]
      : [];
    const savedModel = input.settings.agentModels[agent.id];
    if (savedModel && !models.includes(savedModel)) models.unshift(savedModel);
    if (input.savedCoach?.execution === 'cli' && input.savedCoach.agent === agent.id && input.savedCoach.model && !models.includes(input.savedCoach.model)) models.unshift(input.savedCoach.model);
    return {
      agent: agent.id,
      label: agent.displayName,
      tier: 'Subscription',
      available: agent.available,
      ...(!agent.available ? { unavailableReason: agent.unavailableReason || `${agent.displayName} is not available.` } : {}),
      models,
    };
  });
  return { apiProviders, cliAgents };
}

export function leadTargetUnavailableReason(target: RoleTarget, inventory: LeadModelInventory): string | null {
  if (target.execution === 'cli') {
    const agent = inventory.cliAgents.find((item) => item.agent === target.agent);
    return agent?.available ? null : agent?.unavailableReason ?? `The saved agent ${target.agent ?? ''} is unavailable.`;
  }
  const api = target.api;
  if (!api) return 'Choose an API provider.';
  const provider = inventory.apiProviders.find((item) => item.provider === api.provider
    && (!api.credentialId || item.credentialId === api.credentialId));
  return provider?.available ? null : provider?.unavailableReason ?? `The saved provider ${api.provider} is unavailable.`;
}

export function leadTaskFromReply(text: string): string | null {
  const match = /^\s*BUILDER TASK:\s*\n?([\s\S]*?)\s*$/im.exec(text);
  const task = match?.[1]?.trim();
  return task && !/^none\b/i.test(task) ? task : null;
}

export function leadExplanationFromReply(text: string): string {
  const marker = /^\s*BUILDER TASK:\s*\n?/im.exec(text);
  return marker ? text.slice(0, marker.index).trim() : text.trim();
}

export function leadQuestionText(text: string, awaitingAnswer: boolean): string | null {
  return awaitingAnswer && text.trim() ? text : null;
}

export function shouldConfirmLeadDraftReplacement(draft: string, task: string): boolean {
  return Boolean(draft.trim() && draft.trim() !== task.trim());
}

export function hasLocalBuilderRun(input: {
  conversations: readonly { id: string; guidedBuild?: { builderTarget?: RoleTarget | null } }[];
  runningConversationIds: readonly string[];
  targetForConversation: (conversationId: string) => RoleTarget | null;
}): boolean {
  const running = new Set(input.runningConversationIds);
  return input.conversations.some((conversation) => {
    if (!running.has(conversation.id)) return false;
    const target = conversation.guidedBuild?.builderTarget ?? input.targetForConversation(conversation.id);
    return Boolean(target && leadModelTier(target) === 'Local');
  });
}

export function selectLeadDefault(persisted: RoleTarget | null, savedCoach: RoleTarget | null): RoleTarget | null {
  return persisted ?? savedCoach;
}

/** Make a saved role's implicit model concrete so the UI never displays a blank model selector. */
export function withDefaultLeadModel(target: RoleTarget | null, inventory: LeadModelInventory): RoleTarget | null {
  if (!target) return null;
  if (target.execution === 'api' && target.api && !target.api.model) {
    const provider = inventory.apiProviders.find((item) => item.provider === target.api!.provider
      && (!target.api!.credentialId || item.credentialId === target.api!.credentialId));
    const model = provider?.defaultModel || provider?.models[0];
    return model ? { ...target, api: { ...target.api, model } } : target;
  }
  // Keep CLI's native default explicit in the picker instead of guessing a model.
  return target;
}

export function leadTaskHistory(turns: readonly { role: string; text: string }[]): Array<{ role: string; text: string }> {
  return turns.map((turn) => ({ ...turn }));
}
