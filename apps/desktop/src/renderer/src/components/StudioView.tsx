import { AlertTriangle, Archive, ArchiveRestore, ArrowLeft, Check, Code2, Eye, FileText, FolderOpen, FolderPlus, LayoutGrid, Loader2, NotebookPen, Palette, Play, Plus, RefreshCw, RotateCcw, Send, Settings, SkipForward, Sparkles, Trash2, Users, Wand2 } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AgentOrb } from './AgentOrb';
import { Markdown } from './Markdown';
import {
  ARTIFACT_KINDS,
  ARTIFACT_PATHS,
  directDependencies,
  BOARD_STATUSES,
  interviewGivenAnswers,
  interviewOpenOptions,
  interviewOpenQuestions,
  STUDIO_MAX_QUESTIONS,
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
  onLaunchProject: (studioProjectId: string, destination: 'composer' | 'editor' | 'generate') => Promise<void>;
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
  // The chat asks one question of the round at a time: `step` is the one on screen, `draft` the reply being written.
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState('');
  // The artifact open in the viewer, its text, and the hand edit being written, if any.
  const [viewing, setViewing] = useState<ArtifactKind | null>(null);
  const [viewText, setViewText] = useState<string | null>(null);
  const [editText, setEditText] = useState<string | null>(null);
  const [progress, setProgress] = useState<ArtifactProgress | null>(null);
  const [tab, setTab] = useState<'interview' | 'artifacts' | 'board' | 'design'>('interview');
  const [handoffDismissed, setHandoffDismissed] = useState(false);
  const [dropColumn, setDropColumn] = useState<BoardStatus | null>(null);
  const threadEnd = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState<'load' | 'start' | 'answer' | 'enhance' | 'finish' | 'reset' | 'generate' | 'plan' | 'card' | 'team' | 'work' | 'design' | 'archive' | 'delete' | 'folder' | 'launch' | null>(null);
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
    setStep(0);
    setDraft('');
    setViewing(null);
    setViewText(null);
    setEditText(null);
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
      setStep(0);
      setDraft('');
      setTab(interview?.status === 'done' ? 'artifacts' : 'interview');
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

  async function launchProject(studioProjectId: string, destination: 'composer' | 'editor' | 'generate'): Promise<void> {
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

  // The handoff screen is shown once per project; whether it was dismissed is a per-viewer convenience.
  useEffect(() => {
    try {
      setHandoffDismissed(Boolean(projectId && window.localStorage.getItem(`kai.studio.handoff.${projectId}`)));
    } catch {
      setHandoffDismissed(false);
    }
  }, [projectId]);

  function dismissHandoff(): void {
    setHandoffDismissed(true);
    try {
      if (projectId) window.localStorage.setItem(`kai.studio.handoff.${projectId}`, '1');
    } catch {
      // Remembering the choice is optional.
    }
  }

  useEffect(() => {
    threadEnd.current?.scrollIntoView({ block: 'end' });
  }, [step, state, busy]);

  function adopt(next: InterviewState): void {
    setState(next);
    setAnswers(interviewOpenQuestions(next).map(() => ''));
    setStep(0);
    setDraft('');
    if (next.status === 'done') setTab('artifacts');
  }

  /** Opens an artifact in the viewer. Clicking the open one again closes it. */
  async function viewArtifact(kind: ArtifactKind): Promise<void> {
    if (!projectId) return;
    if (viewing === kind) {
      setViewing(null);
      return;
    }
    setViewing(kind);
    setViewText(null);
    setEditText(null);
    try {
      setViewText((await window.kaiDesktop.studioArtifactText({ projectId, kind }).then(unwrap)) ?? '');
    } catch (caught) {
      setError(messageOf(caught));
      setViewing(null);
    }
  }

  async function saveArtifactEdit(): Promise<void> {
    if (!projectId || !viewing || editText === null) return;
    setBusy('card');
    setError(null);
    try {
      setArtifacts(unwrap(await window.kaiDesktop.saveStudioArtifact({ projectId, kind: viewing, content: editText })));
      setViewText(editText.endsWith('\n') ? editText : `${editText}\n`);
      setEditText(null);
      setNotice('Saved. Anything built from this artifact is now marked stale.');
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  /** After a partial failure, shows what was written instead of leaving the screen on its old catalog. */
  async function reloadSpec(id: string): Promise<void> {
    try {
      setArtifacts(unwrap(await window.kaiDesktop.studioArtifacts(id)));
      setBoard(unwrap(await window.kaiDesktop.studioBoard(id)));
    } catch {
      // The error already on screen says what failed; a failed reload adds nothing.
    }
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

  /** Sends the round's answers. A blank answer is sent as a skip, which tells the studio to decide that one itself. */
  async function sendAnswers(given: string[]): Promise<InterviewState | null> {
    if (!projectId || !state) return null;
    setBusy('answer');
    setError(null);
    try {
      const next = unwrap(await window.kaiDesktop.answerStudioInterview({
        projectId,
        answers: interviewOpenQuestions(state).map((question, index) => ({ question, answer: (given[index] ?? '').trim() })),
      }));
      adopt(next);
      return next;
    } catch (caught) {
      setError(messageOf(caught));
      return null;
    } finally {
      setBusy(null);
    }
  }

  /** Records the reply to the question on screen and moves on; the last one of the round sends them all. */
  async function submitStep(text: string): Promise<void> {
    if (busy !== null) return;
    const value = text.trim();
    const next = answers.map((existing, index) => (index === step ? value : existing));
    setAnswers(next);
    setDraft('');
    if (step + 1 < next.length) {
      setStep(step + 1);
      return;
    }
    const sent = await sendAnswers(next);
    if (!sent) setDraft(value);
    else if (sent.status === 'done') void buildEverything(sent.projectId);
  }

  /**
   * Writes the artifacts one at a time, so the screen can show which one is being written and keep each as it lands.
   * One the model gets wrong is recorded and skipped, along with anything built from it; the rest still get written.
   * Returns a message per problem, empty when everything was written.
   */
  async function writeArtifacts(id: string): Promise<string[]> {
    let catalog = unwrap(await window.kaiDesktop.studioArtifacts(id));
    setArtifacts(catalog);
    const todo = ARTIFACT_KINDS.filter((kind) => {
      if (kind === 'brief') return false;
      const entry = catalog.artifacts.find((item) => item.kind === kind);
      return !entry || entry.stale;
    });
    const failed: Partial<Record<ArtifactKind, string>> = {};
    let finished = 0;
    for (const kind of todo) {
      const blockedBy = directDependencies(kind).find((dependency) => failed[dependency]);
      if (blockedBy) {
        failed[kind] = `Needs ${blockedBy}, which could not be written.`;
      } else {
        setProgress({ done: finished, total: todo.length, current: kind, failed: { ...failed } });
        try {
          catalog = unwrap(await window.kaiDesktop.generateStudioArtifact({ projectId: id, kind }));
          setArtifacts(catalog);
        } catch (caught) {
          failed[kind] = messageOf(caught);
        }
      }
      finished += 1;
    }
    setProgress({ done: finished, total: todo.length, current: null, failed });
    const names = Object.keys(failed);
    if (names.length === 0) return [];
    const cause = Object.entries(failed).find(([, reason]) => !reason?.startsWith('Needs '));
    return [`Wrote ${todo.length - names.length} of ${todo.length} artifacts. Could not write: ${names.join(', ')}.${cause ? ` ${cause[0]}: ${cause[1]}` : ''}`];
  }

  /**
   * The interview is over, so write the artifacts and build the board without waiting for two more clicks. Each
   * step reports its own failure, and what was written stays: a failed board never throws the artifacts away.
   */
  async function buildEverything(id: string): Promise<void> {
    setError(null);
    setHandoffDismissed(false);
    setTab('artifacts');
    const problems: string[] = [];
    try {
      setBusy('generate');
      problems.push(...(await writeArtifacts(id)));
    } catch (caught) {
      problems.push(messageOf(caught));
      await reloadSpec(id);
    }
    try {
      setBusy('plan');
      setBoard(unwrap(await window.kaiDesktop.planStudioBoard(id)));
    } catch (caught) {
      problems.push(`The board was not built: ${messageOf(caught)}`);
    }
    setBusy(null);
    setProjectsVersion((current) => current + 1);
    if (problems.length > 0) setError(`${problems.join(' ')} What was written is kept: fix the connection if needed, then use Generate all and Build the board.`);
  }

  async function enhanceText(text: string, apply: (next: string) => void): Promise<void> {
    if (!text.trim() || busy !== null) return;
    setBusy('enhance');
    setError(null);
    try {
      const result = unwrap(await window.kaiDesktop.refinePrompt({ text: text.trim(), intent: 'build' }));
      apply(result.prompt.slice(0, 4_000));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  const enhanceDraft = (): Promise<void> => enhanceText(draft, setDraft);
  const enhanceIdea = (): Promise<void> => enhanceText(idea, setIdea);

  async function finish(): Promise<void> {
    if (!projectId) return;
    setBusy('finish');
    setError(null);
    try {
      const done = unwrap(await window.kaiDesktop.finishStudioInterview(projectId));
      adopt(done);
      setProjectsVersion((current) => current + 1);
      setBusy(null);
      void buildEverything(done.projectId);
      return;
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy((current) => (current === 'finish' ? null : current));
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
      const problems = await writeArtifacts(projectId);
      if (problems.length > 0) setError(problems.join(' '));
    } catch (caught) {
      setError(messageOf(caught));
      await reloadSpec(projectId);
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
  const openOptions = state ? interviewOpenOptions(state) : [];
  const asking = state?.status === 'asking';
  const decided = state ? interviewGivenAnswers(state) : [];
  const showHandoff = Boolean(state?.status === 'done' && projectId && artifacts && board && board.cards.length > 0 && !handoffDismissed && busy !== 'generate' && busy !== 'plan');
  const building = Boolean(state?.status === 'done' && (busy === 'generate' || busy === 'plan'));
  // A finished interview has written its brief, whatever the catalog on screen happens to list.
  const briefReady = state?.status === 'done' || Boolean(artifacts?.artifacts.some((entry) => entry.kind === 'brief'));
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
                          <button type="button" className="secondary-button" onClick={() => void launchProject(project.id, 'generate')} disabled={busy !== null}>
                            <Play size={14} />
                            <span>Start generating</span>
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
          {state?.status === 'done' && projectId && !showHandoff && (
            <>
              <button type="button" className="primary-button" onClick={() => void launchProject(projectId, 'composer')} disabled={busy !== null}>
                {busy === 'launch' ? <Loader2 className="spin" size={14} /> : <Send size={14} />} Start on composer
              </button>
              <button type="button" className="secondary-button" onClick={() => void launchProject(projectId, 'generate')} disabled={busy !== null}>
                <Play size={14} /> Start generating
              </button>
              <button type="button" className="secondary-button" onClick={() => void launchProject(projectId, 'editor')} disabled={busy !== null}>
                <Code2 size={14} /> Open in code editor
              </button>
            </>
          )}
          {state?.status === 'done' && projectId && !state.linkedProjectId && (
            <button type="button" className="secondary-button" onClick={() => void chooseProjectFolder(projectId)} disabled={busy !== null}>
              {busy === 'folder' ? <Loader2 className="spin" size={14} /> : <FolderPlus size={14} />} Create folder
            </button>
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

      {state?.status === 'done' && (
        <div className="studio-tabs" role="tablist" aria-label="Project sections">
          {([
            ['interview', 'Interview'],
            ['artifacts', `Artifacts${artifacts ? ` (${artifacts.artifacts.length})` : ''}`],
            ['board', `Board${board && board.cards.length > 0 ? ` (${board.cards.length})` : ''}`],
            ['design', 'Design'],
          ] as const).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'active' : undefined} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
      )}
      {building && (
        <article className="studio-card studio-handoff" role="status">
          <h2><Loader2 className="spin" size={16} /> Preparing the project</h2>
          <p className="studio-note">{busy === 'generate' ? 'Writing the artifacts from the brief. Each one appears below as soon as it is written.' : 'Building the board from the stories…'}</p>
          {busy === 'generate' && progress && <GenerationProgress progress={progress} />}
          <div className="studio-strip"><span className="done">✓ Brief</span><span className={busy === 'generate' ? 'now' : 'done'}>{busy === 'generate' ? '… Artifacts' : '✓ Artifacts'}</span><span className={busy === 'plan' ? 'now' : ''}>Board</span></div>
        </article>
      )}
      {showHandoff && tab === 'artifacts' && state && projectId && board && artifacts && (
        <article className="studio-card studio-handoff">
          <h2><Check size={16} /> Project ready</h2>
          <p className="studio-goal">{state.goal || state.idea}</p>
          <div className="studio-strip">
            <span className="done">✓ Brief</span>
            <span className="done">✓ {artifacts.artifacts.length} artifacts</span>
            <span className="done">✓ Board: {board.cards.length} cards, {board.cards.filter((card) => card.status === 'ready').length} ready</span>
          </div>
          <div className="studio-choices">
            <div className="studio-choice">
              <h3><Sparkles size={15} /> Generate with KAI</h3>
              <p className="studio-note">The agent builds from the brief and the board, starting on the first ready card. Each card stops at Review for you.</p>
              <button type="button" className="primary-button" onClick={() => void launchProject(projectId, 'generate')} disabled={busy !== null}>
                {busy === 'launch' ? <Loader2 className="spin" size={14} /> : <Play size={14} />} Start building
              </button>
            </div>
            <div className="studio-choice">
              <h3><Code2 size={15} /> Open code editor</h3>
              <p className="studio-note">Code it yourself. The learning AI sits beside the editor and reads this project's brief, decisions and conventions.</p>
              <button type="button" className="primary-button" onClick={() => void launchProject(projectId, 'editor')} disabled={busy !== null}>
                <Code2 size={14} /> Open editor
              </button>
            </div>
          </div>
          <div className="studio-actions">
            <button type="button" className="secondary-button" onClick={dismissHandoff}>Review the artifacts and board first</button>
            <button type="button" className="secondary-button" onClick={() => void launchProject(projectId, 'composer')} disabled={busy !== null}><Send size={14} /> Start on composer</button>
          </div>
          <p className="studio-note">A status file and an <code>AGENTS.md</code> in the project root keep any agent, KAI's or another, pointed at the right files as the board moves.</p>
        </article>
      )}

      {(!state || state.status !== 'done' || tab === 'interview') && (
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
                {state.assumptions.length > 0 && <Notes title="Assumptions" items={state.assumptions} />}
                {decided.length > 0 && (
                  <>
                    <h3>Decisions</h3>
                    <dl className="studio-decisions">
                      {decided.map((item) => <div key={item.question}><dt>{item.question}</dt><dd>{item.answer}</dd></div>)}
                    </dl>
                  </>
                )}
                <p className="studio-note">The brief fills in as you answer. A skipped question is decided by the studio.</p>
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
              <div className="studio-interview-head">
                <AgentOrb state={busy === 'answer' || busy === 'finish' ? 'thinking' : 'idle'} />
                <p className="studio-note">Question {Math.min(state.rounds.flatMap((round) => round.questions).length, STUDIO_MAX_QUESTIONS)} of up to {STUDIO_MAX_QUESTIONS}. Skip anything you would rather leave to the agents.</p>
              </div>
              <div className="studio-thread" role="log" aria-live="polite">
                <div className="studio-bubble user">{state.idea}</div>
                {state.rounds.slice(0, -1).flatMap((round) => round.answers).map((item) => (
                  <ThreadTurn key={item.question} question={item.question} answer={item.answer} />
                ))}
                {open.slice(0, step).map((question, index) => (
                  <ThreadTurn key={question} question={question} answer={answers[index] ?? ''} />
                ))}
                {open[step] !== undefined && <div className="studio-bubble ai">{open[step]}</div>}
                {open.length === 0 && <p className="studio-note">No questions this round.</p>}
                {busy === 'answer' && <div className="studio-bubble ai"><Loader2 className="spin" size={13} /> Thinking about what to ask next…</div>}
                <div ref={threadEnd} />
              </div>
              {open[step] !== undefined && (
                <div className="studio-reply">
                  {(openOptions[step] ?? []).length > 0 && (
                    <div className="command-chip-row studio-options" role="group" aria-label="Suggested answers">
                      {(openOptions[step] ?? []).map((option) => (
                        <button key={option} type="button" className={draft === option ? 'active' : undefined} aria-pressed={draft === option} onClick={() => setDraft(option)} disabled={busy !== null}>{option}</button>
                      ))}
                    </div>
                  )}
                  <StudioComposer
                    value={draft}
                    onChange={setDraft}
                    onSubmit={() => void submitStep(draft)}
                    placeholder="Pick a suggestion or type your own answer"
                    ariaLabel="Your answer"
                    disabled={busy !== null}
                    sending={busy === 'answer'}
                    enhancing={busy === 'enhance'}
                    onEnhance={() => void enhanceDraft()}
                    extra={(
                      <>
                        <button type="button" className="composer-text-button" onClick={() => void submitStep('')} disabled={busy !== null} title="Leave this one to the agents">Skip</button>
                        <button type="button" className="composer-text-button" onClick={() => void submitStep(open[step] ? (openOptions[step]?.[0] ?? '') : '')} disabled={busy !== null || !openOptions[step]?.[0]} title="Let KAI choose the first suggestion">Decide for me</button>
                      </>
                    )}
                    footer={<><span>Enter to send · Shift+Enter for a new line</span><span>{state.rounds.flatMap((round) => round.questions).length} of up to {STUDIO_MAX_QUESTIONS} questions</span></>}
                  />
                </div>
              )}
              <div className="studio-actions">
                <button type="button" className="secondary-button" onClick={() => void finish()} disabled={busy !== null}>
                  {busy === 'finish' ? <Loader2 className="spin" size={14} /> : <FileText size={14} />} Write the brief now
                </button>
              </div>
            </>
          )}
        </article>
      </section>
      )}

      {state && briefReady && (
        <section className="studio-stack">
          {tab === 'artifacts' && (
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
            {busy === 'generate' && progress && <GenerationProgress progress={progress} />}
            <ul className="studio-artifacts">
              {ARTIFACT_KINDS.map((kind) => {
                const entry = artifacts?.artifacts.find((item) => item.kind === kind);
                return (
                  <li key={kind} className={[entry?.stale ? 'stale' : '', progress?.current === kind && busy === 'generate' ? 'writing' : '', progress?.failed[kind] ? 'failed' : ''].filter(Boolean).join(' ') || undefined}>
                    <div className={entry ? 'studio-artifact-open' : undefined} role={entry ? 'button' : undefined} tabIndex={entry ? 0 : undefined} aria-expanded={entry ? viewing === kind : undefined} onClick={entry ? () => void viewArtifact(kind) : undefined} onKeyDown={entry ? (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void viewArtifact(kind); } } : undefined} title={entry ? `Open ${kind}` : undefined}>
                      <strong>{kind}</strong>
                      <span className="studio-note">
                        {progress?.current === kind && busy === 'generate'
                          ? <><Loader2 className="spin" size={11} /> Writing…</>
                          : entry ? <>{entry.generatedBy} · v{entry.version}{entry.stale ? ` · ${entry.staleReason ?? 'stale'}` : ''}</> : 'Not written yet'}
                      </span>
                      {progress?.failed[kind] && busy !== 'generate' && <span className="studio-fail">{progress.failed[kind]}</span>}
                    </div>
                    {kind !== 'brief' && (
                      <button type="button" className="secondary-button" onClick={() => void generateOne(kind)} disabled={busy !== null || !readiness?.ready}>
                        {entry ? <RefreshCw size={13} /> : <Play size={13} />} {entry ? 'Regenerate' : 'Generate'}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            {viewing && (
              <section className="studio-viewer" aria-label={`${viewing} artifact`}>
                <header>
                  <strong>{viewing}</strong>
                  <span className="studio-note"><code>{ARTIFACT_PATHS[viewing]}</code></span>
                  <span className="studio-viewer-actions">
                    {editText === null ? (
                      <button type="button" className="secondary-button" onClick={() => setEditText(viewText ?? '')} disabled={viewText === null || busy !== null}>Edit</button>
                    ) : (
                      <>
                        <button type="button" className="primary-button" onClick={() => void saveArtifactEdit()} disabled={busy !== null || !editText.trim()}>
                          {busy === 'card' ? <Loader2 className="spin" size={13} /> : <Check size={13} />} Save
                        </button>
                        <button type="button" className="secondary-button" onClick={() => setEditText(null)} disabled={busy !== null}>Cancel</button>
                      </>
                    )}
                    <button type="button" className="secondary-button" onClick={() => { setViewing(null); setEditText(null); }}>Close</button>
                  </span>
                </header>
                {viewText === null ? (
                  <p className="studio-note"><Loader2 className="spin" size={13} /> Reading…</p>
                ) : editText !== null ? (
                  <textarea className="studio-viewer-edit" value={editText} onChange={(event) => setEditText(event.target.value)} spellCheck={false} aria-label={`Edit ${viewing}`} />
                ) : !viewText.trim() ? (
                  <p className="studio-note">This artifact is empty.</p>
                ) : viewing === 'tokens' ? (
                  <pre className="studio-viewer-code">{viewText}</pre>
                ) : (
                  <div className="studio-viewer-body"><Markdown text={viewText} /></div>
                )}
              </section>
            )}
          </article>
          )}

          {tab === 'design' && (
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
          )}

          {tab === 'board' && (
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
                    <div
                      key={status}
                      className={`studio-column${dropColumn === status ? ' drop-target' : ''}`}
                      onDragOver={(event) => { if (busy === null) { event.preventDefault(); setDropColumn(status); } }}
                      onDragLeave={() => setDropColumn((current) => (current === status ? null : current))}
                      onDrop={(event) => {
                        event.preventDefault();
                        setDropColumn(null);
                        const cardId = event.dataTransfer.getData('text/plain');
                        const dragged = board.cards.find((card) => card.id === cardId);
                        if (dragged && dragged.status !== status && busy === null) void move(cardId, status);
                      }}
                    >
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
          )}
        </section>
      )}
      </div>

      {screen === 'new' && !state && (
        <div className="studio-composer-dock">
          <div className="studio-composer">
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
            <StudioComposer
              value={idea}
              onChange={setIdea}
              onSubmit={() => void start()}
              placeholder="A booking site for a two-chair barber shop: customers pick a time, pay a deposit, and the owner sees the day's list on her phone."
              ariaLabel="Describe the project"
              disabled={busy !== null}
              canSend={Boolean(projectId && readiness?.ready && idea.trim())}
              sending={busy === 'start'}
              sendTitle={readiness?.reason ?? 'Start the discussion'}
              enhancing={busy === 'enhance'}
              onEnhance={() => void enhanceIdea()}
              footer={<><span>Enter to start · Shift+Enter for a new line</span><span>KAI will ask up to {STUDIO_MAX_QUESTIONS} questions</span></>}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function BoardCardView({ card, busy, onMove, onCheckUi }: { card: BoardCard; busy: boolean; onMove: (id: string, status: BoardStatus) => Promise<void>; onCheckUi: (id: string) => Promise<void> }): ReactNode {
  return (
    <div
      className={`studio-tile${card.stale ? ' stale' : ''}${busy ? '' : ' draggable'}`}
      draggable={!busy}
      onDragStart={(event) => { event.dataTransfer.setData('text/plain', card.id); event.dataTransfer.effectAllowed = 'move'; }}
    >
      <div className="studio-tile-head">
        <strong>{card.title}</strong>
        <span className="studio-kind">{card.kind}</span>
      </div>
      {card.stale && <p className="studio-note"><AlertTriangle size={12} /> {card.staleReason ?? 'Something this card reads changed.'}</p>}
      {card.claimedBy && <p className="studio-note"><Loader2 size={12} /> Held by {card.claimedBy}</p>}
      {card.movedBy && card.movedAt && (
        <p className="studio-note studio-moved">
          <span className={`studio-who ${card.movedBy}`}>{card.movedBy === 'user' ? 'you' : card.movedBy === 'check' ? 'check' : 'agent'}</span>
          moved {card.movedAt.slice(0, 16).replace('T', ' ')}
        </p>
      )}
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

/**
 * The Studio's composer. It is the same box as the workspace composer (textarea, icon toolbar, round send button,
 * footer hint) so the interview feels like talking to KAI, not filling in a form.
 */
function StudioComposer({ value, onChange, onSubmit, placeholder, ariaLabel, disabled, canSend, sending, sendTitle, enhancing, onEnhance, extra, footer }: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  placeholder: string;
  ariaLabel: string;
  disabled: boolean;
  canSend?: boolean;
  sending: boolean;
  sendTitle?: string;
  enhancing: boolean;
  onEnhance: () => void;
  extra?: ReactNode;
  footer: ReactNode;
}): ReactNode {
  const sendable = canSend ?? Boolean(value.trim());
  return (
    <>
      <div className="composer-box">
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (sendable && !disabled) onSubmit();
            }
          }}
          placeholder={placeholder}
          aria-label={ariaLabel}
          maxLength={4_000}
          rows={3}
          disabled={disabled}
        />
        <div className="composer-toolbar">
          <div className="composer-leading">{extra}</div>
          <div className="composer-actions">
            <button type="button" className={`composer-icon-button ${enhancing ? 'active' : ''}`} disabled={!value.trim() || disabled} onClick={onEnhance} title="Improve this with the Prompt Guide" aria-label="Enhance">
              {enhancing ? <Loader2 className="spin" size={14} /> : <Wand2 size={14} />}
            </button>
            <button type="button" className="send-button" disabled={!sendable || disabled} onClick={onSubmit} title={sendTitle ?? 'Send'} aria-label="Send">
              {sending ? <Loader2 className="spin" size={15} /> : <Send size={16} />}
            </button>
          </div>
        </div>
      </div>
      <div className="composer-footer">{footer}</div>
    </>
  );
}

interface ArtifactProgress {
  done: number;
  total: number;
  current: ArtifactKind | null;
  failed: Partial<Record<ArtifactKind, string>>;
}

function GenerationProgress({ progress }: { progress: ArtifactProgress }): ReactNode {
  const percent = progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);
  return (
    <div className="studio-progress" role="status">
      <div className="studio-progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done} aria-label="Artifacts written">
        <span style={{ width: `${percent}%` }} />
      </div>
      <span className="studio-progress-label">
        <Loader2 className="spin" size={11} />
        {progress.current ? `Writing ${progress.current} (${Math.min(progress.done + 1, progress.total)} of ${progress.total})…` : 'Finishing up…'}
      </span>
    </div>
  );
}

function ThreadTurn({ question, answer }: { question: string; answer: string }): ReactNode {
  return (
    <>
      <div className="studio-bubble ai">{question}</div>
      <div className={`studio-bubble user${answer ? '' : ' skipped'}`}>{answer || 'Skipped, you decide'}</div>
    </>
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
