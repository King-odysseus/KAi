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
  Ellipsis,
  DraftingCompass,
  GraduationCap,
  SquareTerminal,
  FolderKanban,
  FolderOpen,
  History,
  Keyboard,
  Layers3,
  Network,
  ListChecks,
  MonitorPlay,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Route,
  Search,
  Settings,
  Terminal,
  Trash2,
  Wallet,
  X,
  Workflow,
} from 'lucide-react';
import { Fragment, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { THEME_MODES, type AppSettings, type ConversationRecord, type ProjectRecord, type ThemeMode } from '@kai/contracts';
import type { ViewId } from '../types';
import { relativeTime } from '../types';
import { shortcutLabel } from '../shortcuts';
import { ProjectFilesPanel } from './ProjectFilesPanel';
import { UiButton } from './UiButton';
import { UiTextInput } from './UiTextInput';
import kaiIcon from '../../../../build/icon.png';
import { Dropdown, DropdownItem } from 'flowbite-react';

const themeLabel = (theme: ThemeMode): string => THEME_MODES.find((item) => item.id === theme)?.label ?? theme;
const nextTheme = (theme: ThemeMode): ThemeMode => THEME_MODES[(THEME_MODES.findIndex((item) => item.id === theme) + 1) % THEME_MODES.length]!.id;

export const navigation: Array<{ id: ViewId; label: string; group: 'Work' | 'Learn' | 'Project' | 'Brain' | 'Control'; icon: typeof Brain }> = [
  { id: 'workspace', label: 'Workspace', group: 'Work', icon: Layers3 },
  { id: 'studio', label: 'Project Studio', group: 'Work', icon: DraftingCompass },
  { id: 'graph', label: 'Project Graph', group: 'Work', icon: Network },
  { id: 'workflows', label: 'Workflows', group: 'Work', icon: Workflow },
  { id: 'history', label: 'History', group: 'Work', icon: History },
  { id: 'tasks', label: 'Tasks', group: 'Work', icon: Kanban },
  { id: 'code', label: 'Learn & Code', group: 'Learn', icon: Code2 },
  { id: 'commands', label: 'Terminal Commands', group: 'Learn', icon: SquareTerminal },
  { id: 'projects', label: 'Projects', group: 'Project', icon: FolderKanban },
  { id: 'git', label: 'Git', group: 'Project', icon: GitBranch },
  { id: 'brain', label: 'C1 Brain', group: 'Brain', icon: Brain },
  { id: 'rules', label: 'Execution Rules', group: 'Brain', icon: ListChecks },
  { id: 'proxy', label: 'Universal Proxy', group: 'Control', icon: Route },
  { id: 'usage', label: 'Usage', group: 'Control', icon: Wallet },
  { id: 'operations', label: 'Operations', group: 'Control', icon: Activity },
  { id: 'settings', label: 'Settings', group: 'Control', icon: Settings },
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

export function NavigationRail({ view, version, versionTitle, serviceStatus, shortcuts, onChange }: { view: ViewId; version: string; /** The full version and build, for the tooltip; the rail shows the version. */ versionTitle?: string; serviceStatus: string; shortcuts: AppSettings['shortcuts']; onChange: (view: ViewId) => void }): ReactNode {
  const [expanded, setExpanded] = useState(() => {
    try { return window.localStorage.getItem('kai.navigationExpanded') !== 'false'; }
    catch { return true; }
  });
  const toggleExpanded = (): void => {
    setExpanded((current) => {
      const next = !current;
      try { window.localStorage.setItem('kai.navigationExpanded', String(next)); }
      catch { /* Navigation still works when storage is unavailable. */ }
      return next;
    });
  };
  return (
    <aside className={`nav-rail${expanded ? ' expanded' : ''}`} aria-label="Primary navigation">
      <img className="brand-mark" src={kaiIcon} alt="KAi" />
      <UiButton type="button" className="nav-expand-button" aria-label={expanded ? 'Collapse navigation labels' : 'Show navigation labels'} aria-expanded={expanded} title={expanded ? 'Collapse navigation labels' : 'Show navigation labels'} onClick={toggleExpanded}>
        {expanded ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
        {expanded && <span>Collapse</span>}
      </UiButton>
      <nav className="nav-stack" aria-label="Workbench pages">
        {navigation.map((item, index) => {
          const Icon = item.icon;
          return (
            <Fragment key={item.id}>
              {(index === 0 || navigation[index - 1]?.group !== item.group) && <div className="nav-group-label"><span>{item.group}</span><i aria-hidden="true">{item.group[0]}</i></div>}
              <UiButton
                type="button"
                className={`nav-button ${view === item.id ? 'active' : ''}`}
                onClick={() => onChange(item.id)}
                title={`${item.group}: ${navigationShortcut(item.id, shortcuts) ? `${item.label} (${navigationShortcut(item.id, shortcuts)})` : item.label}`}
                aria-label={`${item.group}: ${item.label}`}
                aria-current={view === item.id ? 'page' : undefined}
              >
                <Icon size={19} />
                <span className="nav-button-label">{item.label}</span>
              </UiButton>
            </Fragment>
          );
        })}
      </nav>
      <div className="nav-bottom">
        <div className="rail-footer"><div className={`status-dot ${serviceStatus}`} /><span title={versionTitle ?? version}>{version}</span></div>
      </div>
    </aside>
  );
}

export function TitleBar({ projects, activeProject, theme, leftOpen, rightOpen, previewOpen, terminalOpen, shortcuts, onChoose, onOpenProject, onRemoveProject, onClearProjects, onNewWindow, onToggleTheme, onOpenSearch, onOpenShortcuts, onToggleThreads, onToggleContext, onTogglePreview, onToggleTerminal, onOpenTour, tourListOpen }: { projects: ProjectRecord[]; activeProject: ProjectRecord | null; theme: ThemeMode; leftOpen: boolean; rightOpen: boolean; previewOpen: boolean; terminalOpen: boolean; shortcuts: AppSettings['shortcuts']; onChoose: () => void; onOpenProject: (id: string) => void; onRemoveProject: (id: string) => void; onClearProjects: () => void; onNewWindow: () => void; onToggleTheme: () => void; onOpenSearch: () => void; onOpenShortcuts: () => void; onToggleThreads: () => void; onToggleContext: () => void; onTogglePreview: () => void; onToggleTerminal: () => void; onOpenTour: () => void; tourListOpen: boolean }): ReactNode {
  const newWindowShortcut = shortcutLabel(shortcuts, 'new-window');
  const searchShortcut = shortcutLabel(shortcuts, 'command-palette');
  const threadsShortcut = shortcutLabel(shortcuts, 'threads');
  const contextShortcut = shortcutLabel(shortcuts, 'context-panel');
  const sheetShortcut = shortcutLabel(shortcuts, 'shortcuts');
  return (
    <header className="titlebar">
      <div className="titlebar-drag">
        <ProjectPicker projects={projects} activeProject={activeProject} onChoose={onChoose} onOpen={onOpenProject} onRemove={onRemoveProject} onClear={onClearProjects} />
      </div>
      <div className="titlebar-actions">
        <UiButton type="button" className="icon-button" title={`Command palette${searchShortcut ? ` (${searchShortcut})` : ''}`} aria-label="Open command palette" onClick={onOpenSearch}><Search size={17} /></UiButton>
        <UiButton type="button" className="icon-button" title={leftOpen ? `Hide threads panel${threadsShortcut ? ` (${threadsShortcut})` : ''}` : `Show threads panel${threadsShortcut ? ` (${threadsShortcut})` : ''}`} aria-label={leftOpen ? 'Hide threads panel' : 'Show threads panel'} onClick={onToggleThreads}>
          {leftOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
        </UiButton>
        <UiButton type="button" className="icon-button" title={rightOpen ? `Hide context panel${contextShortcut ? ` (${contextShortcut})` : ''}` : `Show context panel${contextShortcut ? ` (${contextShortcut})` : ''}`} aria-label={rightOpen ? 'Hide context panel' : 'Show context panel'} onClick={onToggleContext}>
          {rightOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
        </UiButton>
        <UiButton type="button" className={`icon-button ${previewOpen ? 'active' : ''}`} title={previewOpen ? 'Hide live preview pane' : 'Show live preview pane'} aria-label={previewOpen ? 'Hide live preview pane' : 'Show live preview pane'} aria-pressed={previewOpen} onClick={onTogglePreview}>
          <MonitorPlay size={17} />
        </UiButton>
        <UiButton type="button" className={`icon-button ${terminalOpen ? 'active' : ''}`} title={terminalOpen ? 'Hide terminal (Ctrl+`)' : 'Show terminal (Ctrl+`)'} aria-label={terminalOpen ? 'Hide terminal' : 'Show terminal'} aria-pressed={terminalOpen} onClick={onToggleTerminal}>
          <Terminal size={17} />
        </UiButton>
        <MoreMenu
          items={[
            { label: 'New window', hint: newWindowShortcut, icon: <AppWindow size={15} />, onSelect: onNewWindow },
            { label: `Theme: ${themeLabel(theme)}`, hint: `Switch to ${themeLabel(nextTheme(theme))}`, icon: <Palette size={15} />, onSelect: onToggleTheme },
            { label: 'Guided tour and lessons', hint: '', icon: <GraduationCap size={15} />, onSelect: onOpenTour, active: tourListOpen },
            { label: 'Keyboard shortcuts', hint: sheetShortcut, icon: <Keyboard size={15} />, onSelect: onOpenShortcuts },
          ]}
        />
      </div>
    </header>
  );
}

interface MoreMenuItem { label: string; hint: string; icon: ReactNode; onSelect: () => void; active?: boolean }

function MoreMenu({ items }: { items: MoreMenuItem[] }): ReactNode {
  return (
    <Dropdown
      className="titlebar-more-dropdown"
      placement="bottom-end"
      arrowIcon={false}
      label="More"
      renderTrigger={() => <UiButton type="button" className="icon-button" title="More" aria-label="More"><Ellipsis size={17} /></UiButton>}
    >
      {items.map((item) => (
        <DropdownItem key={item.label} className={`titlebar-dropdown-item${item.active ? ' selected' : ''}`} onClick={item.onSelect}>
          {item.icon}
          <span className="titlebar-dropdown-copy"><span>{item.label}</span>{item.hint && <small>{item.hint}</small>}</span>
        </DropdownItem>
      ))}
    </Dropdown>
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
          <UiTextInput
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
            <UiButton
              type="button"
              role="option"
              aria-selected={index === selectedIndex}
              className={`command-palette-item ${index === selectedIndex ? 'active' : ''}`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => run(item)}
            >
              <span><strong>{item.label}</strong><small>{item.description}</small></span>
              {item.shortcut && <kbd>{item.shortcut}</kbd>}
            </UiButton>
            </Fragment>
          ))}
          {searching && <div className="command-palette-empty">Searching…</div>}
          {!searching && visible.length === 0 && <div className="command-palette-empty">No matching commands</div>}
        </div>
      </section>
    </div>
  );
}

function ProjectPicker({ projects, activeProject, onChoose, onOpen, onRemove, onClear }: { projects: ProjectRecord[]; activeProject: ProjectRecord | null; onChoose: () => void; onOpen: (id: string) => void; onRemove: (id: string) => void; onClear: () => void }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <div className="project-picker">
      <UiButton type="button" className="project-picker-button" onClick={() => setOpen((value) => !value)}>
        <span className="project-glyph">{activeProject ? activeProject.name.slice(0, 1).toUpperCase() : <FolderOpen size={15} />}</span>
        <span className="project-copy"><strong>{activeProject?.name ?? 'No project'}</strong><small>{activeProject?.path ?? 'Open a local repository'}</small></span>
        <ChevronDown size={15} />
      </UiButton>
      {open && (
        <div className="popover project-popover">
          <div className="popover-label">Recent projects</div>
          {/* The row is the way in; the small control beside it is the way out, so a list that has collected a
              folder twice, or one renamed since, can be tidied without opening it first. */}
          {projects.map((project) => (
            <div key={project.id} className={`project-row${project.id === activeProject?.id ? ' selected' : ''}`}>
              <UiButton type="button" className="project-row-open" onClick={() => { onOpen(project.id); setOpen(false); }}>
                <span className="project-glyph small">{project.name.slice(0, 1).toUpperCase()}</span>
                <span className="truncate">{project.name}</span>
                {project.id === activeProject?.id && <Check size={14} />}
              </UiButton>
              <UiButton
                type="button"
                className="project-row-remove"
                title={`Remove ${project.name} from the list`}
                aria-label={`Remove ${project.name} from the list`}
                onClick={() => onRemove(project.id)}
              >
                <X size={13} />
              </UiButton>
            </div>
          ))}
          <div className="popover-divider" />
          <UiButton type="button" onClick={() => { onChoose(); setOpen(false); }}><Plus size={15} /><span>Open project</span></UiButton>
          {projects.length > 0 && (
            <UiButton type="button" className="project-clear" onClick={() => { onClear(); setOpen(false); }}><Trash2 size={15} /><span>Clear list</span></UiButton>
          )}
        </div>
      )}
    </div>
  );
}

type SidebarTab = 'threads' | 'files';

function readSidebarTab(): SidebarTab {
  try {
    return window.localStorage.getItem('kai.sidebarTab') === 'files' ? 'files' : 'threads';
  } catch {
    return 'threads';
  }
}

export function ConversationSidebar({ conversations, activeId, projectId, filesRefreshKey, onOpen, onDelete, onNew, onCollapse, onOpenFile }: { conversations: ConversationRecord[]; activeId: string | null; projectId: string | null; filesRefreshKey: string; onOpen: (id: string) => void; onDelete: (id: string) => void; onNew: () => void; onCollapse: () => void; onOpenFile: (path: string) => void }): ReactNode {
  const [tab, setTabState] = useState<SidebarTab>(readSidebarTab);
  const setTab = (next: SidebarTab): void => {
    setTabState(next);
    try {
      window.localStorage.setItem('kai.sidebarTab', next);
    } catch {
      // The tab simply is not remembered.
    }
  };
  return (
    <aside className="conversation-sidebar">
      <div className="sidebar-heading">
        <div className="sidebar-tabs" role="tablist" aria-label="Left panel">
          <UiButton type="button" role="tab" aria-selected={tab === 'threads'} className={tab === 'threads' ? 'active' : ''} onClick={() => setTab('threads')}>Threads</UiButton>
          <UiButton type="button" role="tab" aria-selected={tab === 'files'} className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')} title="Project files, including what changed and what Git does not track yet">Files</UiButton>
        </div>
        <div className="sidebar-heading-actions">
          <UiButton type="button" className="icon-button compact" onClick={onNew} title="New conversation" aria-label="New conversation"><Plus size={16} /></UiButton>
          <UiButton type="button" className="icon-button compact" onClick={onCollapse} title="Hide threads panel (Ctrl+Shift+B)" aria-label="Hide threads panel"><PanelLeftClose size={15} /></UiButton>
        </div>
      </div>
      {tab === 'files' && <ProjectFilesPanel projectId={projectId} refreshKey={filesRefreshKey} onOpenFile={onOpenFile} />}
      {tab === 'threads' && <div className="conversation-list">
        {conversations.length === 0 && <div className="empty-list">No conversations</div>}
        {conversations.map((conversation) => (
          <div key={conversation.id} className={`conversation-row ${conversation.id === activeId ? 'active' : ''}`}>
            <UiButton type="button" className="conversation-main" onClick={() => onOpen(conversation.id)}>
              <span className="conversation-title truncate">{conversation.title}</span>
              <span className="conversation-meta"><Clock3 size={12} />{relativeTime(conversation.updatedAt)}</span>
            </UiButton>
            <UiButton type="button" className="row-action" title="Delete conversation" aria-label={`Delete ${conversation.title}`} onClick={() => onDelete(conversation.id)}><Trash2 size={13} /></UiButton>
          </div>
        ))}
      </div>}
    </aside>
  );
}
