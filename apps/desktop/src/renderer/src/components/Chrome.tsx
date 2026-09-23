import {
  Brain,
  Check,
  ChevronDown,
  Clock3,
  FolderKanban,
  FolderOpen,
  History,
  Layers3,
  Moon,
  PanelLeftClose,
  PanelRightClose,
  Plus,
  Route,
  Search,
  Settings,
  Sun,
  Trash2,
  Workflow,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { ConversationRecord, ProjectRecord } from '@kai/contracts';
import type { ViewId } from '../types';
import { relativeTime } from '../types';

export const navigation: Array<{ id: ViewId; label: string; icon: typeof Brain }> = [
  { id: 'workspace', label: 'Workspace', icon: Layers3 },
  { id: 'projects', label: 'Projects', icon: FolderKanban },
  { id: 'brain', label: 'C1 Brain', icon: Brain },
  { id: 'proxy', label: 'Universal Proxy', icon: Route },
  { id: 'workflows', label: 'Workflows', icon: Workflow },
  { id: 'history', label: 'History', icon: History },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export function NavigationRail({ view, version, serviceStatus, onChange }: { view: ViewId; version: string; serviceStatus: string; onChange: (view: ViewId) => void }): ReactNode {
  return (
    <aside className="nav-rail" aria-label="Primary navigation">
      <div className="brand-mark" aria-label="KAI">K</div>
      <nav className="nav-stack">
        {navigation.map((item, index) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              className={`nav-button ${view === item.id ? 'active' : ''}`}
              onClick={() => onChange(item.id)}
              title={`${item.label} (Ctrl+${index + 1})`}
              aria-label={item.label}
              aria-current={view === item.id ? 'page' : undefined}
            >
              <Icon size={19} />
            </button>
          );
        })}
      </nav>
      <div className="rail-footer"><div className={`status-dot ${serviceStatus}`} /><span>{version}</span></div>
    </aside>
  );
}

export function TitleBar({ projects, activeProject, theme, rightOpen, onChoose, onOpenProject, onToggleTheme, onToggleContext }: { projects: ProjectRecord[]; activeProject: ProjectRecord | null; theme: 'dark' | 'light'; rightOpen: boolean; onChoose: () => void; onOpenProject: (id: string) => void; onToggleTheme: () => void; onToggleContext: () => void }): ReactNode {
  return (
    <header className="titlebar">
      <div className="titlebar-drag">
        <ProjectPicker projects={projects} activeProject={activeProject} onChoose={onChoose} onOpen={onOpenProject} />
      </div>
      <div className="titlebar-actions">
        <button type="button" className="icon-button" title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} onClick={onToggleTheme}>
          {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
        </button>
        <button type="button" className="icon-button" title="Search" aria-label="Search"><Search size={17} /></button>
        <button type="button" className="icon-button" title={rightOpen ? 'Hide context panel (Ctrl+B)' : 'Show context panel (Ctrl+B)'} aria-label={rightOpen ? 'Hide context panel' : 'Show context panel'} onClick={onToggleContext}>
          {rightOpen ? <PanelRightClose size={17} /> : <PanelLeftClose size={17} />}
        </button>
      </div>
    </header>
  );
}

function ProjectPicker({ projects, activeProject, onChoose, onOpen }: { projects: ProjectRecord[]; activeProject: ProjectRecord | null; onChoose: () => void; onOpen: (id: string) => void }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <div className="project-picker">
      <button type="button" className="project-picker-button" onClick={() => setOpen((value) => !value)}>
        <span className="project-glyph">{activeProject ? activeProject.name.slice(0, 1).toUpperCase() : <FolderOpen size={15} />}</span>
        <span className="project-copy"><strong>{activeProject?.name ?? 'No project'}</strong><small>{activeProject?.path ?? 'Open a local repository'}</small></span>
        <ChevronDown size={15} />
      </button>
      {open && (
        <div className="popover project-popover">
          <div className="popover-label">Recent projects</div>
          {projects.map((project) => (
            <button type="button" key={project.id} className={project.id === activeProject?.id ? 'selected' : ''} onClick={() => { onOpen(project.id); setOpen(false); }}>
              <span className="project-glyph small">{project.name.slice(0, 1).toUpperCase()}</span>
              <span className="truncate">{project.name}</span>
              {project.id === activeProject?.id && <Check size={14} />}
            </button>
          ))}
          <div className="popover-divider" />
          <button type="button" onClick={() => { onChoose(); setOpen(false); }}><Plus size={15} /><span>Open project</span></button>
        </div>
      )}
    </div>
  );
}

export function ConversationSidebar({ conversations, activeId, onOpen, onDelete, onNew }: { conversations: ConversationRecord[]; activeId: string | null; onOpen: (id: string) => void; onDelete: (id: string) => void; onNew: () => void }): ReactNode {
  return (
    <aside className="conversation-sidebar">
      <div className="sidebar-heading"><span>Threads</span><button type="button" className="icon-button compact" onClick={onNew} title="New conversation" aria-label="New conversation"><Plus size={16} /></button></div>
      <div className="conversation-list">
        {conversations.length === 0 && <div className="empty-list">No conversations</div>}
        {conversations.map((conversation) => (
          <div key={conversation.id} className={`conversation-row ${conversation.id === activeId ? 'active' : ''}`}>
            <button type="button" className="conversation-main" onClick={() => onOpen(conversation.id)}>
              <span className="conversation-title truncate">{conversation.title}</span>
              <span className="conversation-meta"><Clock3 size={12} />{relativeTime(conversation.updatedAt)}</span>
            </button>
            <button type="button" className="row-action" title="Delete conversation" aria-label={`Delete ${conversation.title}`} onClick={() => onDelete(conversation.id)}><Trash2 size={13} /></button>
          </div>
        ))}
      </div>
    </aside>
  );
}
