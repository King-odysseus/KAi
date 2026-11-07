import {
  Activity,
  AppWindow,
  Brain,
  Code2,
  GitBranch,
  Kanban,
  Check,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
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
  ScanSearch,
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
  UsersRound,
} from 'lucide-react';
import { Fragment, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { THEME_MODES, type AppSettings, type ConversationRecord, type ProjectRecord, type ThemeMode } from '@kai/contracts';
import type { ViewId } from '../types';
import { relativeTime } from '../types';
import { shortcutLabel } from '../shortcuts';
import { ProjectFilesPanel } from './ProjectFilesPanel';
import { UiButton } from './UiButton';
import { ActionsMenu } from './ui/ActionsMenu';
import { IconButton } from './ui/IconButton';
import { TabBar } from './ui/TabBar';
import { UiTextInput } from './UiTextInput';
import kaiIcon from '../../../../build/icon.png';
import { Dropdown, DropdownItem } from 'flowbite-react';

const themeLabel = (theme: ThemeMode): string => THEME_MODES.find((item) => item.id === theme)?.label ?? theme;

export const navigation: Array<{ id: ViewId; label: string; group: 'Work' | 'Learn' | 'Project' | 'Brain' | 'Control'; icon: typeof Brain }> = [
  { id: 'workspace', label: 'Workspace', group: 'Work', icon: Layers3 },
  { id: 'studio', label: 'Project Studio', group: 'Work', icon: DraftingCompass },
  { id: 'graph', label: 'Project Graph', group: 'Work', icon: Network },
  { id: 'workflows', label: 'Workflows', group: 'Work', icon: Workflow },
  { id: 'crew', label: 'Crew', group: 'Work', icon: UsersRound },
  { id: 'review', label: 'Review', group: 'Work', icon: ScanSearch },
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
    <aside
      className={`nav-rail flex shrink-0 flex-col border-r border-[color:var(--border-soft)] bg-[var(--bg-shell)] px-2.5 pb-2 pt-2 transition-[width] ${expanded ? 'w-56' : 'w-14 items-center px-1.5'}`}
      aria-label="Primary navigation"
    >
      <div className={`nav-rail-top flex w-full shrink-0 items-center pb-1 ${expanded ? 'justify-between px-2' : 'justify-center'}`}>
        {expanded && <span className="text-[10.5px] font-medium uppercase tracking-[0.07em] text-[var(--text-dim)]">Navigation</span>}
        <button
          type="button"
          className="nav-rail-toggle inline-grid h-7 w-7 cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] focus:outline-none focus-visible:bg-[var(--bg-hover)]"
          aria-label={expanded ? 'Minimise sidebar' : 'Expand sidebar'}
          aria-expanded={expanded}
          title={expanded ? 'Minimise sidebar' : 'Expand sidebar'}
          onClick={toggleExpanded}
        >
          {expanded ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
        </button>
      </div>
      <nav className="kai-scroll-hidden flex min-h-0 w-full flex-1 flex-col overflow-y-auto overflow-x-hidden" aria-label="Workbench pages">
        {navigation.map((item, index) => {
          const Icon = item.icon;
          const active = view === item.id;
          const shortcut = navigationShortcut(item.id, shortcuts);
          const startsGroup = index === 0 || navigation[index - 1]?.group !== item.group;
          return (
            <Fragment key={item.id}>
              {startsGroup && (expanded
                ? <div className={`nav-group-label px-2 pb-1 text-[10.5px] font-medium uppercase tracking-[0.07em] text-[var(--text-dim)] ${index === 0 ? 'pt-1' : 'pt-3.5'}`}>{item.group}</div>
                : <div className={`mx-auto h-px w-5 bg-[var(--border-soft)] ${index === 0 ? 'mb-1.5' : 'my-2'}`} aria-hidden="true" />)}
              <button
                type="button"
                onClick={() => onChange(item.id)}
                title={`${item.group}: ${shortcut ? `${item.label} (${shortcut})` : item.label}`}
                aria-label={`${item.group}: ${item.label}`}
                aria-current={active ? 'page' : undefined}
                className={`nav-button my-px flex h-8 w-full shrink-0 cursor-pointer items-center gap-2.5 whitespace-nowrap rounded-lg border-0 text-left text-[13px] focus:outline-none focus-visible:bg-[var(--bg-hover)] ${expanded ? 'px-2' : 'justify-center px-0'} ${active ? 'bg-[var(--selection)] text-[var(--text)]' : 'bg-transparent text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]'}`}
              >
                <Icon size={15} className={`shrink-0 ${active ? 'text-[var(--accent)]' : ''}`} aria-hidden="true" />
                {expanded && <span className="min-w-0 flex-1 truncate">{item.label}</span>}
                {expanded && shortcut && <kbd className="ml-auto shrink-0 font-sans text-[10.5px] text-[var(--text-dim)]">{shortcut}</kbd>}
              </button>
            </Fragment>
          );
        })}
      </nav>
      <div className="rail-footer mt-2 flex w-full items-center gap-2 border-t border-[color:var(--border-soft)] px-2 pt-2 text-[11.5px] text-[var(--text-dim)]">
        <span className={`status-dot ${serviceStatus}`} aria-hidden="true" />
        {expanded && <span className="whitespace-nowrap" title={versionTitle ?? version}>{version}</span>}
        <button
          type="button"
          className={`inline-flex cursor-pointer items-center gap-1 whitespace-nowrap border-0 bg-transparent p-0 text-[11.5px] text-[var(--text-muted)] hover:text-[var(--text)] focus:outline-none ${expanded ? 'ml-auto' : ''}`}
          aria-label={expanded ? 'Collapse navigation labels' : 'Show navigation labels'}
          aria-expanded={expanded}
          title={expanded ? 'Collapse navigation labels' : 'Show navigation labels'}
          onClick={toggleExpanded}
        >
          {expanded ? <ChevronsLeft size={14} /> : <ChevronsRight size={14} />}
          {expanded && 'Collapse'}
        </button>
      </div>
    </aside>
  );
}

export function TitleBar({ projects, activeProject, theme, leftOpen, rightOpen, previewOpen, terminalOpen, shortcuts, onChoose, onOpenProject, onRemoveProject, onClearProjects, onNewWindow, onSetTheme, onOpenSearch, onOpenShortcuts, onToggleThreads, onToggleContext, onTogglePreview, onToggleTerminal, onOpenTour, tourListOpen }: { projects: ProjectRecord[]; activeProject: ProjectRecord | null; theme: ThemeMode; leftOpen: boolean; rightOpen: boolean; previewOpen: boolean; terminalOpen: boolean; shortcuts: AppSettings['shortcuts']; onChoose: () => void; onOpenProject: (id: string) => void; onRemoveProject: (id: string) => void; onClearProjects: () => void; onNewWindow: () => void; onSetTheme: (theme: ThemeMode) => void; onOpenSearch: () => void; onOpenShortcuts: () => void; onToggleThreads: () => void; onToggleContext: () => void; onTogglePreview: () => void; onToggleTerminal: () => void; onOpenTour: () => void; tourListOpen: boolean }): ReactNode {
  const newWindowShortcut = shortcutLabel(shortcuts, 'new-window');
  const searchShortcut = shortcutLabel(shortcuts, 'command-palette');
  const threadsShortcut = shortcutLabel(shortcuts, 'threads');
  const contextShortcut = shortcutLabel(shortcuts, 'context-panel');
  const sheetShortcut = shortcutLabel(shortcuts, 'shortcuts');
  const iconClass = (on: boolean): string => `grid h-[30px] w-[30px] shrink-0 cursor-pointer place-items-center rounded-lg border-0 focus:outline-none focus-visible:bg-[var(--bg-hover)] ${on ? 'bg-[var(--selection)] text-[var(--accent)]' : 'bg-transparent text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]'}`;
  return (
    <header className="titlebar">
      <img src={kaiIcon} alt="KAi" className="brand-mark mr-2.5 h-6 w-6 shrink-0 rounded-md object-contain" />
      <div className="titlebar-drag">
        <ProjectPicker projects={projects} activeProject={activeProject} onChoose={onChoose} onOpen={onOpenProject} onRemove={onRemoveProject} onClear={onClearProjects} />
      </div>
      <div className="titlebar-actions">
        <button type="button" className={iconClass(false)} title={`Command palette${searchShortcut ? ` (${searchShortcut})` : ''}`} aria-label="Open command palette" onClick={onOpenSearch}><Search size={15} /></button>
        <button type="button" className={iconClass(leftOpen)} title={leftOpen ? `Hide threads panel${threadsShortcut ? ` (${threadsShortcut})` : ''}` : `Show threads panel${threadsShortcut ? ` (${threadsShortcut})` : ''}`} aria-label={leftOpen ? 'Hide threads panel' : 'Show threads panel'} aria-pressed={leftOpen} onClick={onToggleThreads}>
          {leftOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
        </button>
        <button type="button" className={iconClass(rightOpen)} title={rightOpen ? `Hide context panel${contextShortcut ? ` (${contextShortcut})` : ''}` : `Show context panel${contextShortcut ? ` (${contextShortcut})` : ''}`} aria-label={rightOpen ? 'Hide context panel' : 'Show context panel'} aria-pressed={rightOpen} onClick={onToggleContext}>
          {rightOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
        </button>
        <button type="button" className={iconClass(previewOpen)} title={previewOpen ? 'Hide live preview pane' : 'Show live preview pane'} aria-label={previewOpen ? 'Hide live preview pane' : 'Show live preview pane'} aria-pressed={previewOpen} onClick={onTogglePreview}><MonitorPlay size={15} /></button>
        <button type="button" className={iconClass(terminalOpen)} title={terminalOpen ? 'Hide terminal (Ctrl+`)' : 'Show terminal (Ctrl+`)'} aria-label={terminalOpen ? 'Hide terminal' : 'Show terminal'} aria-pressed={terminalOpen} onClick={onToggleTerminal}><Terminal size={15} /></button>
        <ActionsMenu
          ariaLabel="Theme"
          items={THEME_MODES.map((item) => ({ key: item.id, label: item.label, icon: item.id === theme ? <Check size={14} /> : <span style={{ width: 14 }} />, onSelect: () => onSetTheme(item.id) }))}
          trigger={({ onClick, expanded }) => (
            <button type="button" className={iconClass(false)} title={`Theme: ${themeLabel(theme)}`} aria-label="Choose theme" aria-expanded={expanded} onClick={onClick}><Palette size={15} /></button>
          )}
        />
        <MoreMenu
          items={[
            { label: 'New window', hint: newWindowShortcut, icon: <AppWindow size={15} />, onSelect: onNewWindow },
            { label: 'Guided tour and lessons', hint: '', icon: <GraduationCap size={15} />, onSelect: onOpenTour, active: tourListOpen },
            { label: 'Keyboard shortcuts', hint: sheetShortcut, icon: <Keyboard size={15} />, onSelect: onOpenShortcuts },
          ]}
          triggerClass={iconClass(false)}
        />
      </div>
    </header>
  );
}

interface MoreMenuItem { label: string; hint: string; icon: ReactNode; onSelect: () => void; active?: boolean }

function MoreMenu({ items, triggerClass }: { items: MoreMenuItem[]; triggerClass: string }): ReactNode {
  return (
    <Dropdown
      className="titlebar-more-dropdown"
      placement="bottom-end"
      arrowIcon={false}
      label="More"
      renderTrigger={() => <button type="button" className={triggerClass} title="More" aria-label="More"><Ellipsis size={15} /></button>}
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
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event: PointerEvent): void => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [open]);
  const itemClass = 'flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg border-0 bg-transparent px-2 py-1.5 text-left text-xs text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] focus:outline-none focus-visible:bg-[var(--bg-hover)]';
  return (
    <div ref={rootRef} className="project-picker relative flex h-full min-w-0 items-center">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="project-picker-button flex h-8 min-w-0 max-w-[min(34rem,42vw)] cursor-pointer items-center gap-2.5 rounded-[10px] border border-[color:var(--border-soft)] bg-[var(--bg-raised)] px-2 text-left hover:border-[color:var(--border)] focus:outline-none"
      >
        <span className="project-glyph grid h-5 w-5 shrink-0 place-items-center rounded-md bg-[var(--selection)] text-[11px] font-bold text-[var(--accent)]">{activeProject ? activeProject.name.slice(0, 1).toUpperCase() : <FolderOpen size={12} />}</span>
        <span className="min-w-0 truncate whitespace-nowrap text-[13px]"><strong className="font-semibold text-[var(--text)]">{activeProject?.name ?? 'No project'}</strong> <small className="text-[11.5px] text-[var(--text-dim)]">{activeProject?.path ?? 'Open a local repository'}</small></span>
        <ChevronDown size={13} className="shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
      </button>
      {open && (
        <div role="menu" className="absolute left-0 top-[calc(100%-2px)] z-40 w-[22rem] rounded-xl border border-[color:var(--border)] bg-[var(--bg-raised)] p-1.5 shadow-[0_18px_44px_rgba(0,0,0,0.45)]">
          <div className="px-2 pb-1 pt-1 text-[10.5px] font-medium uppercase tracking-[0.07em] text-[var(--text-dim)]">Recent projects</div>
          {/* The row is the way in; the small control beside it is the way out, so a list that has collected a
              folder twice, or one renamed since, can be tidied without opening it first. */}
          {projects.map((project) => {
            const current = project.id === activeProject?.id;
            return (
              <div key={project.id} className={`flex items-center rounded-lg ${current ? 'bg-[var(--selection)]' : ''}`}>
                <button type="button" role="menuitem" className={`${itemClass} ${current ? '!text-[var(--text)]' : ''}`} onClick={() => { onOpen(project.id); setOpen(false); }}>
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-[var(--bg-hover)] text-[11px] font-bold text-[var(--accent)]">{project.name.slice(0, 1).toUpperCase()}</span>
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  {current && <Check size={14} className="shrink-0 text-[var(--accent)]" aria-hidden="true" />}
                </button>
                <button
                  type="button"
                  title={`Remove ${project.name} from the list`}
                  aria-label={`Remove ${project.name} from the list`}
                  onClick={() => onRemove(project.id)}
                  className="mr-1 grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-[var(--text-dim)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] focus:outline-none"
                ><X size={13} /></button>
              </div>
            );
          })}
          <div className="my-1 h-px bg-[var(--border-soft)]" />
          <button type="button" role="menuitem" className={itemClass} onClick={() => { onChoose(); setOpen(false); }}><Plus size={14} /><span>Open project</span></button>
          {projects.length > 0 && (
            <button type="button" role="menuitem" className={`${itemClass} project-clear`} onClick={() => { onClear(); setOpen(false); }}><Trash2 size={14} /><span>Clear list</span></button>
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
    <aside className="conversation-sidebar flex h-full w-full min-w-0 flex-col bg-[var(--bg-shell)]">
      <div className="flex items-center gap-1 border-b border-[color:var(--border-soft)] pl-2 pr-2">
        <TabBar
          label="Left panel"
          value={tab}
          onChange={setTab}
          className="!border-b-0 !px-0"
          tabs={[{ id: 'threads', label: 'Threads' }, { id: 'files', label: 'Files' }]}
        />
        <span className="flex-1" />
        <IconButton aria-label="New conversation" title="New conversation" onClick={onNew} icon={<Plus size={15} />} />
        <IconButton aria-label="Hide threads panel" title="Hide threads panel (Ctrl+Shift+B)" onClick={onCollapse} icon={<PanelLeftClose size={14} />} />
      </div>
      {tab === 'files' && <ProjectFilesPanel projectId={projectId} refreshKey={filesRefreshKey} onOpenFile={onOpenFile} />}
      {tab === 'threads' && (
        <div className="conversation-list kai-scroll-hidden min-h-0 flex-1 overflow-y-auto p-2">
          {conversations.length === 0 && <div className="rounded-[var(--radius-control)] border border-dashed border-[color:var(--border)] p-2.5 text-center text-xs text-[var(--text-dim)]">No conversations</div>}
          {conversations.map((conversation) => {
            const active = conversation.id === activeId;
            return (
              <div key={conversation.id} className={`group relative my-px flex items-center rounded-lg ${active ? 'bg-[var(--selection)]' : 'hover:bg-[var(--bg-hover)]'}`}>
                <button type="button" onClick={() => onOpen(conversation.id)} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 whitespace-nowrap rounded-lg border-0 bg-transparent px-2.5 py-1.5 text-left text-[12.5px] focus:outline-none focus-visible:bg-[var(--bg-hover)]">
                  <span className={`min-w-0 flex-1 truncate ${active ? 'text-[var(--text)]' : 'text-[var(--text-muted)]'}`}>{conversation.title}</span>
                  <span className="shrink-0 text-[11px] text-[var(--text-dim)]">{relativeTime(conversation.updatedAt)}</span>
                </button>
                <button type="button" title="Delete conversation" aria-label={`Delete ${conversation.title}`} onClick={() => onDelete(conversation.id)} className="mr-1 hidden h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-[var(--text-dim)] hover:bg-[var(--bg-hover)] hover:text-[var(--danger)] focus:outline-none group-hover:grid group-focus-within:grid"><Trash2 size={13} /></button>
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}
