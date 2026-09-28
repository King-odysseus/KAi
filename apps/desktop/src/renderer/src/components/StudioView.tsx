import { AlertTriangle, Archive, ArchiveRestore, ArrowLeft, Check, Code2, Eye, FileText, FolderOpen, FolderPlus, LayoutGrid, Loader2, NotebookPen, Palette, Play, Plus, RefreshCw, RotateCcw, Send, Settings, SkipForward, Sparkles, Trash2, Users, Wand2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import {
  ARTIFACT_KINDS,
  BOARD_STATUSES,
  interviewGivenAnswers,
  interviewOpenQuestions,
  STUDIO_MAX_ROUNDS,
  type ArtifactKind,
  type BoardCard,
  type BoardStatus,
  type InterviewState,
  type ProjectRecord,
  type StudioArtifacts,
  type StudioBoard,
  type StudioDesign,
  type StudioProjectSummary,
  type StudioReadiness,
  type TeamPlanDraft,
} from '@kai/contracts';
import { relativeTime, unwrap } from '../types';
import { confirmDialog } from './AppDialog';

/**
 * The Project Studio. The first part of it is the interview: one paragraph in, a short set of skippable questions,
 * and `.kai/spec/brief.md` out. The artifacts, the board and the design layer all read that brief, so this screen
 * is the front door to the rest of the studio.
 */
export function StudioView({ activeProject, projects: desktopProjects, onOpenSettings, onLaunchProject, onPlanForTeam }: {
  activeProject: ProjectRecord | null;
  projects: ProjectRecord[];
  onOpenSettings: () => void;
  onLaunchProject: (studioProjectId: string, destination: 'composer' | 'editor') => Promise<void>;
  onPlanForTeam: (plan: TeamPlanDraft) => void;
}): ReactNode {
  const [screen, setScreen] = useState<'list' | 'project' | 'new'>('list');
  const [viewedProjectId, setViewedProjectId] = useState<string | null>(null);
  const [draftProjectId, setDraftProjectId] = useState<string | null>(null);
  const [projects, setProjects] = useState<StudioProjectSummary[]>([]);
  const [projectsBusy, setProjectsBusy] = useState(true);
  const [projectsVersion, setProjectsVersion] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
  const [readiness, setReadiness] = useState<StudioReadiness | null>(null);
  const [state, setState] = useState<InterviewState | null>(null);
  const [artifacts, setArtifacts] = useState<StudioArtifacts | null>(null);
  const [board, setBoard] = useState<StudioBoard | null>(null);
  const [idea, setIdea] = useState('');
  const [answers, setAnswers] = useState<string[]>([]);
  const [busy, setBusy] = useState<'load' | 'start' | 'answer' | 'finish' | 'reset' | 'generate' | 'plan' | 'card' | 'team' | 'work' | 'design' | 'archive' | 'delete' | 'folder' | 'launch' | null>(null);
  const [useCurrentFolder, setUseCurrentFolder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [design, setDesign] = useState<StudioDesign | null>(null);
  const projectId = screen === 'project' ? viewedProjectId : screen === 'new' ? draftProjectId : null;
  const viewedProject = projects.find((project) => project.id === viewedProjectId) ?? null;
  const projectTitle = state?.goal.trim() || state?.idea.trim() || viewedProject?.title || 'New project';
  const activeProjects = projects.filter((project) => !project.archivedAt);
  const archivedProjects = projects.filter((project) => Boolean(project.archivedAt));
  const visibleProjects = showArchived ? archivedProjects : activeProjects;
  const currentFolder = activeProject && !activeProject.id.startsWith('studio_') ? activeProject : null;

  useEffect(() => {
    let cancelled = false;
    setProjectsBusy(true);
    void window.kaiDesktop.studioProjects().then(unwrap).then((next) => {
      if (!cancelled) setProjects(next);
    }).catch((caught) => {
      if (!cancelled) setError(messageOf(caught));
    }).finally(() => {
      if (!cancelled) setProjectsBusy(false);
    });
    return () => { cancelled = true; };
  }, [projectsVersion]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setState(null);
    setArtifacts(null);
    setBoard(null);
    setDesign(null);
    setIdea('');
    setAnswers([]);
    setNotice(null);
    if (!projectId) {
      setBusy(null);
      return () => { cancelled = true; };
    }
    setBusy('load');
    void Promise.all([
      window.kaiDesktop.studioReadiness().then(unwrap),
      projectId ? window.kaiDesktop.studioInterview(projectId).then(unwrap) : Promise.resolve(null),
      projectId ? window.kaiDesktop.studioArtifacts(projectId).then(unwrap) : Promise.resolve(null),
      projectId ? window.kaiDesktop.studioBoard(projectId).then(unwrap) : Promise.resolve(null),
      projectId ? window.kaiDesktop.studioDesign(projectId).then(unwrap) : Promise.resolve(null),
    ]).then(([nextReadiness, interview, nextArtifacts, nextBoard, nextDesign]) => {
      if (cancelled) return;
      setReadiness(nextReadiness);
      setState(interview);
      setArtifacts(nextArtifacts);
      setBoard(nextBoard);
      setDesign(nextDesign);
      if (interview) setIdea(interview.idea);
      setAnswers(interview ? interviewOpenQuestions(interview).map(() => '') : []);
    }).catch((caught) => {
      if (!cancelled) setError(messageOf(caught));
    }).finally(() => {
      if (!cancelled) setBusy(null);
    });
    return () => { cancelled = true; };
  }, [projectId]);

  // The board is shared work: an agent, or the other window, can move a card while this screen is open.
  useEffect(() => {
    if (!projectId) return undefined;
    return window.kaiDesktop.onStudioBoardChanged((payload) => {
      if (payload.projectId === projectId) setBoard(payload.board);
    });
  }, [projectId]);

  function openProjectStudio(nextProjectId: string): void {
    if (!nextProjectId || nextProjectId === projectId || busy !== null) return;
    setError(null);
    setNotice(null);
    setViewedProjectId(nextProjectId);
    setDraftProjectId(null);
    setScreen('project');
  }

  function startNewProject(): void {
    if (busy !== null) return;
    setError(null);
    setNotice(null);
    setViewedProjectId(null);
    setDraftProjectId(`studio_${crypto.randomUUID()}`);
    setUseCurrentFolder(false);
    setScreen('new');
  }

  function leaveProjectStudio(): void {
    setScreen('list');
    setViewedProjectId(null);
    setDraftProjectId(null);
    setError(null);
    setNotice(null);
    setProjectsVersion((current) => current + 1);
  }

  async function toggleArchive(project: StudioProjectSummary): Promise<void> {
    if (busy !== null) return;
    setBusy('archive');
    setError(null);
    try {
      const next = unwrap(await window.kaiDesktop.setStudioProjectArchived({ projectId: project.id, archived: !project.archivedAt }));
      setProjects((current) => current.map((item) => (item.id === next.id ? next : item)));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  async function deleteProject(project: StudioProjectSummary): Promise<void> {
    if (busy !== null) return;
    const confirmed = await confirmDialog({
      title: 'Delete this project?',
      detail: 'This permanently removes the Studio discussion and any brief or artifacts kept in its Studio workspace. Files in a separate code project are not touched.',
      confirmLabel: 'Delete project',
      destructive: true,
    });
    if (!confirmed) return;
    setBusy('delete');
    setError(null);
    try {
      unwrap(await window.kaiDesktop.deleteStudioProject(project.id));
      setProjects((current) => current.filter((item) => item.id !== project.id));
      if (viewedProjectId === project.id) {
        setViewedProjectId(null);
        setScreen('list');
      }
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  async function chooseProjectFolder(studioProjectId: string): Promise<void> {
    if (busy !== null) return;
    setBusy('folder');
    setError(null);
    try {
      const folder = unwrap(await window.kaiDesktop.chooseStudioProjectFolder({ projectId: studioProjectId }));
      if (!folder) return;
      setNotice(`Created the project folder "${folder.projectName}".`);
      setProjectsVersion((current) => current + 1);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  async function launchProject(studioProjectId: string, destination: 'composer' | 'editor'): Promise<void> {
    if (busy !== null) return;
    setBusy('launch');
    setError(null);
    try {
      await onLaunchProject(studioProjectId, destination);
    } catch (caught) {
      setError(messageOf(caught));
      setBusy(null);
    }
  }

  function linkedProjectName(linkedProjectId: string | null): string {
    if (!linkedProjectId) return 'Studio workspace only';
    return desktopProjects.find((project) => project.id === linkedProjectId)?.name ?? 'Linked folder';
  }

  function adopt(next: InterviewState): void {
    setState(next);
    setAnswers(interviewOpenQuestions(next).map(() => ''));
  }

  async function reloadReadiness(): Promise<void> {
    setBusy('load');
    setError(null);
    try {
      setReadiness(unwrap(await window.kaiDesktop.studioReadiness()));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  async function start(): Promise<void> {
    if (!projectId || !idea.trim()) return;
    setBusy('start');
    setError(null);
    try {
      const next = unwrap(await window.kaiDesktop.startStudioInterview({
        projectId,
        idea: idea.trim(),
        linkedProjectId: useCurrentFolder && currentFolder ? currentFolder.id : null,
      }));
      adopt(next);
      setViewedProjectId(projectId);
      setDraftProjectId(null);
      setScreen('project');
      setProjectsVersion((current) => current + 1);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  /** Sends the round on screen. A blank answer is sent as a skip, which tells the studio to decide that one itself. */
  async function sendAnswers(): Promise<void> {
    if (!projectId || !state) return;
    setBusy('answer');
    setError(null);
    try {
      adopt(unwrap(await window.kaiDesktop.answerStudioInterview({
        projectId,
        answers: interviewOpenQuestions(state).map((question, index) => ({ question, answer: (answers[index] ?? '').trim() })),
      })));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  async function finish(): Promise<void> {
    if (!projectId) return;
    setBusy('finish');
    setError(null);
    try {
      adopt(unwrap(await window.kaiDesktop.finishStudioInterview(projectId)));
      setProjectsVersion((current) => current + 1);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  async function reset(): Promise<void> {
    if (!projectId) return;
    const confirmed = await confirmDialog({
      title: 'Start over?',
      detail: 'This clears the questions and answers kept for this project. Any brief already written under .kai/spec stays on disk.',
      confirmLabel: 'Start over',
      destructive: true,
    });
    if (!confirmed) return;
    setBusy('reset');
    setError(null);
    try {
      unwrap(await window.kaiDesktop.resetStudioInterview(projectId));
      setState(null);
      setIdea('');
      setAnswers([]);
      setScreen('list');
      setViewedProjectId(null);
      setDraftProjectId(null);
      setProjectsVersion((current) => current + 1);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  /** Runs the model over the whole artifact set. Each artifact is one call, so this is the expensive button. */
  async function generate(): Promise<void> {
    if (!projectId) return;
    setBusy('generate');
    setError(null);
    try {
      setArtifacts(unwrap(await window.kaiDesktop.generateStudioArtifacts(projectId)));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  async function generateOne(kind: ArtifactKind): Promise<void> {
    if (!projectId) return;
    setBusy('generate');
    setError(null);
    try {
      setArtifacts(unwrap(await window.kaiDesktop.generateStudioArtifact({ projectId, kind })));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  async function plan(): Promise<void> {
    if (!projectId) return;
    setBusy('plan');
    setError(null);
    try {
      setBoard(unwrap(await window.kaiDesktop.planStudioBoard(projectId)));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  /** Reads the design from open-pencil: the tokens go to `.kai/spec`, and a changed node restales its card. */
  async function pullDesign(): Promise<void> {
    if (!projectId) return;
    setBusy('design');
    setError(null);
    try {
      const pulled = unwrap(await window.kaiDesktop.pullStudioDesign(projectId));
      setDesign(pulled.design);
      setBoard(pulled.board);
      setArtifacts(unwrap(await window.kaiDesktop.studioArtifacts(projectId)));
      setNotice(
        pulled.changed.length > 0
          ? `Pulled the design: ${pulled.changed.length} node${pulled.changed.length === 1 ? '' : 's'} changed, so the cards drawn from them are stale.`
          : pulled.tokensChanged
            ? `Pulled the design: ${pulled.tokenCount} token${pulled.tokenCount === 1 ? '' : 's'} written and no node had moved.`
            : 'The design has not changed since the last pull.',
      );
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  async function move(cardId: string, status: BoardStatus): Promise<void> {
    if (!projectId) return;
    setBusy('card');
    setError(null);
    try {
      const moved = unwrap(await window.kaiDesktop.moveStudioCard({ projectId, cardId, status, note: '' }));
      setBoard((current) => (current ? { ...current, cards: current.cards.map((card) => (card.id === moved.id ? moved : card)) } : current));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  /** Runs the screenshots-and-DOM check on a UI card. The board it returns already reflects the result. */
  async function checkUi(cardId: string): Promise<void> {
    if (!projectId) return;
    setBusy('card');
    setError(null);
    try {
      unwrap(await window.kaiDesktop.checkStudioCardUi(projectId, cardId));
      setBoard(unwrap(await window.kaiDesktop.studioBoard(projectId)));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  /** One part per ready card, handed to the Workflows page, where the user reviews and starts it. */
  async function planForTeam(): Promise<void> {
    if (!projectId) return;
    setBusy('team');
    setError(null);
    try {
      onPlanForTeam(unwrap(await window.kaiDesktop.planStudioTeam(projectId)));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  /** Runs the next ready card with one agent. The agent reports; the board decides what the card's status is. */
  async function workCard(): Promise<void> {
    if (!projectId) return;
    setBusy('work');
    setError(null);
    try {
      unwrap(await window.kaiDesktop.workStudioBoard({ projectId, maxCards: 1 }));
      setBoard(unwrap(await window.kaiDesktop.studioBoard(projectId)));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  const open = state ? interviewOpenQuestions(state) : [];
  const asking = state?.status === 'asking';
  const decided = state ? interviewGivenAnswers(state) : [];
  const briefReady = Boolean(artifacts?.artifacts.some((entry) => entry.kind === 'brief'));
  const staleCount = artifacts?.artifacts.filter((entry) => entry.stale).length ?? 0;

  if (screen === 'list') {
    return (
      <div className="page-view studio-view">
        <div className="studio-scroll">
          <header className="page-header">
            <div>
              <h1>Project Studio</h1>
              <p>Projects you have discussed in Studio, kept separately from the folders in the Projects page.</p>
            </div>
            <div className="page-actions">
              {!projectsBusy && projects.length > 0 && (
                <span className="studio-model">
                  {showArchived ? archivedProjects.length : activeProjects.length} {(showArchived ? archivedProjects.length : activeProjects.length) === 1 ? 'project' : 'projects'}
                </span>
              )}
              {projects.length > 0 && (
                <button type="button" className="secondary-button" onClick={() => setShowArchived((current) => !current)}>
                  {showArchived ? <NotebookPen size={14} /> : <Archive size={14} />}
                  {showArchived ? 'Active projects' : `Archived (${archivedProjects.length})`}
                </button>
              )}
              {projects.length > 0 && (
                <button type="button" className="primary-button" onClick={startNewProject}>
                  <Plus size={14} /> Plan a new project
                </button>
              )}
            </div>
          </header>

          {error && <p className="studio-notice error" role="alert"><AlertTriangle size={14} /> {error}</p>}
          {notice && <p className="studio-notice" role="status"><Check size={14} /> {notice}</p>}

          <section className="studio-project-start">
            <div className="studio-project-start-head">
              <div>
                <h2>{showArchived ? 'Archived projects' : 'Your projects'}</h2>
                <p>{showArchived ? 'Restore a discussion to move it back into the active list.' : 'Open a discussion to continue the brief, review the artifacts, or work the board.'}</p>
              </div>
            </div>
            {projectsBusy ? (
              <div className="empty-list"><Loader2 className="spin" size={14} /> Loading your projects…</div>
            ) : visibleProjects.length > 0 ? (
              <div className="studio-project-grid">
                {visibleProjects.map((project) => (
                  <article key={project.id} className={`studio-project-card${project.archivedAt ? ' archived' : ''}`}>
                    <div className="studio-project-card-head">
                      <div className="studio-project-glyph">{project.title.slice(0, 1).toUpperCase()}</div>
                      <div className="studio-project-card-copy">
                        <div className="studio-project-card-title">
                          <strong>{project.title}</strong>
                          <span className={`studio-project-status ${project.archivedAt ? 'archived' : project.status}`}>
                            {project.archivedAt ? 'Archived' : project.status === 'done' ? 'Brief ready' : 'In discussion'}
                          </span>
                        </div>
                        <p>{project.idea}</p>
                        <small>{project.archivedAt ? `Archived ${relativeTime(project.archivedAt)}` : `Updated ${relativeTime(project.updatedAt)}`}</small>
                        <small>{project.linkedProjectId ? `Folder: ${linkedProjectName(project.linkedProjectId)}` : 'Independent Studio workspace'}</small>
                      </div>
                    </div>
                    <div className="studio-project-card-actions">
                      {!project.archivedAt && project.status === 'done' ? (
                        <>
                          <button type="button" className="primary-button" onClick={() => void launchProject(project.id, 'composer')} disabled={busy !== null}>
                            {busy === 'launch' ? <Loader2 className="spin" size={14} /> : <Send size={14} />}
                            <span>Start on composer</span>
                          </button>
                          <button type="button" className="secondary-button" onClick={() => void launchProject(project.id, 'editor')} disabled={busy !== null}>
                            <Code2 size={14} />
                            <span>Open in code editor</span>
                          </button>
                          {!project.linkedProjectId && (
                            <button type="button" className="secondary-button" onClick={() => void chooseProjectFolder(project.id)} disabled={busy !== null}>
                              {busy === 'folder' ? <Loader2 className="spin" size={14} /> : <FolderPlus size={14} />}
                              <span>Create folder</span>
                            </button>
                          )}
                          <button type="button" className="icon-button" onClick={() => openProjectStudio(project.id)} disabled={busy !== null} title={`Open Studio for ${project.title}`} aria-label={`Open Studio for ${project.title}`}>
                            <LayoutGrid size={15} />
                          </button>
                        </>
                      ) : (
                        <button type="button" className="primary-button" onClick={() => openProjectStudio(project.id)} disabled={busy !== null}>
                          <Play size={14} />
                          <span>Open Studio</span>
                        </button>
                      )}
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => void toggleArchive(project)}
                        disabled={busy !== null}
                        title={project.archivedAt ? `Restore ${project.title}` : `Archive ${project.title}`}
                        aria-label={project.archivedAt ? `Restore ${project.title}` : `Archive ${project.title}`}
                      >
                        {busy === 'archive' ? <Loader2 className="spin" size={15} /> : project.archivedAt ? <ArchiveRestore size={15} /> : <Archive size={15} />}
                      </button>
                      <button
                        type="button"
                        className="icon-button danger"
                        onClick={() => void deleteProject(project)}
                        disabled={busy !== null}
                        title={`Delete ${project.title}`}
                        aria-label={`Delete ${project.title}`}
                      >
                        {busy === 'delete' ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="studio-project-empty">
                <span className="studio-project-empty-icon">{showArchived ? <Archive size={22} /> : <NotebookPen size={22} />}</span>
                <h3>{showArchived ? 'No archived projects' : projects.length === 0 ? 'Start your first Studio project' : 'No active projects'}</h3>
                <p>
                  {showArchived
                    ? 'Projects you archive will stay here until you restore or delete them.'
                    : 'Describe the idea, answer a few quick questions, and Studio will save the brief here when the discussion starts.'}
                </p>
                {!showArchived && (
                  <button type="button" className="primary-button" onClick={startNewProject}>
                    <Plus size={14} /> Plan a new project
                  </button>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="page-view studio-view">
      <div className="studio-scroll">
      <header className="page-header">
        <div>
          <h1>Project Studio</h1>
          <p>{state ? 'Continue the discussion, review the brief, or turn it into artifacts and work for the team.' : 'Describe the project in a paragraph. Studio asks what it still needs to know, then saves the brief with the project.'}</p>
        </div>
        <div className="page-actions">
          {readiness && <span className="studio-model">{readiness.ready ? `${readiness.displayName} · ${readiness.model}` : 'Needs setup'}</span>}
          <button type="button" className="secondary-button" onClick={() => void reloadReadiness()} disabled={busy !== null}>
            {busy === 'load' ? <Loader2 className="spin" size={14} /> : <Sparkles size={14} />} Check connection
          </button>
          {state?.status === 'done' && projectId && (
            <>
              <button type="button" className="primary-button" onClick={() => void launchProject(projectId, 'composer')} disabled={busy !== null}>
                {busy === 'launch' ? <Loader2 className="spin" size={14} /> : <Send size={14} />} Start on composer
              </button>
              <button type="button" className="secondary-button" onClick={() => void launchProject(projectId, 'editor')} disabled={busy !== null}>
                <Code2 size={14} /> Open in code editor
              </button>
              {!state.linkedProjectId && (
                <button type="button" className="secondary-button" onClick={() => void chooseProjectFolder(projectId)} disabled={busy !== null}>
                  {busy === 'folder' ? <Loader2 className="spin" size={14} /> : <FolderPlus size={14} />} Create folder
                </button>
              )}
            </>
          )}
          {state && <button type="button" className="secondary-button" onClick={() => void reset()} disabled={busy !== null}><RotateCcw size={14} /> Start over</button>}
        </div>
      </header>

      <div className="studio-project-bar studio-project-bar-active">
        <button type="button" className="secondary-button" onClick={leaveProjectStudio} disabled={busy !== null}>
          <ArrowLeft size={14} />
          All projects
        </button>
        <div className="studio-project-picker">
          <span className="studio-project-icon"><NotebookPen size={17} /></span>
          <div>
            <span className="studio-project-label">{screen === 'new' ? 'New project' : state?.status === 'done' ? 'Brief ready' : 'In discussion'}</span>
            <strong>{projectTitle}</strong>
            <small className="studio-workspace-note">
              <FolderOpen size={11} />
              {screen === 'new'
                ? useCurrentFolder && currentFolder
                  ? `Using ${currentFolder.name}`
                  : 'Independent Studio workspace'
                : state?.linkedProjectId
                  ? `Using ${linkedProjectName(state.linkedProjectId)}`
                  : 'Independent Studio workspace'}
            </small>
          </div>
        </div>
      </div>

      {error && <p className="studio-notice error" role="alert"><AlertTriangle size={14} /> {error}</p>}
      {notice && <p className="studio-notice" role="status"><Check size={14} /> {notice}</p>}
      {readiness && !readiness.ready && (
        <p className="studio-notice warning" role="status">
          <AlertTriangle size={14} />
          <span>{readiness.reason ?? 'The Project Studio is not ready.'}</span>
          <button type="button" className="secondary-button" onClick={onOpenSettings}><Settings size={13} /> Open Settings</button>
        </p>
      )}

      <section className={`studio-grid${state ? '' : ' studio-grid-intake'}`}>
        {state && (
          <article className="studio-card">
            <h2><NotebookPen size={16} /> The idea</h2>
            {state.status === 'done' ? (
              <>
                <p className="studio-goal">{state.goal || state.idea}</p>
                <p className="studio-note"><FileText size={13} /> Written to <code>{state.briefPath ?? '.kai/spec/brief.md'}</code></p>
                <p className="studio-note">The artifacts, the board, and the design layer are built from this brief. Scroll down to review them.</p>
              </>
            ) : (
              <>
                <p className="studio-goal">{state.goal || state.idea}</p>
                <p className="studio-note">Interview in progress. A blank answer counts as a skip, and the studio decides those itself.</p>
              </>
            )}
          </article>
        )}

        <article className="studio-card">
          <h2><Sparkles size={16} /> Questions</h2>
          {busy === 'load' && <p className="studio-note"><Loader2 className="spin" size={13} /> Reading the project…</p>}
          {busy !== 'load' && !state && <p className="studio-note">Nothing to answer yet. Describe the idea below and start.</p>}
          {state?.status === 'done' && (
            <>
              <p className="studio-note"><Check size={13} /> The interview is finished.</p>
              {state.assumptions.length > 0 && <Notes title="Assumed" items={state.assumptions} />}
              {decided.length > 0 && (
                <>
                  <h3>Decided</h3>
                  <dl className="studio-decisions">
                    {decided.map((item) => <div key={item.question}><dt>{item.question}</dt><dd>{item.answer}</dd></div>)}
                  </dl>
                </>
              )}
            </>
          )}
          {asking && state && (
            <>
              <p className="studio-note">Round {state.rounds.length} of {STUDIO_MAX_ROUNDS}. Skip anything you would rather leave to the agents.</p>
              {state.goal && <p className="studio-goal">{state.goal}</p>}
              {state.assumptions.length > 0 && <Notes title="Assumed so far" items={state.assumptions} />}
              {open.map((question, index) => (
                <label key={question} className="studio-question">
                  <span>{question}</span>
                  <textarea
                    value={answers[index] ?? ''}
                    onChange={(event) => setAnswers((current) => current.map((value, position) => (position === index ? event.target.value : value)))}
                    rows={3}
                    placeholder="Answer, or leave it blank to skip"
                    disabled={busy !== null}
                  />
                </label>
              ))}
              {open.length === 0 && <p className="studio-note">No questions this round.</p>}
              <div className="studio-actions">
                <button type="button" className="primary-button" onClick={() => void sendAnswers()} disabled={busy !== null}>
                  {busy === 'answer' ? <Loader2 className="spin" size={14} /> : <SkipForward size={14} />} Send answers
                </button>
                <button type="button" className="secondary-button" onClick={() => void finish()} disabled={busy !== null}>
                  {busy === 'finish' ? <Loader2 className="spin" size={14} /> : <FileText size={14} />} Write the brief now
                </button>
              </div>
            </>
          )}
        </article>
      </section>

      {state && briefReady && (
        <section className="studio-stack">
          <article className="studio-card">
            <h2><FileText size={16} /> Artifacts</h2>
            <p className="studio-note">
              One file each under <code>.kai/spec</code>. Regenerating one flags everything that reads it stale, so the board never trusts a document built on an old decision.
            </p>
            <div className="page-actions">
              <button type="button" className="primary-button" onClick={() => void generate()} disabled={busy !== null || !readiness?.ready}>
                {busy === 'generate' ? <Loader2 className="spin" size={14} /> : <Wand2 size={14} />} Generate all
              </button>
              {staleCount > 0 && <span className="studio-model">{staleCount} stale</span>}
            </div>
            <ul className="studio-artifacts">
              {ARTIFACT_KINDS.map((kind) => {
                const entry = artifacts?.artifacts.find((item) => item.kind === kind);
                return (
                  <li key={kind} className={entry?.stale ? 'stale' : undefined}>
                    <div>
                      <strong>{kind}</strong>
                      <span className="studio-note">
                        {entry ? <>{entry.generatedBy} · v{entry.version}{entry.stale ? ` · ${entry.staleReason ?? 'stale'}` : ''}</> : 'Not written yet'}
                      </span>
                    </div>
                    {kind !== 'brief' && kind !== 'tokens' && (
                      <button type="button" className="secondary-button" onClick={() => void generateOne(kind)} disabled={busy !== null || !readiness?.ready}>
                        {entry ? <RefreshCw size={13} /> : <Play size={13} />} {entry ? 'Regenerate' : 'Generate'}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </article>

          <article className="studio-card">
            <h2><Palette size={16} /> Design</h2>
            <p className="studio-note">
              open-pencil is the source of truth for tokens and for which screens exist. Pulling writes <code>.kai/spec/design/tokens.json</code> (the style guide is written from those tokens), gives each component and page its card, and marks the cards drawn from a node you changed. The editor has to be running with the same token KAI holds in Settings.
            </p>
            <div className="page-actions">
              <button type="button" className="secondary-button" onClick={() => void pullDesign()} disabled={busy !== null}>
                {busy === 'design' ? <Loader2 className="spin" size={14} /> : <Palette size={14} />} Pull the design
              </button>
              {design?.pulledAt && design.pulledAt !== new Date(0).toISOString() && (
                <span className="studio-model">{design.components.length} in the design · last pulled {design.pulledAt.slice(0, 16).replace('T', ' ')}</span>
              )}
            </div>
            {design && design.components.length > 0 && (
              <ul className="studio-list">
                {design.components.slice(0, 20).map((component) => (
                  <li key={component.id}>{component.name} <span className="studio-kind">{component.screen ? 'page' : 'component'}</span></li>
                ))}
              </ul>
            )}
          </article>

          <article className="studio-card">
            <h2><LayoutGrid size={16} /> Board</h2>
            <p className="studio-note">Cards built from the stories. A card reaches done only through a passing check that still matches the working tree.</p>
            <div className="page-actions">
              <button type="button" className="primary-button" onClick={() => void plan()} disabled={busy !== null || !readiness?.ready}>
                {busy === 'plan' ? <Loader2 className="spin" size={14} /> : <LayoutGrid size={14} />} {board?.cards.length ? 'Rebuild the board' : 'Build the board'}
              </button>
              <button type="button" className="secondary-button" onClick={() => void planForTeam()} disabled={busy !== null || !board?.cards.some((card) => card.status === 'ready')} title="One agent per ready card, reviewed on the Workflows page before anything runs">
                {busy === 'team' ? <Loader2 className="spin" size={14} /> : <Users size={14} />} Plan these for the team
              </button>
              <button type="button" className="secondary-button" onClick={() => void workCard()} disabled={busy !== null || !board?.cards.some((card) => card.status === 'ready')} title="Runs the next ready card with one agent. The card stops at review; the board decides when it is done.">
                {busy === 'work' ? <Loader2 className="spin" size={14} /> : <Play size={14} />} Work the next card
              </button>
            </div>
            {board && board.cards.length > 0 ? (
              <div className="studio-board">
                {BOARD_STATUSES.map((status) => {
                  const cards = board.cards.filter((card) => card.status === status);
                  return (
                    <div key={status} className="studio-column">
                      <h3>{status} <span className="studio-count">{cards.length}</span></h3>
                      {cards.map((card) => <BoardCardView key={card.id} card={card} busy={busy !== null} onMove={move} onCheckUi={checkUi} />)}
                      {cards.length === 0 && <p className="studio-note">Empty</p>}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="studio-note">No board yet. Generate the stories, then build the board.</p>
            )}
          </article>
        </section>
      )}
      </div>

      {screen === 'new' && !state && (
        <div className="studio-composer-dock">
          <div className="composer-box studio-idea-composer studio-composer">
            <textarea
              className="studio-idea"
              value={idea}
              onChange={(event) => setIdea(event.target.value)}
              placeholder="A booking site for a two-chair barber shop: customers pick a time, pay a deposit, and the owner sees the day's list on her phone."
              rows={3}
              disabled={busy !== null}
            />
            <div className="studio-folder-choice">
              <span className="studio-project-label">Project location</span>
              <div role="radiogroup" aria-label="Project location">
                <button
                  type="button"
                  className={!useCurrentFolder ? 'selected' : undefined}
                  aria-pressed={!useCurrentFolder}
                  onClick={() => setUseCurrentFolder(false)}
                  disabled={busy !== null}
                >
                  <NotebookPen size={13} /> Independent workspace
                </button>
                {currentFolder && (
                  <button
                    type="button"
                    className={useCurrentFolder ? 'selected' : undefined}
                    aria-pressed={useCurrentFolder}
                    onClick={() => setUseCurrentFolder(true)}
                    disabled={busy !== null}
                  >
                    <FolderOpen size={13} /> Use {currentFolder.name}
                  </button>
                )}
              </div>
              <small>{currentFolder ? 'Start independent by default, or explicitly use the open folder. You can create a new project folder after the brief is ready.' : 'Plan first. You can create a project folder after the brief is ready.'}</small>
            </div>
            <div className="composer-toolbar studio-idea-toolbar">
              <button
                type="button"
                className="primary-button"
                onClick={() => void start()}
                disabled={!projectId || !readiness?.ready || !idea.trim() || busy !== null}
                title={readiness?.reason ?? undefined}
              >
                {busy === 'start' ? <Loader2 className="spin" size={14} /> : <Play size={14} />} Start the discussion
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BoardCardView({ card, busy, onMove, onCheckUi }: { card: BoardCard; busy: boolean; onMove: (id: string, status: BoardStatus) => Promise<void>; onCheckUi: (id: string) => Promise<void> }): ReactNode {
  return (
    <div className={`studio-tile${card.stale ? ' stale' : ''}`}>
      <div className="studio-tile-head">
        <strong>{card.title}</strong>
        <span className="studio-kind">{card.kind}</span>
      </div>
      {card.stale && <p className="studio-note"><AlertTriangle size={12} /> {card.staleReason ?? 'Something this card reads changed.'}</p>}
      {card.claimedBy && <p className="studio-note"><Loader2 size={12} /> Held by {card.claimedBy}</p>}
      {card.check && <p className="studio-note">{card.check.visual === 'passed' ? <Check size={12} /> : <AlertTriangle size={12} />} Visual check {card.check.visual ?? 'not run'} · {card.check.screenshots.length} shots</p>}
      {(card.kind === 'component' || card.kind === 'page') && (
        <button type="button" className="secondary-button" onClick={() => void onCheckUi(card.id)} disabled={busy || !card.route}>
          <Eye size={13} /> {card.route ? 'Check the screen' : 'No route set'}
        </button>
      )}
      <select
        className="studio-move"
        value={card.status}
        onChange={(event) => void onMove(card.id, event.target.value as BoardStatus)}
        disabled={busy}
        aria-label={`Move ${card.title}`}
      >
        {BOARD_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
      </select>
    </div>
  );
}

function Notes({ title, items }: { title: string; items: string[] }): ReactNode {
  return (
    <>
      <h3>{title}</h3>
      <ul className="studio-list">{items.map((item) => <li key={item}>{item}</li>)}</ul>
    </>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'The Project Studio encountered an unexpected error.';
}
