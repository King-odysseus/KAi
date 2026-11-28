import { useEffect, useMemo, useState } from 'react';
import { Cloud, Cpu, Sparkles } from 'lucide-react';
import type { RoleTarget } from '@kai/contracts';
import { OptionMenu, type OptionMenuOption } from './ui/OptionMenu';
import { promptDialog } from './AppDialog';
import { leadModelTier, leadTargetUnavailableReason, selectLeadDefault, stableLeadTargetIdentity, targetFromLeadStorage, withDefaultLeadModel, type LeadModelInventory } from './lead-model-selection';

interface LeadSelection {
  execution: 'api' | 'cli' | '';
  providerOrAgent: string;
  model: string;
  target: RoleTarget | null;
}

function selectionForTarget(target: RoleTarget | null): LeadSelection {
  if (!target) return { execution: '', providerOrAgent: '', model: '', target: null };
  if (target.execution === 'cli') return {
    execution: 'cli', providerOrAgent: target.agent ?? '', model: target.model ?? '', target,
  };
  const credential = target.api?.credentialId ?? '';
  return {
    execution: 'api',
    providerOrAgent: `${target.api?.provider ?? ''}:${credential}`,
    model: target.api?.model ?? '',
    target,
  };
}

export function readSelection(projectId: string, savedCoach: RoleTarget | null, composerTarget: RoleTarget | null, storagePrefix = 'kai.lead.selection'): LeadSelection {
  try {
    const raw = window.localStorage.getItem(`${storagePrefix}.${projectId}`);
    if (raw) {
      const stored = JSON.parse(raw) as { identity?: unknown; target?: unknown; execution?: unknown };
      const target = targetFromLeadStorage(stored.target ? JSON.stringify(stored.target) : null);
      if (target && stored.identity === stableLeadTargetIdentity(target)) return selectionForTarget(target);
      if ((stored.execution === 'api' || stored.execution === 'cli') && !target) {
        return { execution: stored.execution, providerOrAgent: '', model: '', target: null };
      }
    }
  } catch { /* Fall back to the saved Coach, then the visible composer model. */ }
  return selectionForTarget(selectLeadDefault(null, savedCoach ?? composerTarget));
}

export function useLeadModelSelection({ projectId, inventory, savedCoach, composerTarget = null, storagePrefix = 'kai.lead.selection', onTargetChange }: { projectId: string | null; inventory: LeadModelInventory; savedCoach: RoleTarget | null; composerTarget?: RoleTarget | null; storagePrefix?: string; onTargetChange?: (target: RoleTarget | null) => void }) {
  const [selection, setSelection] = useState<LeadSelection>({ execution: '', providerOrAgent: '', model: '', target: null });
  useEffect(() => {
    if (!projectId) { setSelection({ execution: '', providerOrAgent: '', model: '', target: null }); return; }
    setSelection(readSelection(projectId, savedCoach, composerTarget, storagePrefix));
  }, [projectId, savedCoach ? stableLeadTargetIdentity(savedCoach) : '', composerTarget ? stableLeadTargetIdentity(composerTarget) : '']);

  useEffect(() => {
    if (!projectId) return;
    const refresh = (): void => setSelection(readSelection(projectId, savedCoach, composerTarget, storagePrefix));
    window.addEventListener('kai:lead-selection-change', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('kai:lead-selection-change', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, [projectId, savedCoach ? stableLeadTargetIdentity(savedCoach) : '', composerTarget ? stableLeadTargetIdentity(composerTarget) : '']);

  const saveSelection = (next: LeadSelection): void => {
    setSelection(next);
    onTargetChange?.(next.target);
    if (!projectId) return;
    try {
      window.localStorage.setItem(`${storagePrefix}.${projectId}`, JSON.stringify({
        identity: next.target ? stableLeadTargetIdentity(next.target) : null,
        target: next.target,
        execution: next.execution,
      }));
      window.dispatchEvent(new Event('kai:lead-selection-change'));
    } catch { /* Keep the choice in memory if storage is locked down. */ }
  };

  const apiProviders = useMemo(() => {
    const providers = [...inventory.apiProviders];
    const selectedApi = selection.target?.execution === 'api' ? selection.target.api : undefined;
    if (selectedApi && !providers.some((item) => item.provider === selectedApi.provider
      && (!selectedApi.credentialId || item.credentialId === selectedApi.credentialId))) {
      providers.push({
        provider: selectedApi.provider,
        credentialId: selectedApi.credentialId ?? '',
        label: selectedApi.provider,
        tier: leadModelTier({ execution: 'api', api: selectedApi }, inventory) === 'Local' ? 'Local' : 'Paid API',
        available: false,
        unavailableReason: 'This saved provider is no longer configured. Reconfigure it in Settings.',
        models: selectedApi.model ? [selectedApi.model] : [],
        defaultModel: selectedApi.model ?? '',
        ...(selectedApi.baseUrl ? { baseUrl: selectedApi.baseUrl } : {}),
      });
    }
    return providers;
  }, [inventory.apiProviders, selection.target]);
  const cliAgents = useMemo(() => {
    const agents = [...inventory.cliAgents];
    if (selection.target?.execution === 'cli' && !agents.some((item) => item.agent === selection.target?.agent)) {
      agents.push({
        agent: selection.target.agent!, label: selection.target.agent!, tier: 'Subscription', available: false,
        unavailableReason: 'This saved agent is no longer installed or signed in.',
        models: selection.target.model ? [selection.target.model] : [],
      });
    }
    return agents;
  }, [inventory.cliAgents, selection.target]);
  const provider = selection.execution === 'api'
    ? apiProviders.find((item) => `${item.provider}:${item.credentialId}` === selection.providerOrAgent) : undefined;
  const agent = selection.execution === 'cli'
    ? cliAgents.find((item) => item.agent === selection.providerOrAgent) : undefined;
  const modelOptions = selection.execution === 'api' ? provider?.models ?? [] : agent?.models ?? [];
  const modelInventoryKey = JSON.stringify([
    inventory.apiProviders.map((item) => [item.provider, item.credentialId, item.defaultModel, item.models]),
    inventory.cliAgents.map((item) => [item.agent, item.models]),
  ]);
  useEffect(() => {
    if (!projectId || !selection.target) return;
    const resolved = withDefaultLeadModel(selection.target, inventory);
    if (!resolved || stableLeadTargetIdentity(resolved) === stableLeadTargetIdentity(selection.target)) return;
    const next = selectionForTarget(resolved);
    setSelection(next);
    onTargetChange?.(next.target);
    try {
      window.localStorage.setItem(`${storagePrefix}.${projectId}`, JSON.stringify({ identity: stableLeadTargetIdentity(resolved), target: resolved, execution: resolved.execution }));
    } catch { /* The visible model remains selected in memory. */ }
  }, [projectId, selection.target ? stableLeadTargetIdentity(selection.target) : '', modelInventoryKey]);
  const unavailableReason = selection.target ? leadTargetUnavailableReason(selection.target, inventory)
    : selection.execution === 'api' ? provider?.unavailableReason ?? null
      : selection.execution === 'cli' ? agent?.unavailableReason ?? null : null;
  const changeExecution = (execution: 'api' | 'cli' | ''): void => {
    saveSelection({ execution, providerOrAgent: '', model: '', target: null });
  };
  const runsOnOptions: OptionMenuOption<LeadSelection['execution']>[] = [
    { value: '', label: 'Choose API or CLI', disabled: true },
    { value: 'api', label: 'API', description: 'Paid API or local endpoint' },
    { value: 'cli', label: 'CLI', description: 'Subscription agent' },
  ];
  const changeProvider = (value: string): void => {
    const choice = apiProviders.find((item) => `${item.provider}:${item.credentialId}` === value);
    if (!choice) return;
    const target: RoleTarget = { execution: 'api', api: {
      provider: choice.provider,
      ...(choice.credentialId ? { credentialId: choice.credentialId } : {}),
      ...(choice.baseUrl ? { baseUrl: choice.baseUrl } : {}),
      ...(choice.defaultModel ? { model: choice.defaultModel } : {}),
    } };
    saveSelection({ execution: 'api', providerOrAgent: value, model: choice.defaultModel, target });
  };
  const changeAgent = (agentId: string): void => {
    const choice = cliAgents.find((item) => item.agent === agentId);
    if (!choice) return;
    const target: RoleTarget = { execution: 'cli', agent: choice.agent };
    saveSelection({ execution: 'cli', providerOrAgent: agentId, model: '', target });
  };
  const changeModel = (model: string): void => {
    if (selection.execution === 'api' && provider) {
      const target: RoleTarget = { execution: 'api', api: {
        provider: provider.provider,
        credentialId: provider.credentialId,
        ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
        ...(model ? { model } : {}),
      } };
      saveSelection({ ...selection, model, target });
    } else if (selection.execution === 'cli' && agent) {
      const selectedModel = model === '__agent_default__' ? '' : model;
      const target: RoleTarget = { execution: 'cli', agent: agent.agent, ...(selectedModel ? { model: selectedModel } : {}) };
      saveSelection({ ...selection, model: selectedModel, target });
    }
  };

  const executionValue: LeadSelection['execution'] = selection.execution || '';
  const providerOptions: OptionMenuOption<string>[] = selection.execution === 'api'
    ? apiProviders.map((item) => ({
      value: `${item.provider}:${item.credentialId}`,
      label: item.label,
      description: `${item.tier}${item.available ? '' : ` · unavailable: ${item.unavailableReason ?? 'not configured'}`}`,
      disabled: !item.available,
    }))
    : cliAgents.map((item) => ({
      value: item.agent,
      label: item.label,
      description: `Subscription${item.available ? '' : ` · unavailable: ${item.unavailableReason ?? 'not installed'}`}`,
      disabled: !item.available,
    }));
  if (selection.execution) providerOptions.unshift({ value: '', label: selection.execution === 'api' ? 'Choose provider' : 'Choose agent', disabled: true });
  const modelMenuOptions: OptionMenuOption<string>[] = [
    { value: '', label: selection.execution ? 'Choose a model' : 'Choose where it runs', disabled: true },
    ...(selection.execution === 'cli' && agent ? [{ value: '__agent_default__', label: 'Agent default', description: `Use the default model configured for ${agent.label}` }] : []),
    ...(selection.model && !modelOptions.includes(selection.model)
      && !(inventory.gatewayOwnHardware && provider?.provider === 'openai-compatible' && selection.model.toLowerCase() === 'gateway/auto')
      ? [{ value: selection.model, label: selection.model }]
      : []),
    ...modelOptions.map((model) => ({ value: model, label: model })),
    { value: '__custom__', label: 'Custom model…' },
  ];
  const modelTierLabel = selection.target && selection.model
    ? provider?.tier ?? leadModelTier(selection.target, inventory)
    : null;

  return { selection, unavailableReason, modelTierLabel, executionValue, runsOnOptions, providerOptions, modelMenuOptions, changeExecution, changeProvider, changeAgent, changeModel };
}

export function LeadModelControls({ picker, disabled, label = 'Lead' }: { picker: ReturnType<typeof useLeadModelSelection>; disabled: boolean; label?: string }) {
  const { selection, unavailableReason, executionValue, runsOnOptions, providerOptions, modelMenuOptions, changeExecution, changeProvider, changeAgent, changeModel } = picker;
  const projectId = !disabled;
  const running = disabled;
  return <>
            <OptionMenu ariaLabel={`${label} runs on`} disabled={!projectId || running} icon={executionValue === 'api' ? <Cloud size={13} /> : <Cpu size={13} />} labelPrefix={selection.execution ? undefined : 'Runs on'} onChange={(value) => changeExecution(value)} options={runsOnOptions} title="Choose API or CLI for the Lead" value={executionValue} />
            <OptionMenu ariaLabel={`${label} ${selection.execution === 'api' ? 'provider' : 'agent'}`} disabled={!projectId || running || !selection.execution} icon={<Cpu size={13} />} labelPrefix={selection.execution === 'api' ? 'Provider' : 'Agent'} onChange={(value) => selection.execution === 'api' ? changeProvider(value) : changeAgent(value)} options={providerOptions.length ? providerOptions : [{ value: '', label: selection.execution ? 'None configured' : 'Choose API or CLI', disabled: true }]} title={unavailableReason ?? `Choose a Lead ${selection.execution === 'api' ? 'provider' : 'agent'}`} value={selection.providerOrAgent} />
            <OptionMenu ariaLabel={`${label} model`} disabled={!projectId || running || !selection.execution || !selection.providerOrAgent} icon={<Sparkles size={13} />} labelPrefix="Model" onChange={(value) => {
              if (value !== '__custom__') { changeModel(value); return; }
              void promptDialog({ title: `Use a custom ${label} model`, label: 'Model name', initialValue: selection.model, placeholder: 'provider/model-name' }).then((typed) => { if (typed?.trim()) changeModel(typed.trim()); });
            }} options={modelMenuOptions} title={unavailableReason ?? 'Choose a model for the Lead'} value={selection.execution === 'cli' && selection.target?.execution === 'cli' && !selection.target.model ? '__agent_default__' : selection.model} />
  </>;
}
