import {
  Activity,
  Archive,
  ArchiveRestore,
  Brain,
  Clock3,
  Copy,
  FolderKanban,
  FolderOpen,
  GitBranch,
  GitFork,
  KeyRound,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Route,
  Save,
  Search,
  Settings,
  Square,
  Trash2,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type {
  AgentCapability,
  AgentId,
  AppSettings,
  ConversationRecord,
  ProjectRecord,
  ServiceState,
  Workflow,
  WorkflowStep,
  WorkflowTemplate,
} from '@kai/contracts';
import { relativeTime, statusLabel, unwrap } from '../types';

export function ProjectsView({
  projects,
  activeProjectId,
  onChoose,
  onOpen,
  onRemove,
}: {
  projects: ProjectRecord[];
  activeProjectId: string | null;
  onChoose: () => void;
  onOpen: (id: string) => void;
  onRemove: (id: string) => void;
}): ReactNode {
  return (
    <div className="page-view">
      <PageHeader
        title="Projects"
        detail={`${projects.length} local ${projects.length === 1 ? 'project' : 'projects'}`}
      >
        <button type="button" className="primary-button" onClick={onChoose}>
          <Plus size={16} />
          <span>Open project</span>
        </button>
      </PageHeader>
      <div className="project-grid">
        {projects.map((project) => (
          <article key={project.id} className={`project-card ${project.id === activeProjectId ? 'active' : ''}`}>
            <div className="project-card-icon">{project.name.slice(0, 1).toUpperCase()}</div>
            <div className="project-card-copy">
              <strong>{project.name}</strong>
              <span className="mono truncate">{project.path}</span>
              <small>Last opened {relativeTime(project.lastOpenedAt)}</small>
            </div>
            <div className="project-card-actions">
              <button type="button" className="secondary-button" onClick={() => onOpen(project.id)}>
                <FolderOpen size={14} />
                <span>{project.id === activeProjectId ? 'Active' : 'Open'}</span>
              </button>
              <button
                type="button"
                className="icon-button"
                onClick={() => onRemove(project.id)}
                title="Remove project"
                aria-label="Remove project"
              >
                <Trash2 size={15} />
              </button>
            </div>
          </article>
        ))}
        {projects.length === 0 && (
          <div className="blank-panel">
            <FolderKanban size={28} />
            <span>No projects</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function ServiceView({
  service,
  kind,
  busy,
  onConfigure,
  onStart,
  onStop,
  onRestart,
  onCopyToken,
  onRotateToken,
  children,
}: {
  service: ServiceState;
  kind: 'brain' | 'proxy';
  busy: boolean;
  onConfigure: () => void;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onCopyToken: () => void;
  onRotateToken: () => void;
  children?: ReactNode;
}): ReactNode {
  const title = kind === 'brain' ? 'C1 Brain' : 'Universal Proxy';
  const Icon = kind === 'brain' ? Brain : Route;
  const running = service.status === 'ready' || service.status === 'starting';
  return (
    <div className="page-view">
      <PageHeader title={title} detail={service.detail}>
        <button type="button" className="secondary-button" onClick={onConfigure}>
          <Settings size={15} />
          <span>Configure</span>
        </button>
        {running ? (
          <button type="button" className="secondary-button" disabled={busy} onClick={onStop}>
            <Square size={13} />
            <span>Stop</span>
          </button>
        ) : (
          <button type="button" className="primary-button" disabled={busy} onClick={onStart}>
            <Play size={14} />
            <span>Start</span>
          </button>
        )}
        <button type="button" className="secondary-button" disabled={busy || !running} onClick={onRestart}>
          <RotateCcw size={14} />
          <span>Restart</span>
        </button>
      </PageHeader>
      <div className="service-hero">
        <div className="service-icon">
          <Icon size={22} />
        </div>
        <div>
          <span className="eyebrow">Service state</span>
          <h2>{statusLabel(service.status)}</h2>
          <p>{service.endpoint ?? 'No endpoint configured'}</p>
        </div>
        <div className={`service-beacon ${service.status}`} />
      </div>
      <div className="metric-strip">
        <Metric label="Version" value={service.version ?? 'Not reported'} icon={<GitBranch size={15} />} />
        <Metric label="Endpoint" value={service.endpoint ?? 'Not configured'} icon={<Activity size={15} />} />
        <Metric
          label="Access"
          value={service.authentication === 'loopback-token' ? 'Token required' : 'Not configured'}
          icon={<KeyRound size={15} />}
        />
        <Metric label="Updated" value={relativeTime(service.updatedAt)} icon={<Clock3 size={15} />} />
      </div>
      <div className="service-access-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={busy || !service.tokenStored}
          onClick={onCopyToken}
        >
          <Copy size={14} />
          <span>Copy access token</span>
        </button>
        <button type="button" className="secondary-button" disabled={busy} onClick={onRotateToken}>
          <RefreshCw size={14} />
          <span>Rotate access token</span>
        </button>
      </div>
      {children}
    </div>
  );
}

interface WorkflowDraftStep {
  id: string;
  agent: AgentId;
  prompt: string;
  label: string;
  status: WorkflowStep['status'];
  output?: string;
  error?: string;
}

export function WorkflowsView({
  activeProject,
  agentCapabilities,
  settings,
  busy,
}: {
  activeProject: ProjectRecord | null;
  agentCapabilities: AgentCapability[];
  settings: AppSettings;
  busy: boolean;
}): ReactNode {
  const [title, setTitle] = useState('Untitled workflow');
  const [steps, setSteps] = useState<WorkflowDraftStep[]>([
    { id: 'step_0', agent: settings.defaultAgent, prompt: '', label: 'Step 1', status: 'pending' },
  ]);
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.kaiDesktop.listWorkflowTemplates(activeProject?.id).then(unwrap).then(setTemplates).catch(() => undefined);
  }, [activeProject?.id]);

  function addStep(): void {
    setSteps((current) => [...current, {
      id: `step_${crypto.randomUUID()}`,
      agent: settings.defaultAgent,
      prompt: '',
      label: `Step ${current.length + 1}`,
      status: 'pending',
    }]);
  }

  async function saveTemplate(): Promise<void> {
    if (!steps.some((step) => step.prompt.trim())) return;
    const now = new Date().toISOString();
    try {
      const template = await window.kaiDesktop.saveWorkflowTemplate({
        id: `workflow_${crypto.randomUUID()}`,
        name: title.trim() || 'Untitled workflow',
        description: '',
        steps: steps.filter((step) => step.prompt.trim()).map((step) => ({ agent: step.agent, prompt: step.prompt.trim(), label: step.label })),
        route: 'direct',
        autonomy: settings.defaultAutonomy,
        createdAt: now,
      }).then(unwrap);
      setTemplates((current) => [...current.filter((item) => item.id !== template.id), template].sort((left, right) => left.name.localeCompare(right.name)));
      setError(null);
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  async function removeTemplate(id: string): Promise<void> {
    try {
      await window.kaiDesktop.deleteWorkflowTemplate(id).then(unwrap);
      setTemplates((current) => current.filter((template) => template.id !== id));
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  async function runWorkflow(): Promise<void> {
    if (!activeProject || running) return;
    const executable = steps.filter((step) => step.prompt.trim());
    if (executable.length === 0) return;
    setRunning(true);
    setError(null);
    try {
      const conversation = await window.kaiDesktop
        .createConversation(activeProject.id, `Workflow: ${title.trim() || 'Untitled workflow'}`)
        .then(unwrap);
      const workflow: Workflow = {
        id: `workflow_${crypto.randomUUID()}`,
        title: title.trim() || 'Untitled workflow',
        route: 'direct',
        autonomy: settings.defaultAutonomy,
        status: 'running',
        currentStepIndex: 0,
        createdAt: new Date().toISOString(),
        steps: executable.map((step) => ({
          id: step.id,
          agent: step.agent,
          prompt: step.prompt.trim(),
          label: step.label,
          status: 'pending',
        })),
      };
      conversation.workflow = workflow;
      await window.kaiDesktop.saveConversation(conversation).then(unwrap);

      for (let index = 0; index < executable.length; index += 1) {
        const step = executable[index];
        setSteps((current) => current.map((item) => item.id === step.id ? { ...item, status: 'running', error: undefined } : item));
        workflow.currentStepIndex = index;
        workflow.steps[index].status = 'running';
        workflow.steps[index].startedAt = new Date().toISOString();
        conversation.workflow = { ...workflow };
        await window.kaiDesktop.saveConversation(conversation).then(unwrap);
        try {
          const result = await window.kaiDesktop.runAgent({
            conversationId: conversation.id,
            prompt: step.prompt.trim(),
            agent: step.agent,
            execution: 'cli',
            route: 'direct',
            autonomy: settings.defaultAutonomy,
          }).then(unwrap);
          const completedAt = new Date().toISOString();
          workflow.steps[index].status = result.error ? 'failed' : 'completed';
          workflow.steps[index].output = result.output;
          workflow.steps[index].error = result.error;
          workflow.steps[index].completedAt = completedAt;
          setSteps((current) => current.map((item) => item.id === step.id ? {
            ...item,
            status: result.error ? 'failed' : 'completed',
            output: result.output,
            error: result.error,
          } : item));
          Object.assign(conversation, result.conversation, { workflow });
          await window.kaiDesktop.saveConversation(conversation).then(unwrap);
          if (result.error) {
            workflow.status = 'paused';
            break;
          }
        } catch (caught) {
          const detail = messageOf(caught);
          workflow.steps[index].status = 'failed';
          workflow.steps[index].error = detail;
          workflow.status = 'paused';
          setSteps((current) => current.map((item) => item.id === step.id ? { ...item, status: 'failed', error: detail } : item));
          setError(detail);
          break;
        }
      }
      workflow.status = workflow.steps.every((step) => step.status === 'completed') ? 'completed' : workflow.status;
      workflow.completedAt = workflow.status === 'completed' ? new Date().toISOString() : undefined;
      conversation.workflow = { ...workflow };
      await window.kaiDesktop.saveConversation(conversation).then(unwrap);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="page-view">
      <PageHeader title="Workflows" detail="Build, save, and run sequential multi-agent work">
        <button type="button" className="secondary-button" disabled={busy || running || !steps.some((step) => step.prompt.trim())} onClick={() => void saveTemplate()}><Save size={15} /><span>Save template</span></button>
        <button type="button" className="primary-button" disabled={busy || running || !activeProject || !steps.some((step) => step.prompt.trim())} onClick={() => void runWorkflow()}><Play size={15} /><span>{running ? 'Running' : 'Run workflow'}</span></button>
      </PageHeader>
      {error && <div className="rules-error"><span>{error}</span></div>}
      <div className="workflow-builder">
        <div className="workflow-builder-head">
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Workflow title" />
          {templates.length > 0 && <select defaultValue="" onChange={(event) => {
            const template = templates.find((item) => item.id === event.target.value);
            if (!template) return;
            setTitle(template.name);
            setSteps(template.steps.map((step, index) => ({ id: `step_${crypto.randomUUID()}`, agent: step.agent, prompt: step.prompt, label: step.label ?? `Step ${index + 1}`, status: 'pending' })));
            event.target.value = '';
          }}><option value="">Load template</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select>}
        </div>
        <div className="workflow-step-list">
          {steps.map((step, index) => (
            <div className="workflow-step" key={step.id}>
              <span className={`workflow-index ${step.status}`}>{index + 1}</span>
              <select value={step.agent} onChange={(event) => setSteps((current) => current.map((item) => item.id === step.id ? { ...item, agent: event.target.value as AgentId } : item))}>
                {agentCapabilities.map((agent) => <option key={agent.id} value={agent.id} disabled={!agent.available}>{agent.displayName}{agent.available ? '' : ' (unavailable)'}</option>)}
              </select>
              <textarea value={step.prompt} onChange={(event) => setSteps((current) => current.map((item) => item.id === step.id ? { ...item, prompt: event.target.value } : item))} placeholder={`What should ${step.agent} do?`} rows={2} />
              <div className="workflow-step-state"><span>{step.status}</span>{step.error && <small title={step.error}>{step.error}</small>}{step.output && <small>{step.output.slice(0, 100)}</small>}</div>
              <button type="button" aria-label="Remove step" disabled={running || steps.length === 1} onClick={() => setSteps((current) => current.filter((item) => item.id !== step.id))}><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
        <button type="button" className="secondary-button" disabled={running} onClick={addStep}><Plus size={14} /><span>Add step</span></button>
      </div>
    </div>
  );
}

export function HistoryView({
  conversations,
  activeId,
  projects,
  onOpen,
  onRename,
  onArchive,
  onFork,
  onDelete,
}: {
  conversations: ConversationRecord[];
  activeId: string | null;
  projects: ProjectRecord[];
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onArchive: (id: string, archived: boolean) => void;
  onFork: (id: string) => void;
  onDelete: (id: string) => void;
}): ReactNode {
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const normalized = query.trim().toLowerCase();
  const visible = conversations.filter((conversation) => {
    if (!showArchived && conversation.archived) return false;
    if (!normalized) return true;
    return `${conversation.title} ${conversation.activeAgent ?? ''}`.toLowerCase().includes(normalized);
  });
  return (
    <div className="page-view">
      <PageHeader title="History" detail={`${conversations.length} conversations stored on this machine`}>
        <label className="toggle-row history-archive-filter"><span><strong>Show archived</strong><small>Include archived conversations</small></span><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /></label>
      </PageHeader>
      <label className="input-with-icon history-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search conversations" /></label>
      <div className="history-table">
        <div className="history-head">
          <span>Thread</span>
          <span>Project</span>
          <span>Updated</span>
          <span />
        </div>
        {visible.map((conversation) => (
          <div
            key={conversation.id}
            className={`history-row ${conversation.id === activeId ? 'active' : ''}`}
          >
            <button type="button" className="history-open" onClick={() => onOpen(conversation.id)}><span className="truncate">{conversation.title}</span></button>
            <span className="truncate">{projects.find((project) => project.id === conversation.projectId)?.name ?? 'Unassigned'}</span>
            <span>{relativeTime(conversation.updatedAt)}</span>
            <span className="history-actions">
              <button type="button" title="Rename" onClick={() => { const next = window.prompt('Conversation title', conversation.title); if (next?.trim()) onRename(conversation.id, next.trim()); }}><Pencil size={13} /></button>
              <button type="button" title={conversation.archived ? 'Restore' : 'Archive'} onClick={() => onArchive(conversation.id, !conversation.archived)}>{conversation.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}</button>
              <button type="button" title="Fork" onClick={() => onFork(conversation.id)}><GitFork size={13} /></button>
              <button type="button" title="Delete" onClick={() => { if (window.confirm(`Delete "${conversation.title}"?`)) onDelete(conversation.id); }}><Trash2 size={13} /></button>
            </span>
          </div>
        ))}
        {visible.length === 0 && <div className="empty-list">No matching conversations</div>}
      </div>
    </div>
  );
}

function PageHeader({ title, detail, children }: { title: string; detail: string; children?: ReactNode }): ReactNode {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        <p>{detail}</p>
      </div>
      {children && <div className="page-actions">{children}</div>}
    </header>
  );
}

function Metric({ label, value, icon }: { label: string; value: string; icon: ReactNode }): ReactNode {
  return (
    <div className="metric">
      <span className="metric-icon">{icon}</span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'KAI encountered an unexpected error.';
}
