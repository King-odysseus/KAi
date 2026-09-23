import {
  ChevronDown,
  Check,
  Circle,
  Cloud,
  Cpu,
  ExternalLink,
  FileDiff,
  FolderOpen,
  LogIn,
  RefreshCw,
  Route,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
} from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type {
  AgentCapability,
  AgentId,
  AppSettings,
  AutonomyMode,
  ConversationRecord,
  ContextPreview,
  DirectApiCapability,
  ExecutionMode,
  ProjectRecord,
  RouteMode,
  ServiceState,
} from '@kai/contracts';
import { relativeTime, statusLabel } from '../types';

export function WorkspaceView({ activeProject, activeConversation, settings, busy, running, notice, streamingText, pendingApproval, agentCapabilities, directApiCapability, selectedAgent, executionMode, selectedRoute, selectedAutonomy, proxyReady, onSelectExecution, onSelectAgent, onSelectRoute, onSelectAutonomy, onChooseProject, onCreateConversation, onSend, onCancel, onApprovalResponse, onSignIn, onRefreshAgents, onOpenSettings }: {
  activeProject: ProjectRecord | null;
  activeConversation: ConversationRecord | null;
  settings: AppSettings;
  busy: boolean;
  running: boolean;
  notice: string | null;
  streamingText: string;
  pendingApproval: {
    requestId: string;
    title: string;
    detail: string;
    risk: 'low' | 'medium' | 'high';
    tool?: string;
  } | null;
  agentCapabilities: AgentCapability[];
  directApiCapability: DirectApiCapability | null;
  selectedAgent: AgentId;
  executionMode: ExecutionMode;
  selectedRoute: RouteMode;
  selectedAutonomy: AutonomyMode;
  proxyReady: boolean;
  onSelectExecution: (mode: ExecutionMode) => void;
  onSelectAgent: (agent: AgentId) => void;
  onSelectRoute: (route: RouteMode) => void;
  onSelectAutonomy: (autonomy: AutonomyMode) => void;
  onChooseProject: () => void;
  onCreateConversation: (prompt: string) => void;
  onSend: (prompt: string) => void;
  onCancel: () => void;
  onApprovalResponse: (approved: boolean) => void;
  onSignIn: (agent: AgentId) => void;
  onRefreshAgents: () => void;
  onOpenSettings: () => void;
}): ReactNode {
  const [prompt, setPrompt] = useState('');
  const selectedCapability = agentCapabilities.find((agent) => agent.id === selectedAgent);
  const apiRun = executionMode === 'api';
  const ready = apiRun ? Boolean(directApiCapability?.available) : Boolean(selectedCapability?.available);
  const unavailableReason = apiRun
    ? directApiCapability?.unavailableReason ?? 'Direct API status is unavailable.'
    : selectedCapability?.unavailableReason ?? 'No agent CLI is available.';
  const send = (): void => {
    const text = prompt.trim();
    if (!text || !activeProject || busy || !ready) return;
    setPrompt('');
    if (activeConversation) onSend(text);
    else onCreateConversation(text);
  };
  return (
    <div className="workspace-view">
      <div className="workspace-header">
        <div><span className="eyebrow">{activeConversation ? 'Conversation' : 'Workspace'}</span><h1>{activeConversation?.title ?? activeProject?.name ?? 'Open a project'}</h1></div>
        <div className="workspace-status">
          <span className={`status-pill ${ready ? 'ready' : 'unavailable'}`}><Circle size={7} fill="currentColor" /> {apiRun ? 'API' : 'CLI'} {ready ? 'ready' : 'unavailable'}</span>
          <span className="status-pill lavender"><Sparkles size={13} /> {apiRun ? directApiCapability?.model || directApiCapability?.displayName || 'Direct API' : selectedCapability?.version ?? selectedCapability?.displayName ?? selectedAgent}</span>
        </div>
      </div>

      {pendingApproval && (
        <div className="approval-overlay">
          <section className="approval-dialog" role="dialog" aria-modal="true" aria-labelledby="approval-title">
            <div className="approval-dialog-head">
              <ShieldCheck size={20} />
              <div><span className="eyebrow">Project approval</span><h2 id="approval-title">{pendingApproval.title}</h2></div>
              <span className={`risk-badge ${pendingApproval.risk}`}>{pendingApproval.risk} risk</span>
            </div>
            {pendingApproval.tool && <code className="approval-tool">{pendingApproval.tool}</code>}
            <pre className="approval-detail">{pendingApproval.detail}</pre>
            <div className="approval-dialog-actions">
              <button type="button" className="secondary-button" onClick={() => onApprovalResponse(false)}>Deny</button>
              <button type="button" className="primary-button" onClick={() => onApprovalResponse(true)}>Allow once</button>
            </div>
          </section>
        </div>
      )}

      <div className="conversation-canvas">
        {activeConversation?.turns.length || streamingText ? (
          <>
            {activeConversation?.turns.map((turn) => (
              <article key={turn.id} className={`message ${turn.role}`}><div className="message-role">{turn.role === 'user' ? 'You' : 'KAI'}</div><div className="message-body">{turn.text}</div></article>
            ))}
            {streamingText && <article className="message assistant streaming"><div className="message-role">KAI</div><div className="message-body">{streamingText}</div></article>}
          </>
        ) : (
          <div className="workspace-empty">
            <div className="empty-symbol">{apiRun ? <Cloud size={26} /> : <Cpu size={26} />}</div>
            <h2>{activeProject ? 'Start with a concrete task' : 'Choose a project to begin'}</h2>
            <p>{activeProject ? ready ? apiRun ? 'Ask the direct API model to inspect or change the project. File changes require approval.' : 'Ask KAI to inspect, change, or explain the project.' : unavailableReason : 'KAI keeps project files and local state on this machine.'}</p>
            {!activeProject && <button type="button" className="primary-button" onClick={onChooseProject}><FolderOpen size={16} /><span>Open project</span></button>}
          </div>
        )}
      </div>

      <div className="composer">
        {activeProject && !ready && (apiRun ? directApiCapability : selectedCapability) && (
          <div className="agent-setup-banner" role="status">
            <div className="agent-setup-copy">
              <strong>{apiRun ? 'API setup required' : setupTitle(selectedCapability!)}</strong>
              <span>{notice ?? unavailableReason}</span>
            </div>
            <div className="agent-setup-actions">
              {!apiRun && selectedCapability?.state === 'signed_out' && (
                <button type="button" className="secondary-button" onClick={() => onSignIn(selectedAgent)} disabled={busy}>
                  <LogIn size={14} />
                  <span>Sign in</span>
                </button>
              )}
              {apiRun ? (
                <button type="button" className="secondary-button" onClick={onOpenSettings} disabled={busy}>
                  <Settings2 size={14} />
                  <span>Configure API</span>
                </button>
              ) : (
                <a className="secondary-button" href={selectedCapability!.installUrl} target="_blank" rel="noreferrer">
                  <ExternalLink size={14} />
                  <span>Install guide</span>
                </a>
              )}
              <button type="button" className="secondary-button" onClick={onRefreshAgents} disabled={busy}>
                <RefreshCw size={14} />
                <span>Refresh status</span>
              </button>
            </div>
          </div>
        )}
        <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } }} placeholder={ready ? apiRun ? 'Ask the configured API model' : 'Ask KAI to inspect, change, or explain code' : unavailableReason} aria-label="Task prompt" disabled={!activeProject || busy || !ready} />
        <div className="composer-toolbar">
          <div className="composer-controls">
            <div className="mode-toggle" role="group" aria-label="Execution mode">
              <button type="button" className={!apiRun ? 'active' : ''} aria-pressed={!apiRun} onClick={() => onSelectExecution('cli')} disabled={busy}><Cpu size={14} /><span>CLI</span></button>
              <button type="button" className={apiRun ? 'active' : ''} aria-pressed={apiRun} onClick={() => onSelectExecution('api')} disabled={busy}><Cloud size={14} /><span>API</span></button>
            </div>
            {apiRun ? (
              <button type="button" className="chip-button api-provider-chip" title="Configure the direct API provider" onClick={onOpenSettings} disabled={busy}>
                <Cloud size={14} />
                <span className="truncate">{selectedRoute === 'proxy'
                  ? `Proxy${settings.proxy.defaultModel ? ` · ${settings.proxy.defaultModel}` : ''}`
                  : `${directApiCapability?.displayName || 'Direct API'}${directApiCapability?.model ? ` · ${directApiCapability.model}` : ''}`}</span>
              </button>
            ) : (
              <SelectMenu
                ariaLabel="Agent"
                className={`agent-select ${ready ? '' : 'unavailable'}`}
                disabled={busy}
                icon={<Cpu size={14} />}
                onChange={onSelectAgent}
                options={agentCapabilities.map((agent) => ({
                  value: agent.id,
                  label: `${agent.displayName}${setupSuffix(agent)}`,
                }))}
                title={selectedCapability?.unavailableReason}
                value={selectedAgent}
              />
            )}
            <SelectMenu
              ariaLabel="Route"
              className={`control-select route-select ${apiRun && selectedRoute === 'proxy' && !proxyReady ? 'unavailable' : ''}`}
              disabled={busy || !apiRun}
              icon={<Route size={14} />}
              onChange={onSelectRoute}
              options={[
                { value: 'direct', label: 'Direct' },
                { value: 'proxy', label: proxyReady ? 'Proxy' : 'Proxy (not ready)', disabled: !apiRun || !proxyReady },
              ]}
              title={apiRun ? proxyReady ? 'Choose the direct provider route or KAI Universal Proxy route' : 'Start Universal Proxy in Settings to use the proxy route' : 'CLI agents currently use direct routing'}
              value={apiRun ? selectedRoute : 'direct'}
            />
            <SelectMenu
              ariaLabel="Autonomy"
              className="control-select autonomy-select"
              disabled={busy}
              icon={<ShieldCheck size={14} />}
              onChange={onSelectAutonomy}
              options={[
                { value: 'plan', label: 'Plan' },
                { value: 'ask', label: 'Ask' },
                { value: 'autoEdit', label: 'Auto-edit' },
                { value: 'full', label: 'Full control' },
                { value: 'custom', label: 'Custom' },
              ]}
              title="Choose how much project access the active run has"
              value={selectedAutonomy}
            />
          </div>
          {running ? (
            <button type="button" className="send-button stop-button" onClick={onCancel} title="Stop agent" aria-label="Stop agent"><Square size={13} fill="currentColor" /></button>
          ) : (
            <button type="button" className="send-button" disabled={!activeProject || !prompt.trim() || busy || !ready} onClick={send} title={activeConversation ? 'Send message' : 'Start conversation'} aria-label={activeConversation ? 'Send message' : 'Start conversation'}><Send size={16} /></button>
          )}
        </div>
      </div>
    </div>
  );
}

interface SelectMenuOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

function SelectMenu<T extends string>({ ariaLabel, className = '', disabled = false, icon, onChange, options, title, value }: {
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  icon: ReactNode;
  onChange: (value: T) => void;
  options: readonly SelectMenuOption<T>[];
  title?: string;
  value: T;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selectedOption = options[selectedIndex];

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const focusTimer = window.setTimeout(() => optionRefs.current[selectedIndex]?.focus(), 0);
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open, selectedIndex]);

  const choose = (option: SelectMenuOption<T>): void => {
    if (option.disabled) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const moveFocus = (currentIndex: number, direction: 1 | -1): void => {
    for (let offset = 1; offset <= options.length; offset += 1) {
      const nextIndex = (currentIndex + direction * offset + options.length) % options.length;
      if (!options[nextIndex]?.disabled) {
        optionRefs.current[nextIndex]?.focus();
        return;
      }
    }
  };

  const focusEdge = (fromStart: boolean): void => {
    const indexes = options.map((_, index) => index);
    if (!fromStart) indexes.reverse();
    for (const index of indexes) {
      if (options[index]?.disabled) continue;
      optionRefs.current[index]?.focus();
      return;
    }
  };

  const handleOptionKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveFocus(index, 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocus(index, -1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusEdge(true);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusEdge(false);
    }
  };

  return (
    <div ref={rootRef} className={`chip-button select-menu ${className} ${disabled ? 'disabled' : ''}`.trim()}>
      <button
        ref={triggerRef}
        type="button"
        className="select-menu-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        title={title}
      >
        {icon}
        <span className="select-menu-value truncate">{selectedOption?.label ?? value}</span>
        <ChevronDown className="select-menu-chevron" size={12} />
      </button>
      {open && (
        <div className="select-menu-popover" role="listbox" aria-label={ariaLabel}>
          {options.map((option, index) => (
            <button
              ref={(element) => { optionRefs.current[index] = element; }}
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`select-menu-option ${option.value === value ? 'selected' : ''}`.trim()}
              disabled={option.disabled}
              onClick={() => choose(option)}
              onKeyDown={(event) => handleOptionKeyDown(event, index)}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={13} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function setupTitle(capability: AgentCapability): string {
  if (capability.state === 'signed_out') return 'Sign in required';
  if (capability.state === 'not_installed') return 'Install required';
  return 'Agent unavailable';
}

function setupSuffix(capability: AgentCapability): string {
  if (capability.available) return '';
  if (capability.state === 'signed_out') return ' (sign-in required)';
  if (capability.state === 'not_installed') return ' (not installed)';
  return ' (unavailable)';
}

export function ContextPanel({ activeProject, conversation, services, contextPreview, contextPreviewLoading }: { activeProject: ProjectRecord | null; conversation: ConversationRecord | null; services: ServiceState[]; contextPreview: ContextPreview | null; contextPreviewLoading: boolean }): ReactNode {
  return (
    <aside className="context-panel">
      <div className="context-heading"><div><span className="eyebrow">Context</span><h2>{activeProject?.name ?? 'No project'}</h2></div><FileDiff size={17} /></div>
      <div className="context-meter">
        <span>Estimated direct API context</span>
        <strong>{contextPreviewLoading ? 'Calculating...' : contextPreview ? `~${formatCompact(contextPreview.estimatedTokens)} tokens` : 'Unavailable'}</strong>
        <small>{contextPreview ? `${formatCompact(contextPreview.totalCharacters)} characters across ${contextPreview.sections.reduce((sum, section) => sum + section.items.length, 0)} item(s)` : 'Open a project to preview context.'}</small>
      </div>
      {(contextPreview?.sections ?? []).map((section) => (
        <div className="context-section" key={section.kind}>
          <div className="context-label">{contextSectionIcon(section.kind)}<span>{section.label}</span><small>~{formatCompact(section.estimatedTokens)}</small></div>
          {section.items.length > 0 ? (
            <div className="context-item-list">
              {section.items.map((item) => (
                <div className="context-item" key={`${item.kind}:${item.source ?? item.label}`} title={item.source}>
                  <span>{item.label}</span>
                  <small>~{formatCompact(item.estimatedTokens)} tok{item.truncated ? ' / partial' : ''}</small>
                </div>
              ))}
            </div>
          ) : (
            <div className="context-empty">None</div>
          )}
        </div>
      ))}
      <div className="context-section">
        <div className="context-label"><Cpu size={14} /><span>Services</span></div>
        {services.map((service) => <div key={service.kind} className="service-row"><span className={`status-dot ${service.status}`} /><span>{service.kind === 'cognitive1' ? 'C1 Brain' : 'Universal Proxy'}</span><small>{statusLabel(service.status)}</small></div>)}
      </div>
      <div className="context-section context-foot"><span>Updated</span><strong>{conversation ? relativeTime(conversation.updatedAt) : 'Not active'}</strong></div>
    </aside>
  );
}

function contextSectionIcon(kind: ContextPreview['sections'][number]['kind']): ReactNode {
  if (kind === 'memories') return <BrainIcon />;
  if (kind === 'skills') return <Sparkles size={14} />;
  return <FileDiff size={14} />;
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function BrainIcon(): ReactNode {
  return <span className="brain-dot" aria-hidden="true" />;
}
