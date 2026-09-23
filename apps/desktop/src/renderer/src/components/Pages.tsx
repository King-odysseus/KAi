import {
  Activity,
  Brain,
  Clock3,
  Copy,
  FolderKanban,
  FolderOpen,
  GitBranch,
  KeyRound,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Route,
  Settings,
  Square,
  Trash2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { ConversationRecord, ProjectRecord, ServiceState } from '@kai/contracts';
import { relativeTime, statusLabel } from '../types';

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

export function WorkflowsView(): ReactNode {
  return (
    <div className="page-view">
      <PageHeader title="Workflows" detail="Sequential work, handoffs, and recovery state">
        <button type="button" className="primary-button" disabled>
          <Plus size={16} />
          <span>New workflow</span>
        </button>
      </PageHeader>
      <div className="workflow-empty">
        <div className="workflow-line">
          <span>1</span>
          <div />
        </div>
        <div className="workflow-line">
          <span>2</span>
          <div />
        </div>
        <div className="workflow-line">
          <span>3</span>
          <div />
        </div>
        <strong>No workflows</strong>
      </div>
    </div>
  );
}

export function HistoryView({
  conversations,
  activeId,
  onOpen,
}: {
  conversations: ConversationRecord[];
  activeId: string | null;
  onOpen: (id: string) => void;
}): ReactNode {
  return (
    <div className="page-view">
      <PageHeader title="History" detail="Conversations stored on this machine" />
      <div className="history-table">
        <div className="history-head">
          <span>Thread</span>
          <span>Project</span>
          <span>Updated</span>
          <span />
        </div>
        {conversations.map((conversation) => (
          <button
            key={conversation.id}
            type="button"
            className={`history-row ${conversation.id === activeId ? 'active' : ''}`}
            onClick={() => onOpen(conversation.id)}
          >
            <span className="truncate">{conversation.title}</span>
            <span className="truncate">{conversation.projectId ?? 'Unassigned'}</span>
            <span>{relativeTime(conversation.updatedAt)}</span>
            <Play size={14} />
          </button>
        ))}
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
