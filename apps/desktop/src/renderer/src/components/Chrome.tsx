import {
  Activity,
  AppWindow,
  Brain,
  Code2,
  GitBranch,
  Kanban,
  Check,
  ChevronDown,
  Clock3,
  FolderKanban,
  FolderOpen,
  History,
  Keyboard,
  Layers3,
  ListChecks,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Route,
  Search,
  Settings,
  Trash2,
  Wallet,
  Workflow,
} from 'lucide-react';
import { Fragment, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { THEME_MODES, type AppSettings, type ConversationRecord, type ProjectRecord, type ThemeMode } from '@kai/contracts';
import type { ViewId } from '../types';
import { relativeTime } from '../types';
import { shortcutLabel } from '../shortcuts';

const themeLabel = (theme: ThemeMode): string => THEME_MODES.find((item) => item.id === theme)?.label ?? theme;
const nextTheme = (theme: ThemeMode): ThemeMode => THEME_MODES[(THEME_MODES.findIndex((item) => item.id === theme) + 1) % THEME_MODES.length]!.id;

export const navigation: Array<{ id: ViewId; label: string; icon: typeof Brain }> = [
  { id: 'workspace', label: 'Workspace', icon: Layers3 },
  { id: 'projects', label: 'Projects', icon: FolderKanban },
  { id: 'brain', label: 'C1 Brain', icon: Brain },
  { id: 'rules', label: 'Execution Rules', icon: ListChecks },
  { id: 'proxy', label: 'Universal Proxy', icon: Route },
  { id: 'workflows', label: 'Workflows', icon: Workflow },
  { id: 'history', label: 'History', icon: History },
  { id: 'code', label: 'Code', icon: Code2 },
  { id: 'tasks', label: 'Tasks', icon: Kanban },
  { id: 'git', label: 'Git', icon: GitBranch },
  { id: 'usage', label: 'Usage', icon: Wallet },
  { id: 'operations', label: 'Operations', icon: Activity },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export interface CommandPaletteItem {
  id: string;
  label: string;
  description: string;
  shortcut?: string;
  /** Heading shown above the first item of each group (used for search results). */
  group?: string;
  run: () => void | Promise<void>;
}

export function NavigationRail({ view, version, serviceStatus, shortcuts, onChange }: { view: ViewId; version: string; serviceStatus: string; shortcuts: AppSettings['shortcuts']; onChange: (view: ViewId) => void }): ReactNode {
  return (
    <aside className="nav-rail" aria-label="Primary navigation">
      <div className="brand-mark" aria-label="KAI">K</div>
      <nav className="nav-stack">
        {navigation.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              className={`nav-button ${view === item.id ? 'active' : ''}`}
              onClick={() => onChange(item.id)}
              title={navigationShortcut(item.id, shortcuts) ? `${item.label} (${navigationShortcut(item.id, shortcuts)})` : item.label}
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

export function TitleBar({ projects, activeProject, theme, leftOpen, rightOpen, shortcuts, onChoose, onOpenProject, onNewWindow, onToggleTheme, onOpenSearch, onOpenShortcuts, onToggleThreads, onToggleContext }: { projects: ProjectRecord[]; activeProject: ProjectRecord | null; theme: ThemeMode; leftOpen: boolean; rightOpen: boolean; shortcuts: AppSettings['shortcuts']; onChoose: () => void; onOpenProject: (id: string) => void; onNewWindow: () => void; onToggleTheme: () => void; onOpenSearch: () => void; onOpenShortcuts: () => void; onToggleThreads: () => void; onToggleContext: () => void }): ReactNode {
  const newWindowShortcut = shortcutLabel(shortcuts, 'new-window');
  const searchShortcut = shortcutLabel(shortcuts, 'command-palette');
  const threadsShortcut = shortcutLabel(shortcuts, 'threads');
  const contextShortcut = shortcutLabel(shortcuts, 'context-panel');
  const sheetShortcut = shortcutLabel(shortcuts, 'shortcuts');
  return (
    <header className="titlebar">
      <div className="titlebar-drag">
        <ProjectPicker projects={projects} activeProject={activeProject} onChoose={onChoose} onOpen={onOpenProject} />
      </div>
      <div className="titlebar-actions">
        <button type="button" className="icon-button" title={`New window${newWindowShortcut ? ` (${newWindowShortcut})` : ''}`} aria-label="New window" onClick={onNewWindow}>
          <AppWindow size={17} />
        </button>
        <button type="button" className="icon-button" title={`Theme: ${themeLabel(theme)}. Switch to ${themeLabel(nextTheme(theme))}`} aria-label={`Theme: ${themeLabel(theme)}. Switch to ${themeLabel(nextTheme(theme))}`} onClick={onToggleTheme}>
          <Palette size={17} />
        </button>
        <button type="button" className="icon-button" title={`Command palette${searchShortcut ? ` (${searchShortcut})` : ''}`} aria-label="Open command palette" onClick={onOpenSearch}><Search size={17} /></button>
        <button type="button" className="icon-button" title={leftOpen ? `Hide threads panel${threadsShortcut ? ` (${threadsShortcut})` : ''}` : `Show threads panel${threadsShortcut ? ` (${threadsShortcut})` : ''}`} aria-label={leftOpen ? 'Hide threads panel' : 'Show threads panel'} onClick={onToggleThreads}>
          {leftOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
        </button>
        <button type="button" className="icon-button" title={rightOpen ? `Hide context panel${contextShortcut ? ` (${contextShortcut})` : ''}` : `Show context panel${contextShortcut ? ` (${contextShortcut})` : ''}`} aria-label={rightOpen ? 'Hide context panel' : 'Show context panel'} onClick={onToggleContext}>
          {rightOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
        </button>
        <button type="button" className="icon-button" title={`Keyboard shortcuts${sheetShortcut ? ` (${sheetShortcut})` : ''}`} aria-label="Open keyboard shortcuts" onClick={onOpenShortcuts}><Keyboard size={17} /></button>
      </div>
    </header>
  );
}

function navigationShortcut(id: ViewId, shortcuts: AppSettings['shortcuts']): string {
  if (id === 'workspace') return shortcutLabel(shortcuts, 'workbench');
  if (id === 'code') return shortcutLabel(shortcuts, 'code');
  return '';
}

export function CommandPalette({ items, onClose, onSearch }: { items: CommandPaletteItem[]; onClose: () => void; onSearch?: (query: string) => Promise<CommandPaletteItem[]> }): ReactNode {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [found, setFound] = useState<CommandPaletteItem[]>([]);
  const [searching, setSearching] = useState(false);
  const searchRef = useRef(onSearch);
  searchRef.current = onSearch;
  const normalized = query.trim().toLowerCase();
  const commands = items.filter((item) => !normalized || `${item.label} ${item.description}`.toLowerCase().includes(normalized));
  const visible = [...commands, ...(normalized.length >= 2 ? found : [])];

  // Search conversations and the C1 brain as the user types; commands stay instant.
  useEffect(() => {
    const search = searchRef.current;
    if (!search || normalized.length < 2) {
      setFound([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      search(normalized)
        .then((results) => { if (!cancelled) setFound(results); })
        .catch(() => { if (!cancelled) setFound([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [normalized]);
  const selectedIndex = Math.min(activeIndex, Math.max(0, visible.length - 1));

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  function run(item: CommandPaletteItem | undefined): void {
    if (!item) return;
    onClose();
    void item.run();
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => visible.length ? (Math.min(current, visible.length - 1) + 1) % visible.length : 0);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => visible.length ? (Math.min(current, visible.length - 1) - 1 + visible.length) % visible.length : 0);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      run(visible[selectedIndex]);
    }
  }

  return (
    <div className="command-palette-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <label className="command-palette-search">
          <Search size={17} />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={onSearch ? 'Type a command, or search conversations and the brain' : 'Type a command'}
            aria-label="Search commands"
          />
          <kbd>Esc</kbd>
        </label>
        <div className="command-palette-list" role="listbox" aria-label="Commands">
          {visible.map((item, index) => (
            <Fragment key={item.id}>
            {item.group && item.group !== visible[index - 1]?.group && <div className="command-palette-group">{item.group}</div>}
            <button
              type="button"
              role="option"
              aria-selected={index === selectedIndex}
              className={`command-palette-item ${index === selectedIndex ? 'active' : ''}`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => run(item)}
            >
              <span><strong>{item.label}</strong><small>{item.description}</small></span>
              {item.shortcut && <kbd>{item.shortcut}</kbd>}
            </button>
            </Fragment>
          ))}
          {searching && <div className="command-palette-empty">Searching…</div>}
          {!searching && visible.length === 0 && <div className="command-palette-empty">No matching commands</div>}
        </div>
      </section>
    </div>
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

export function ConversationSidebar({ conversations, activeId, onOpen, onDelete, onNew, onCollapse }: { conversations: ConversationRecord[]; activeId: string | null; onOpen: (id: string) => void; onDelete: (id: string) => void; onNew: () => void; onCollapse: () => void }): ReactNode {
  return (
    <aside className="conversation-sidebar">
      <div className="sidebar-heading">
        <span>Threads</span>
        <div className="sidebar-heading-actions">
          <button type="button" className="icon-button compact" onClick={onNew} title="New conversation" aria-label="New conversation"><Plus size={16} /></button>
          <button type="button" className="icon-button compact" onClick={onCollapse} title="Hide threads panel (Ctrl+Shift+B)" aria-label="Hide threads panel"><PanelLeftClose size={15} /></button>
        </div>
      </div>
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
