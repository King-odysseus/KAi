import { LeadModelControls, useLeadModelSelection } from './LeadModelControls';
import { LeadReviewSettings } from './LeadReviewSettings';
import { LeadAccessControl, LeadEditCard, leadAccessLabel } from './LeadEditControls';
import { stripLeadEdit, hasLeadEdit } from './lead-edit-prompt';
import { leadRecoveryPrompt } from './lead-recovery';
import { LeadTaskCard } from './LeadTaskCard';
import { LeadHandoffControl } from './LeadHandoffControl';
import { leadHandoffMode, runnableLeadTask, type LeadHandoffMode } from './lead-handoff';
import { LeadRunLinks } from './LeadRunLinks';
import type { LeadHandoff } from './lead-delivery';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowLeft, History, LoaderCircle, Plus, ShieldCheck, X } from 'lucide-react';
import { Textarea } from 'flowbite-react';
import { describeRole } from './guided-build-engine';
import { ContextPanel } from './Workspace';
import { BuildProgressPanel } from './BuildProgressPanel';
import { TabBar } from './ui/TabBar';
import { UiButton } from './UiButton';
import { Markdown } from './Markdown';
import { Composer, ComposerInput, ComposerSend, ComposerStop, ComposerToolbar } from './ui/Composer';
import { parseLeadIdeaProposal, type LeadIdeaProposal } from './lead-idea-proposal';
import type { ConversationRecord, RoleTarget, LeadDeliverySettings, LeadAccess } from '@kai/contracts';
import {
  leadExplanationFromReply,
  leadModelTier,
  leadQuestionText,
  leadTaskFromReply,
  sameLeadTarget,
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
  builderConversations?: ConversationRecord[];
  onOpenBuilder?: (id: string) => void;
  onReviewBuilder?: (id: string, handoff: LeadHandoff, target: RoleTarget) => Promise<void>;
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
  onChangeLeadHandoffMode?: (mode: LeadHandoffMode) => Promise<void>;
  onChangeLeadAccess?: (mode: LeadAccess) => Promise<void>;
  onDecideLeadEdit?: (id: string, action: 'approve' | 'reject' | 'refresh') => Promise<void>;
  onStartLeadBuilder?: (turnId: string) => Promise<void>;
  onSaveLeadReviewSettings?: (settings: LeadDeliverySettings) => Promise<void>;
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
  const paneRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!props.selectLeadNonce) return;
    setTab('lead');
    const frame = requestAnimationFrame(() => paneRef.current?.querySelector('.lead-run-links')?.scrollIntoView({ block: 'end' }));
    return () => cancelAnimationFrame(frame);
  }, [props.selectLeadNonce, setTab]);

  return (
    <aside className="context-panel" ref={paneRef}>
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
            builderConversations={props.builderConversations}
            onOpenBuilder={props.onOpenBuilder}
            onReviewBuilder={props.onReviewBuilder}
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
            onChangeHandoffMode={props.onChangeLeadHandoffMode}
            onChangeAccess={props.onChangeLeadAccess}
            onDecideEdit={props.onDecideLeadEdit}
            onStartBuilder={props.onStartLeadBuilder}
            onSaveReviewSettings={props.onSaveLeadReviewSettings}
            onReviewIdea={props.onReviewLeadIdea}
          />
        </div>
      </div>
    </aside>
  );
}

export function LeadConversationPanel({ projectName, projectId, conversation, conversations = [], builderEnabled = true, onSelectConversation, onNewConversation, streamingText, running, error, approvals, inventory, savedCoach, composerTarget = null, builderConversations = [], onOpenBuilder, onReviewBuilder, onAsk, onStop, onClearError, onRespondApproval, onSendToBuilder, onChangeHandoffMode, onChangeAccess, onDecideEdit, onStartBuilder, onSaveReviewSettings, onReviewIdea }: {
  builderConversations?: ConversationRecord[];
  onOpenBuilder?: (id: string) => void;
  onReviewBuilder?: (id: string, handoff: LeadHandoff, target: RoleTarget) => Promise<void>;
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
  onChangeHandoffMode?: (mode: LeadHandoffMode) => Promise<void>;
  onChangeAccess?: (mode: LeadAccess) => Promise<void>;
  onDecideEdit?: (id: string, action: 'approve' | 'reject' | 'refresh') => Promise<void>;
  onStartBuilder?: (turnId: string) => Promise<void>;
  onSaveReviewSettings?: (settings: LeadDeliverySettings) => Promise<void>;
  onReviewIdea: (proposal: LeadIdeaProposal, choice: 'approve' | 'park') => void;
}): ReactNode {
  const [message, setMessage] = useState('');
  const picker = useLeadModelSelection({ projectId, inventory, savedCoach, composerTarget });
  const { selection, unavailableReason, modelTierLabel } = picker;
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => { setHistoryOpen(false); }, [projectId]);

  useEffect(() => {
    setMessage('');
    if (!conversation) return;
    try { setMessage(window.localStorage.getItem(`kai.lead.draft.${conversation.id}`) ?? ''); } catch { /* Keep draft in memory. */ }
  }, [conversation?.id]);


  const lastAssistant = [...(conversation?.turns ?? [])].reverse().find((turn) => turn.role === 'assistant');
  const questionText = lastAssistant ? leadQuestionText(lastAssistant.text, lastAssistant.awaitingAnswer === true) : null;
  const latestQuestion = [...(conversation?.turns ?? [])].reverse().find((turn) => turn.role === 'user');
  const recordedReads = [...new Set((conversation?.events ?? []).flatMap((event) => {
    if (event.type !== 'tool.call' || event.name !== 'read_file' || event.status !== 'completed' || (latestQuestion && event.timestamp < latestQuestion.createdAt)) return [];
    const path = event.input && typeof event.input === 'object' ? (event.input as { path?: unknown }).path : null;
    return typeof path === 'string' ? [path] : [];
  }))];

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
    ? `${leadModelTier(selection.target, inventory)} · ${describeRole(selection.target, {}, inventory).label}`
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

  if (historyOpen) return <section className="lead-panel" aria-label="Lead chat history page">
    <header className="lead-head lead-history-head">
      <UiButton type="button" className="icon-button compact" aria-label="Back to Lead chat" onClick={() => setHistoryOpen(false)}><ArrowLeft size={15} /></UiButton>
      <strong>Lead chat history</strong>
      <UiButton type="button" className="icon-button compact" aria-label="New Lead chat" title="New Lead chat" disabled={!projectId} onClick={() => { setHistoryOpen(false); onNewConversation?.(); }}><Plus size={15} /></UiButton>
    </header>
    <div className="lead-history-list">
      {conversations.length === 0 ? <p className="lead-empty">No saved Lead chats yet.</p> : conversations.map((item, index) => <UiButton key={item.id} type="button" className="lead-history-item" aria-current={item.id === conversation?.id ? 'true' : undefined} onClick={() => { onSelectConversation?.(item.id); setHistoryOpen(false); }}>
        <strong>{item.title && item.title !== 'Lead' ? item.title : `Lead chat ${conversations.length - index}`}</strong>
        <span>{new Date(item.updatedAt).toLocaleString()}{item.id === conversation?.id ? ' · Current' : ''}</span><span>{[...item.turns].reverse().find((turn) => turn.role === 'user')?.text.split('\n')[0]?.slice(0, 140)}</span>
      </UiButton>)}
    </div>
  </section>;

  return (
    <section className="lead-panel" aria-label="Lead chat">
      <header className="lead-head">
        <div className="lead-title-line"><strong>Lead · Discuss and plan · {projectName}</strong><span className="lead-readonly-label">{leadAccessLabel(conversation?.leadAccess ?? 'read-only')}</span>{modelTierLabel && <span className="lead-tier-label" title={selectedLabel}>{modelTierLabel}{savedCoachChoice ? ' · Coach' : ''}</span>}
          <div className="lead-chat-actions">
            <UiButton type="button" className="icon-button compact" aria-label="Lead chat history" title="Open Lead chat history" disabled={!projectId} onClick={() => setHistoryOpen(true)}><History size={15} /></UiButton>
            <UiButton type="button" className="icon-button compact" aria-label="New Lead chat" title="New Lead chat" disabled={!projectId} onClick={onNewConversation}><Plus size={15} /></UiButton>
          </div>
        </div>
      </header>
      <div className="lead-handoff-controls" role="group" aria-label="Lead controls">
        <LeadHandoffControl key={conversation?.id ?? 'new'} mode={leadHandoffMode(conversation)} disabled={!conversation || !projectId} onChange={onChangeHandoffMode} />
        <LeadAccessControl key={`access-${conversation?.id ?? 'new'}`} access={conversation?.leadAccess ?? 'read-only'} disabled={!conversation || !projectId || running} onChange={onChangeAccess} />
      </div>
      <div className="lead-transcript" aria-live="polite">
        {conversation && <LeadReviewSettings key={conversation.id} conversation={conversation} inventory={inventory} disabled={running} onSave={onSaveReviewSettings} />}
        {conversation?.leadContext && <details className="lead-context-used"><summary>Latest request context supplied</summary><small>{new Date(conversation.leadContext.suppliedAt).toLocaleString()}. Additional tool reads may appear in the reply.</small><strong>Included context</strong><ul>{conversation.leadContext.included.map((path) => <li key={path}>{path}</li>)}</ul>{conversation.leadContext.omitted.length > 0 && <><strong>Omitted sections</strong><ul>{conversation.leadContext.omitted.map((path) => <li key={path}>{path}</li>)}</ul></>}{conversation.leadContext.unavailable.length > 0 && <><strong>Unavailable files</strong><ul>{conversation.leadContext.unavailable.map((path) => <li key={path}>{path}</li>)}</ul></>}</details>}
        {recordedReads.length > 0 && <details className="lead-context-used"><summary>Recorded file reads ({recordedReads.length})</summary><ul>{recordedReads.map((path) => <li key={path}>{path}</li>)}</ul></details>}
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
            <span className="lead-turn-label">{turn.role === 'assistant' ? conversation?.leadReviewTurnIds?.includes(turn.id) ? 'Reviewer' : 'Lead' : conversation?.leadGeneratedTurns?.some((item) => item.id === turn.id) ? 'KAI' : 'You'}</span>
            {turn.role === 'assistant' ? parseLeadIdeaProposal(turn.text)
              ? <LeadIdeaProposalCard proposal={parseLeadIdeaProposal(turn.text)!} onReview={onReviewIdea} onChange={(message) => setMessage(message)} />
              : <Markdown text={stripLeadEdit(leadExplanationFromReply(turn.text).replace(/LEAD_RESULT_REVIEW\s*\n[\s\S]*?\nEND_LEAD_RESULT_REVIEW/g, ''))} /> : conversation?.leadGeneratedTurns?.some((item) => item.id === turn.id) ? <details><summary>{conversation.leadGeneratedTurns.find((item) => item.id === turn.id)!.label}</summary><Markdown text={turn.text} /></details> : <p>{turn.text}</p>}
            {conversation?.leadEditProposals?.filter((proposal) => proposal.turnId === turn.id).map((proposal) => <LeadEditCard key={proposal.id} proposal={proposal} disabled={running || (conversation.leadAccess ?? 'read-only') === 'read-only'} onDecide={onDecideEdit} />)}
            {turn.role === 'assistant' && !hasLeadEdit(turn.text) && !parseLeadIdeaProposal(turn.text) && leadTaskFromReply(turn.text) && <LeadTaskCard task={leadTaskFromReply(turn.text)!} builderEnabled={builderEnabled} onSend={onSendToBuilder} onChange={setMessage} mode={conversation?.leadRecoveryTurnIds?.includes(turn.id) ? leadHandoffMode(conversation) === 'discuss' ? 'discuss' : 'ask' : leadHandoffMode(conversation)} canStart={!running && Boolean(runnableLeadTask(conversation!, turn.id))} sent={conversation?.leadDispatchedTurnIds?.includes(turn.id)} onStart={onStartBuilder ? () => onStartBuilder(turn.id) : undefined} />}
          </article>
        ))}
        {streamingText && <article className="lead-turn assistant streaming"><span className="lead-turn-label">{conversation?.leadReplyRole?.role === 'reviewer' ? 'Reviewer' : 'Lead'} · {conversation?.leadReplyRole ? describeRole(conversation.leadReplyRole.target, {}, inventory).label : selectedLabel}</span><Markdown text={streamingText} /></article>}
        {conversation && <LeadRunLinks leadId={conversation.id} conversations={builderConversations} target={selection.target} reviewerTarget={conversation.leadDeliverySettings?.reviewer ?? null} inventory={inventory} running={running} onOpen={onOpenBuilder} onReview={onReviewBuilder} onRecovery={unavailableReason ? undefined : (builder, handoff, target) => onAsk(leadRecoveryPrompt(builder, handoff), target)} />}
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
            <LeadModelControls picker={picker} disabled={!projectId || running} />
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
