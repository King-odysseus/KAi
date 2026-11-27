import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Cloud, Cpu, History, LoaderCircle, Plus, SendHorizontal, ShieldCheck, Sparkles, X } from 'lucide-react';
import { Textarea } from 'flowbite-react';
import { describeRole } from './guided-build-engine';
import { promptDialog } from './AppDialog';
import { ContextPanel } from './Workspace';
import { BuildProgressPanel } from './BuildProgressPanel';
import { TabBar } from './ui/TabBar';
import { UiButton } from './UiButton';
import { Markdown } from './Markdown';
import { Composer, ComposerInput, ComposerSend, ComposerStop, ComposerToolbar } from './ui/Composer';
import { OptionMenu, type OptionMenuOption } from './ui/OptionMenu';
import { parseLeadIdeaProposal, type LeadIdeaProposal } from './lead-idea-proposal';
import type { ConversationRecord, RoleTarget } from '@kai/contracts';
import {
  leadExplanationFromReply,
  leadModelTier,
  leadQuestionText,
  leadTargetUnavailableReason,
  leadTaskFromReply,
  sameLeadTarget,
  selectLeadDefault,
  stableLeadTargetIdentity,
  targetFromLeadStorage,
  withDefaultLeadModel,
  type LeadModelInventory,
} from './lead-model-selection';

export interface LeadApprovalItem {
  conversationId: string;
  requestId: string;
  title: string;
  detail: string;
  risk: 'low' | 'medium' | 'high';
  tool?: string;
  runQuestion?: { continueLabel: string; finishLabel: string };
  options?: string[];
  allowFreeText?: boolean;
}

/** RightPane shows the ContextPanel's props through unchanged; it only adds a tab strip above them. */
type ContextProps = Parameters<typeof ContextPanel>[0];
type RightPaneProps = ContextProps & {
  selectLeadNonce?: number;
  leadConversation: ConversationRecord | null;
  leadConversations: ConversationRecord[];
  leadBuilderEnabled: boolean;
  onSelectLeadChat: (id: string) => void;
  onNewLeadChat: () => void;
  leadStreamingText: string;
  leadRunning: boolean;
  leadError: string | null;
  leadApprovals: LeadApprovalItem[];
  leadModelInventory: LeadModelInventory;
  leadSavedCoach: RoleTarget | null;
  leadComposerTarget: RoleTarget | null;
  onAskLead: (question: string, target: RoleTarget, openFileContext?: { path: string; content: string }) => void;
  onStopLead: () => void;
  onClearLeadError: () => void;
  onRespondLeadApproval: (requestId: string, approved: boolean, answer?: string) => void;
  onSendToBuilder: (task: string) => void;
  onReviewLeadIdea: (proposal: LeadIdeaProposal, choice: 'approve' | 'park') => void;
};

const STORAGE_KEY = 'kai.rightPane.tab';
type Tab = 'context' | 'build' | 'lead';

function useRightPaneTab(): [Tab, (next: Tab) => void] {
  const [tab, setTab] = useState<Tab>(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      return saved === 'build' || saved === 'lead' ? saved : 'context';
    } catch { return 'context'; }
  });
  const choose = useCallback((next: Tab) => {
    setTab(next);
    // A window with storage locked down keeps the choice in memory instead of failing the click.
    try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* memory only */ }
  }, []);
  return [tab, choose];
}

/**
 * The right pane: the project's context, and how far through its board the build is.
 *
 * Both panes stay mounted and the inactive one is hidden, because the Build tab is what knows a build is running — if
 * it unmounted whenever Context was showing, the marker telling the person to look would never appear.
 */
export function RightPane(props: RightPaneProps): ReactNode {
  const [tab, setTab] = useRightPaneTab();
  const [building, setBuilding] = useState(false);
  useEffect(() => { if (props.selectLeadNonce) setTab('lead'); }, [props.selectLeadNonce, setTab]);

  return (
    <aside className="context-panel">
      <TabBar
        label="Right pane"
        value={tab}
        onChange={setTab}
        className="!px-2"
        tabs={[
          { id: 'context', label: 'Context' },
          { id: 'build', label: <>Build{building ? <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-[var(--running)]" aria-label="a build is running" /> : null}</> },
          { id: 'lead', label: <>Lead{props.leadRunning ? <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-[var(--running)]" aria-label="Lead is replying" /> : null}</> },
        ]}
      />
      <div className="context-pane-body" role="tabpanel">
        <div className="context-pane" hidden={tab !== 'context'}>
          <ContextPanel {...props} />
        </div>
        <div className="context-pane" hidden={tab !== 'build'}>
          <BuildProgressPanel
            projectId={props.activeProject?.id ?? null}
            conversationId={props.conversation?.id ?? null}
            onBuildingChange={setBuilding}
          />
        </div>
        <div className="context-pane lead-context-pane" hidden={tab !== 'lead'}>
          <LeadConversationPanel
            projectName={props.activeProject?.name ?? 'No project'}
            projectId={props.activeProject?.id ?? null}
            conversation={props.leadConversation}
            conversations={props.leadConversations}
            builderEnabled={props.leadBuilderEnabled}
            onSelectConversation={props.onSelectLeadChat}
            onNewConversation={props.onNewLeadChat}
            streamingText={props.leadStreamingText}
            running={props.leadRunning}
            error={props.leadError}
            approvals={props.leadApprovals}
            inventory={props.leadModelInventory}
            savedCoach={props.leadSavedCoach}
            composerTarget={props.leadComposerTarget}
            onAsk={props.onAskLead}
            onStop={props.onStopLead}
            onClearError={props.onClearLeadError}
            onRespondApproval={props.onRespondLeadApproval}
            onSendToBuilder={props.onSendToBuilder}
            onReviewIdea={props.onReviewLeadIdea}
          />
        </div>
      </div>
    </aside>
  );
}

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

function readSelection(projectId: string, savedCoach: RoleTarget | null, composerTarget: RoleTarget | null): LeadSelection {
  try {
    const raw = window.localStorage.getItem(`kai.lead.selection.${projectId}`);
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

export function LeadConversationPanel({ projectName, projectId, conversation, conversations = [], builderEnabled = true, onSelectConversation, onNewConversation, streamingText, running, error, approvals, inventory, savedCoach, composerTarget = null, onAsk, onStop, onClearError, onRespondApproval, onSendToBuilder, onReviewIdea }: {
  projectName: string;
  projectId: string | null;
  conversation: ConversationRecord | null;
  conversations?: ConversationRecord[];
  builderEnabled?: boolean;
  onSelectConversation?: (id: string) => void;
  onNewConversation?: () => void;
  streamingText: string;
  running: boolean;
  error: string | null;
  approvals: LeadApprovalItem[];
  inventory: LeadModelInventory;
  savedCoach: RoleTarget | null;
  composerTarget?: RoleTarget | null;
  onAsk: (question: string, target: RoleTarget, openFileContext?: { path: string; content: string }) => void;
  onStop: () => void;
  onClearError: () => void;
  onRespondApproval: (requestId: string, approved: boolean, answer?: string) => void;
  onSendToBuilder: (task: string) => void;
  onReviewIdea: (proposal: LeadIdeaProposal, choice: 'approve' | 'park') => void;
}): ReactNode {
  const [message, setMessage] = useState('');
  const [selection, setSelection] = useState<LeadSelection>({ execution: '', providerOrAgent: '', model: '', target: null });
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    setMessage('');
    if (!conversation) return;
    try { setMessage(window.localStorage.getItem(`kai.lead.draft.${conversation.id}`) ?? ''); } catch { /* Keep draft in memory. */ }
  }, [conversation?.id]);


  useEffect(() => {
    if (!projectId) { setSelection({ execution: '', providerOrAgent: '', model: '', target: null }); return; }
    setSelection(readSelection(projectId, savedCoach, composerTarget));
  }, [projectId, savedCoach ? stableLeadTargetIdentity(savedCoach) : '', composerTarget ? stableLeadTargetIdentity(composerTarget) : '']);

  useEffect(() => {
    if (!projectId) return;
    const refresh = (): void => setSelection(readSelection(projectId, savedCoach, composerTarget));
    window.addEventListener('kai:lead-selection-change', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('kai:lead-selection-change', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, [projectId, savedCoach ? stableLeadTargetIdentity(savedCoach) : '', composerTarget ? stableLeadTargetIdentity(composerTarget) : '']);

  const saveSelection = (next: LeadSelection): void => {
    setSelection(next);
    if (!projectId) return;
    try {
      window.localStorage.setItem(`kai.lead.selection.${projectId}`, JSON.stringify({
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
        tier: leadModelTier({ execution: 'api', api: selectedApi }) === 'Local' ? 'Local' : 'Paid API',
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
    try {
      window.localStorage.setItem(`kai.lead.selection.${projectId}`, JSON.stringify({ identity: stableLeadTargetIdentity(resolved), target: resolved, execution: resolved.execution }));
    } catch { /* The visible model remains selected in memory. */ }
  }, [projectId, selection.target ? stableLeadTargetIdentity(selection.target) : '', modelInventoryKey]);
  const unavailableReason = selection.target ? leadTargetUnavailableReason(selection.target, inventory)
    : selection.execution === 'api' ? provider?.unavailableReason ?? null
      : selection.execution === 'cli' ? agent?.unavailableReason ?? null : null;
  const lastAssistant = [...(conversation?.turns ?? [])].reverse().find((turn) => turn.role === 'assistant');
  const questionText = lastAssistant ? leadQuestionText(lastAssistant.text, lastAssistant.awaitingAnswer === true) : null;

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

  const send = (): void => {
    const question = message;
    if (!question.trim() || !selection.target || unavailableReason || running) return;
    onAsk(question, selection.target);
    setMessage('');
    if (conversation) try { window.localStorage.removeItem(`kai.lead.draft.${conversation.id}`); } catch { /* Sending must not depend on draft storage. */ }
  };

  const replyToApproval = (approval: LeadApprovalItem, approved: boolean, answer?: string): void => {
    onRespondApproval(approval.requestId, approved, answer);
    setAnswerDrafts((current) => { const next = { ...current }; delete next[approval.requestId]; return next; });
  };

  const selectedLabel = selection.target
    ? `${leadModelTier(selection.target)} · ${describeRole(selection.target).label}`
    : 'choose a model';
  const savedCoachChoice = selection.target && savedCoach && sameLeadTarget(selection.target, savedCoach);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    const chrome = textarea.offsetHeight - textarea.clientHeight;
    const maxHeight = 200;
    textarea.style.height = `${Math.min(textarea.scrollHeight + chrome + 1, maxHeight)}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
    if (textarea.scrollHeight <= maxHeight) textarea.scrollTop = 0;
  }, [message]);

  const executionValue = selection.execution || '';
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
    ...(selection.model && !modelOptions.includes(selection.model) ? [{ value: selection.model, label: selection.model }] : []),
    ...modelOptions.map((model) => ({ value: model, label: model })),
    { value: '__custom__', label: 'Custom model…' },
  ];
  const modelTierLabel = selection.target && selection.model ? leadModelTier(selection.target) : null;

  return (
    <section className="lead-panel" aria-label="Lead chat">
      <header className="lead-head">
        <div className="lead-title-line"><strong>Lead · {projectName}</strong><span className="lead-readonly-label">Read-only</span>{modelTierLabel && <span className="lead-tier-label" title={selectedLabel}>{modelTierLabel}{savedCoachChoice ? ' · Coach' : ''}</span>}
          <div className="lead-chat-actions">
            {conversations.length > 0 && <OptionMenu ariaLabel="Lead chat history" icon={<History size={13} />} labelPrefix="History" value={conversation?.id ?? ''} title="Open a saved Lead chat" onChange={(id) => onSelectConversation?.(id)} options={conversations.map((item, index) => ({ value: item.id, label: item.title && item.title !== 'Lead' ? item.title : `Lead chat ${conversations.length - index}`, description: new Date(item.updatedAt).toLocaleString() }))} />}
            <UiButton type="button" className="icon-button compact" aria-label="New Lead chat" title="New Lead chat" disabled={!projectId} onClick={onNewConversation}><Plus size={15} /></UiButton>
          </div>
        </div>
      </header>
      <div className="lead-transcript" aria-live="polite">
        {error && <div className="lead-error" role="alert"><AlertTriangle size={15} /><span>{error}</span><UiButton type="button" className="icon-button compact" aria-label="Dismiss Lead error" onClick={onClearError}><X size={13} /></UiButton></div>}
        {questionText && <div className="lead-question" role="status"><strong>Lead has a question for you</strong><p>{questionText}</p><small>Reply below to continue this conversation.</small></div>}
        {approvals.map((approval) => (
          <section className="lead-approval" key={approval.requestId} aria-label={approval.options ? 'Lead question' : 'Lead approval request'}>
            <div className="lead-approval-title">{approval.options ? <AlertTriangle size={15} /> : <ShieldCheck size={15} />}<strong>{approval.title}</strong><span className={`risk-badge ${approval.risk}`}>{approval.risk} risk</span></div>
            {approval.tool && <code>{approval.tool}</code>}
            <p>{approval.detail}</p>
            {approval.options?.map((option) => <UiButton key={option} type="button" className="secondary-button" disabled={running} onClick={() => replyToApproval(approval, true, option)}>{option}</UiButton>)}
            {approval.runQuestion && <div className="lead-approval-actions"><UiButton type="button" className="secondary-button" onClick={() => replyToApproval(approval, false)}>{approval.runQuestion.finishLabel}</UiButton><UiButton type="button" className="primary-button" onClick={() => replyToApproval(approval, true)}>{approval.runQuestion.continueLabel}</UiButton></div>}
            {approval.options && approval.allowFreeText && <div className="lead-approval-actions"><Textarea aria-label="Your answer to the Lead" value={answerDrafts[approval.requestId] ?? ''} onChange={(event) => setAnswerDrafts((current) => ({ ...current, [approval.requestId]: event.target.value }))} /><UiButton type="button" className="primary-button" disabled={!(answerDrafts[approval.requestId] ?? '').trim()} onClick={() => replyToApproval(approval, true, (answerDrafts[approval.requestId] ?? '').trim())}>Send answer</UiButton></div>}
            {!approval.options && !approval.runQuestion && <div className="lead-approval-actions"><UiButton type="button" className="secondary-button" onClick={() => replyToApproval(approval, false)}>Deny</UiButton><UiButton type="button" className="primary-button" onClick={() => replyToApproval(approval, true)}>Approve once</UiButton></div>}
          </section>
        ))}
        {!conversation?.turns.length && !running && <p className="lead-empty">Ask about this project's code, why it works this way, or a small change you are considering.</p>}
        {(conversation?.turns ?? []).map((turn) => (
          <article className={`lead-turn ${turn.role}`} key={turn.id}>
            <span className="lead-turn-label">{turn.role === 'assistant' ? 'Lead' : 'You'}</span>
            {turn.role === 'assistant' ? parseLeadIdeaProposal(turn.text)
              ? <LeadIdeaProposalCard proposal={parseLeadIdeaProposal(turn.text)!} onReview={onReviewIdea} onChange={(message) => setMessage(message)} />
              : <Markdown text={leadExplanationFromReply(turn.text)} /> : <p>{turn.text}</p>}
            {turn.role === 'assistant' && leadTaskFromReply(turn.text) && <div className="lead-builder-task"><strong>Builder task</strong><p>{leadTaskFromReply(turn.text)}</p><UiButton type="button" className="secondary-button lead-send-builder" disabled={!builderEnabled} title={builderEnabled ? 'Put this task in the Builder composer' : 'Enable Lead & Builder in the main composer options first'} onClick={() => onSendToBuilder(leadTaskFromReply(turn.text)!)}><SendHorizontal size={13} /><span>{builderEnabled ? 'Send task to Builder' : 'Builder is off'}</span></UiButton></div>}
          </article>
        ))}
        {streamingText && <article className="lead-turn assistant streaming"><span className="lead-turn-label">Lead · {selectedLabel}</span><Markdown text={streamingText} /></article>}
        {running && !streamingText && <div className="lead-thinking"><LoaderCircle size={14} className="animate-spin" /> Thinking…</div>}
      </div>
      <form className="lead-compose" onSubmit={(event) => { event.preventDefault(); send(); }}>
        <Composer className="lead-composer">
          <ComposerInput ref={inputRef} rows={1} aria-label={questionText ? 'Answer the Lead' : 'Ask the Lead'} placeholder={questionText ? 'Answer the Lead’s question…' : 'Ask the Lead…'} value={message} disabled={!projectId || running || !selection.target || Boolean(unavailableReason)} onChange={(event) => {
            const value = event.target.value;
            setMessage(value);
            if (conversation) try {
              if (value) window.localStorage.setItem(`kai.lead.draft.${conversation.id}`, value);
              else window.localStorage.removeItem(`kai.lead.draft.${conversation.id}`);
            } catch { /* Keep draft in memory if storage is unavailable. */ }
          }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } }} />
          <ComposerToolbar leading={<>
            <OptionMenu ariaLabel="Lead runs on" disabled={!projectId || running} icon={executionValue === 'api' ? <Cloud size={13} /> : <Cpu size={13} />} labelPrefix={selection.execution ? undefined : 'Runs on'} onChange={(value) => changeExecution(value)} options={runsOnOptions} title="Choose API or CLI for the Lead" value={executionValue} />
            <OptionMenu ariaLabel={`Lead ${selection.execution === 'api' ? 'provider' : 'agent'}`} disabled={!projectId || running || !selection.execution} icon={<Cpu size={13} />} labelPrefix={selection.execution === 'api' ? 'Provider' : 'Agent'} onChange={(value) => selection.execution === 'api' ? changeProvider(value) : changeAgent(value)} options={providerOptions.length ? providerOptions : [{ value: '', label: selection.execution ? 'None configured' : 'Choose API or CLI', disabled: true }]} title={unavailableReason ?? `Choose a Lead ${selection.execution === 'api' ? 'provider' : 'agent'}`} value={selection.providerOrAgent} />
            <OptionMenu ariaLabel="Lead model" disabled={!projectId || running || !selection.execution || !selection.providerOrAgent} icon={<Sparkles size={13} />} labelPrefix="Model" onChange={(value) => {
              if (value !== '__custom__') { changeModel(value); return; }
              void promptDialog({ title: 'Use a custom Lead model', label: 'Model name', initialValue: selection.model, placeholder: 'provider/model-name' }).then((typed) => { if (typed?.trim()) changeModel(typed.trim()); });
            }} options={modelMenuOptions} title={unavailableReason ?? 'Choose a model for the Lead'} value={selection.execution === 'cli' && selection.target?.execution === 'cli' && !selection.target.model ? '__agent_default__' : selection.model} />
          </>} actions={running ? <ComposerStop onClick={onStop} label="Stop Lead reply" /> : <ComposerSend label="Ask Lead" title="Ask the Lead" submit disabled={!projectId || !message.trim() || !selection.target || Boolean(unavailableReason)} />} />
          {unavailableReason && <small className="lead-model-hint" role="status">{unavailableReason}</small>}
          {!selection.target && !unavailableReason && <small className="lead-model-hint" role="status">Choose a provider or agent and model to ask the Lead.</small>}
        </Composer>
      </form>
    </section>
  );
}

function LeadIdeaProposalCard({ proposal, onReview, onChange }: {
  proposal: LeadIdeaProposal;
  onReview: (proposal: LeadIdeaProposal, choice: 'approve' | 'park') => void;
  onChange: (message: string) => void;
}): ReactNode {
  return (
    <section className="lead-idea-proposal" aria-label="Lead idea proposal">
      <strong>{proposal.title}</strong>
      <p>{proposal.summary}</p>
      <div><b>Why</b><p>{proposal.why}</p></div>
      <div><b>How</b><p>{proposal.how}</p></div>
      {proposal.risks.length > 0 && <div><b>Risks</b><ul>{proposal.risks.map((risk, index) => <li key={index}>{risk}</li>)}</ul></div>}
      <div><b>Simpler option</b><p>{proposal.simplerOption}</p></div>
      <div><b>What you’ll learn</b><p>{proposal.learning}</p></div>
      {proposal.questions.length > 0 && <div className="lead-idea-questions"><b>Questions ({proposal.questions.length}/3)</b><ol>{proposal.questions.map((question, index) => <li key={index}>{question}</li>)}</ol></div>}
      {proposal.conflicts.length > 0 && <div className="lead-idea-conflicts"><b>Decision conflicts</b><ul>{proposal.conflicts.map((conflict, index) => <li key={index}>{conflict}</li>)}</ul></div>}
      {proposal.steps.length > 0 && <div><b>Plan steps</b><ol>{proposal.steps.map((step, index) => <li key={`${step.title}-${index}`}><strong>{step.title}</strong><p>{step.why}</p><small>Edit: {step.filesToEdit.join(', ')}{step.filesToRead.length ? ` · Read: ${step.filesToRead.join(', ')}` : ''}</small><ul>{step.doneChecks.map((check, checkIndex) => <li key={checkIndex}>{check}</li>)}</ul><code>{step.checkCommand}</code></li>)}</ol></div>}
      <div className="lead-idea-exact-changes"><b>Exact proposed additions</b><h4>.kai/spec/ideas.md</h4><pre>{proposal.ideaRecord}</pre>
        {proposal.status === 'proposal' && <><h4>.kai/spec/decisions.md</h4><pre>{proposal.decisionRecord}</pre>
          {proposal.goalOrScopeChanged && <><h4>.kai/spec/brief.md · scope update</h4><pre>{proposal.briefScopeUpdate}</pre></>}
          <h4>Plan source · {proposal.planTitle}</h4><pre>{proposal.steps.map((step, index) => `${index + 1}. ${step.title}\n   Why: ${step.why}\n   Files: ${step.filesToEdit.join(', ')}\n   Change: ${step.instructions}\n   Done: ${step.doneChecks.join('; ')}\n   Check: ${step.checkCommand}`).join('\n\n')}</pre></>}
      </div>
      {proposal.status !== 'questions' && <div className="lead-idea-actions">
        <UiButton type="button" className="primary-button" aria-label="Approve this Lead proposal" onClick={() => onReview(proposal, 'approve')}>Approve</UiButton>
        <UiButton type="button" className="secondary-button" aria-label="Ask the Lead to change this proposal" onClick={() => onChange(`Please revise this idea proposal. Keep the agreed goal and existing decisions.\n\nWhat I want changed: `)}>Change</UiButton>
        <UiButton type="button" className="secondary-button" aria-label="Park this idea" onClick={() => onReview(proposal, 'park')}>Park</UiButton>
      </div>}
    </section>
  );
}
