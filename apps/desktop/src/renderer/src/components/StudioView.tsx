import { AlertTriangle, Archive, ArchiveRestore, ArrowLeft, Check, Code2, Eye, FileText, FolderOpen, FolderPlus, ImagePlus, LayoutGrid, Loader2, Maximize2, Minimize2, NotebookPen, Palette, PencilLine, Play, Plus, RefreshCw, RotateCcw, Search, Send, Settings, SkipForward, Sparkles, Square, Trash2, Users, Wand2 } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AgentOrb } from './AgentOrb';
import { deriveAgentActivity } from './AgentActivity';
import { drawnPageNames, foundationLanded, remainingScreens, screenLanded, screenPageId, screensToRedraw } from '../design-build';
import { AutopilotPanel, DEFAULT_AUTOPILOT_START } from './AutopilotPanel';
import { GuidePanel, GuideStrip } from './GuidePanel';
import { NeedsYouBanner } from './NeedsYouBanner';
import { useAutopilotStatus } from './use-autopilot-status';
import { FlowDiagram } from './FlowDiagram';
import { ImageCard } from './ImageAttachment';
import { buildFoundationPrompt, buildPagePrompt, filterScreens, parseFlows, parsePages, screenRows, screenTitleKey, type DesignContext, type DesignPromptMode } from '../flow-diagram';
import { Markdown } from './Markdown';
import {
  ARTIFACT_KINDS,
  ARTIFACT_PATHS,
  directDependencies,
  BOARD_STATUSES,
  interviewGivenAnswers,
  interviewOpenOptions,
  interviewOpenQuestions,
  projectTitleFrom,
  STUDIO_EXTRA_QUESTIONS,
  STUDIO_MAX_EXTENSIONS,
  STUDIO_MAX_QUESTIONS,
  interviewQuestionBudget,
  type ArtifactKind,
  type BoardCard,
  type BoardStatus,
  type GuideAction,
  type InterviewState,
  type PersistedEvent,
  type ProjectRecord,
  type StudioArtifacts,
  type StudioStyleReferences,
  type StudioBoard,
  type StudioDesign,
  type StudioGuideView,
  type StudioProjectSummary,
  type StudioReadiness,
  type TeamPlanDraft,
} from '@kai/contracts';
import { relativeTime, unwrap } from '../types';
import { confirmDialog, promptDialog } from './AppDialog';

/**
 * The board's column headings in words. The status is a camelCase identifier, so printing it raw gave "INPROGRESS" as
 * one word — the buckets were there, they just could not be read.
 */
const BOARD_STATUS_LABEL: Record<BoardStatus, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  inProgress: 'In progress',
  review: 'In review',
  done: 'Done',
  blocked: 'Blocked',
};

/**
 * What a design build was asked to do, beyond its plain form. Plain, it fills in only the screens that are missing.
 * `redraw` draws screens again that are already there — all of them, or one — for a look that changed. `clean` clears
 * whatever is broken or duplicated about one screen first (a page with the wrong name, a duplicate, a half-drawn
 * leftover) and then draws it fresh, which is the way past a page Studio can never match.
 */
type DesignBuildAction = { kind: 'redraw'; target: 'all' | string } | { kind: 'clean'; target: string };

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
  // The answer from an earlier round being rewritten, held by question: that is what the studio's correction takes.
  const [correcting, setCorrecting] = useState<{ question: string; answer: string } | null>(null);
  // The artifact open in the viewer, its text, and the hand edit being written, if any.
  const [viewing, setViewing] = useState<ArtifactKind | null>(null);
  const [viewText, setViewText] = useState<string | null>(null);
  const [editText, setEditText] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'diagram' | 'text'>('diagram');
  const [pagesText, setPagesText] = useState<string | null>(null);
  const [styleRefs, setStyleRefs] = useState<StudioStyleReferences | null>(null);
  // Which drawing step's prompt is open under its row, and which one was just copied.
  const [openPrompt, setOpenPrompt] = useState<string | null>(null);
  const [copiedPrompt, setCopiedPrompt] = useState<string | null>(null);
  const [screenQuery, setScreenQuery] = useState('');
  // What KAI says back after the user attaches style images in the interview.
  const [attachNote, setAttachNote] = useState<string | null>(null);
  // How many answered turns the thread had when each image was attached, so the image stays where it was sent
  // instead of following the newest question. An image from an earlier visit has no entry and sits after the idea.
  const [attachedAt, setAttachedAt] = useState<Record<string, number>>({});
  const [foundationDone, setFoundationDone] = useState(false);
  // Screens the user chose to leave alone: they are kept out of the build's remaining list, so one screen that will
  // not land cannot hold the rest of the design hostage. Remembered per project, like the foundation note.
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  // Whether the look changed after screens were drawn — an image was added, removed or described — so the drawn
  // screens no longer follow it. Cleared by a full redraw. Remembered per project, like the foundation note.
  const [styleChanged, setStyleChanged] = useState(false);
  const [progress, setProgress] = useState<ArtifactProgress | null>(null);
  // The board can fill the whole window, so a long board can be read and worked without the page around it.
  const [boardFull, setBoardFull] = useState(false);
  // Any artifact can be read, edited or (for flows) explored full screen.
  const [viewerFull, setViewerFull] = useState(false);
  const [tab, setTab] = useState<'interview' | 'artifacts' | 'board' | 'design' | 'guide'>('interview');
  // Where the project is, from the rules — free to read, so it is refreshed whenever the board changes. The
  // explanation inside it is the paid part, and arrives only when the Guide tab asks for it.
  const [guide, setGuide] = useState<StudioGuideView | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [handoffDismissed, setHandoffDismissed] = useState(false);
  const [dropColumn, setDropColumn] = useState<BoardStatus | null>(null);
  const threadEnd = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState<'load' | 'start' | 'answer' | 'enhance' | 'finish' | 'reset' | 'generate' | 'plan' | 'arrange' | 'card' | 'team' | 'work' | 'design' | 'design-build' | 'page-op' | 'archive' | 'delete' | 'folder' | 'launch' | 'link' | 'guide' | null>(null);
  const [useCurrentFolder, setUseCurrentFolder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [design, setDesign] = useState<StudioDesign | null>(null);
  // What the design-build loop is on right now, shown beside the button; the ref is read inside the loop itself,
  // since reading state there would only ever see the value the loop closed over, not a later click of Stop.
  const [buildingStep, setBuildingStep] = useState<string | null>(null);
  const buildCancelled = useRef(false);
  // The current step's own tool calls, arriving live on the same channel a composer run's events already use —
  // `stepId` is minted before the step starts and carried in the request, so this can filter to just this step.
  const [buildEvents, setBuildEvents] = useState<PersistedEvent[]>([]);
  const buildStepId = useRef<string | null>(null);
  // Running spend for the build in progress, since a 30-screen run is 30-odd agent turns with no other visibility
  // into cost — unlike the composer, which tracks this per run already. The ref is the source of truth read inside
  // the loop itself (a long-running async function closes over the state value from whenever it started, not a
  // later update), and the state is only for display.
  const [buildCostUsd, setBuildCostUsd] = useState(0);
  const buildCostRef = useRef(0);
  // The step a build stopped on, so the button can say "Retry X" instead of just "Build the design" again —
  // cleared the moment a new build starts, since that attempt speaks for itself from then on.
  const [lastFailedStep, setLastFailedStep] = useState<string | null>(null);
  const projectId = screen === 'project' ? viewedProjectId : screen === 'new' ? draftProjectId : null;
  // The live run, for the banner above the board. The Autopilot panel subscribes to the same status for its own
  // detail; the banner needs it here because "is anything waiting on me right now" is a question about the run, not
  // about the board, and the board's own strip cannot answer it.
  const autopilot = useAutopilotStatus(projectId);
  const viewedProject = projects.find((project) => project.id === viewedProjectId) ?? null;
  // A name, not the paragraph: the goal is a full statement of what "done" looks like, and using it whole is what
  // filled the header and every design prompt with the entire brief.
  const projectTitle = projectTitleFrom(state?.goal, state?.idea, viewedProject?.title) || 'New project';
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

  /**
   * Where the project is, re-read whenever anything it reads has moved.
   *
   * `read` never calls a provider — it is the rules reading the board, the artifacts and the interview — so this can
   * refresh on every change without spending anything. That is also what records a milestone the moment it is
   * crossed, rather than only when someone happens to open the Guide tab.
   */
  useEffect(() => {
    if (!projectId) { setGuide(null); return undefined; }
    let cancelled = false;
    void window.kaiDesktop.readStudioGuide(projectId).then(unwrap)
      .then((next) => { if (!cancelled) setGuide(next); })
      // Said out loud rather than swallowed: a read that fails leaves the tab on its loading line forever, which
      // reads as "still working" and hides the cause. The guide is auxiliary, so this is a notice, not a block.
      .catch((caught) => { if (!cancelled) setError(messageOf(caught)); });
    return () => { cancelled = true; };
  }, [projectId, board, artifacts, state, design]);

  /**
   * Writes the walkthrough, once per situation. The key is what stops a failed call from retrying forever: an
   * attempt is remembered per (project, step, whether it needs you), so a provider that is down leaves the button in
   * the reader's hands rather than looping, and a step the project moves on to is explained on its own.
   */
  const autoExplained = useRef<string | null>(null);
  useEffect(() => {
    if (tab !== 'guide' || !projectId || !guide || guide.narrative || explaining) return;
    const current = guide.steps.find((step) => step.id === guide.currentStepId);
    const key = `${projectId}|${guide.currentStepId}|${current?.state}|${guide.history.length}`;
    if (autoExplained.current === key) return;
    autoExplained.current = key;
    void explainGuide();
  }, [tab, projectId, guide, explaining]);

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
    // Adopting state settles whatever correction was in flight: it has either just been sent or been overtaken.
    setCorrecting(null);
    if (next.status === 'done') setTab('artifacts');
  }

  /** Opens an artifact in the viewer. Clicking the open one again closes it. */
  async function viewArtifact(kind: ArtifactKind): Promise<void> {
    if (!projectId) return;
    if (viewing === kind) {
      // Closing the one being edited would take the edit with it.
      if (editText !== null && !(await confirmDialog({
        title: 'Discard your changes?',
        detail: `You have unsaved changes to ${viewing}. Closing it now loses them.`,
        confirmLabel: 'Discard',
        destructive: true,
      }))) return;
      setViewing(null);
      setEditText(null);
      return;
    }
    // Opening another artifact used to overwrite the edit in the one being edited, without a word. The edit is not
    // recoverable once the viewer has moved on, so it is asked about rather than dropped.
    if (editText !== null && viewing && !(await confirmDialog({
      title: 'Discard your changes?',
      detail: `You have unsaved changes to ${viewing}. Opening ${kind} now loses them.`,
      confirmLabel: 'Discard',
      destructive: true,
    }))) return;
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

  /** The design tab's own data: the screens the project needs and the reference images for its look. */
  useEffect(() => {
    if (tab !== 'design' || !projectId || state?.status !== 'done') return undefined;
    let cancelled = false;
    void Promise.all([
      window.kaiDesktop.studioArtifactText({ projectId, kind: 'pages' }).then(unwrap),
      window.kaiDesktop.studioStyleReferences(projectId).then(unwrap),
    ]).then(([pages, refs]) => {
      if (cancelled) return;
      setPagesText(pages);
      setStyleRefs(refs);
    }).catch((caught) => {
      if (!cancelled) setError(messageOf(caught));
    });
    return () => { cancelled = true; };
  }, [tab, projectId, state?.status, artifacts]);

  useEffect(() => {
    if (!viewerFull) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setViewerFull(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewerFull]);

  useEffect(() => {
    if (!boardFull) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setBoardFull(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [boardFull]);

  // Live tool calls for whichever design-build step is running, so "Building X" says what it is actually doing
  // instead of sitting on a bare spinner for however long open-pencil takes to answer.
  useEffect(() => window.kaiDesktop.onAgentEvent(({ conversationId, event }) => {
    if (conversationId !== buildStepId.current) return;
    setBuildEvents((current) => [...current, event]);
  }), []);

  const flowJourneys = useMemo(() => (viewing === 'flows' && viewText ? parseFlows(viewText) : []), [viewing, viewText]);
  const designPages = useMemo(() => (pagesText ? parsePages(pagesText) : []), [pagesText]);

  const designRows = useMemo(
    () => screenRows(designPages, design?.components.filter((component) => component.screen).map((component) => component.name) ?? []),
    [designPages, design],
  );
  const visibleRows = useMemo(() => filterScreens(designRows, screenQuery), [designRows, screenQuery]);
  // The screens the build still has to draw: in the pages list, not drawn yet, and not skipped by the user.
  const toDraw = useMemo(
    () => designRows.filter((row) => row.inPages && !row.drawn && !skipped.has(screenTitleKey(row.name))),
    [designRows, skipped],
  );
  // A style reference exists once a model has described the images (or the look was given in words). It is the file
  // that steers the drawing, so it outlives the images it was described from.
  const hasStyleReference = Boolean(styleRefs?.notes?.trim());
  // What the build button says when it is not already running: plain the first time, naming the step to retry
  // when the last attempt stopped on one, or how much is left when some screens are already drawn and nothing
  // failed — so clicking it again reads as "carry on from here", not "start over".
  const buildButtonLabel = lastFailedStep
    ? `Retry "${lastFailedStep}"`
    : foundationDone && designRows.some((row) => row.drawn) && toDraw.length > 0
      ? `Resume (${toDraw.length} left)`
      : 'Build the design';

  // Remembered per project so a returning build does not redo the foundation. It is a note about the project rather
  // than a fact about the document — the build loop verifies the foundation against open-pencil itself each time it
  // runs, and this only decides whether to run that step at all.
  useEffect(() => {
    try {
      setFoundationDone(Boolean(projectId && window.localStorage.getItem(`kai.studio.foundation.${projectId}`)));
      setStyleChanged(Boolean(projectId && window.localStorage.getItem(`kai.studio.styleChanged.${projectId}`)));
      const saved = projectId ? window.localStorage.getItem(`kai.studio.skipped.${projectId}`) : null;
      setSkipped(new Set(saved ? (JSON.parse(saved) as string[]) : []));
    } catch {
      setFoundationDone(false);
      setStyleChanged(false);
      setSkipped(new Set());
    }
  }, [projectId]);

  function toggleFoundation(done: boolean): void {
    setFoundationDone(done);
    try {
      if (!projectId) return;
      if (done) window.localStorage.setItem(`kai.studio.foundation.${projectId}`, '1');
      else window.localStorage.removeItem(`kai.studio.foundation.${projectId}`);
    } catch {
      // Remembering the tick is optional.
    }
  }

  function saveSkipped(next: Set<string>): void {
    setSkipped(next);
    try {
      if (projectId) window.localStorage.setItem(`kai.studio.skipped.${projectId}`, JSON.stringify([...next]));
    } catch {
      // Remembering the skips is optional.
    }
  }

  /** Leaves a screen out of the build, or puts it back. A screen that will not land is not worth stopping the whole
   * design for: skip it, finish the rest, and draw it later once it is worth another look. */
  function toggleSkip(name: string): void {
    const key = screenTitleKey(name);
    const next = new Set(skipped);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    saveSkipped(next);
  }

  function markStyleChanged(): void {
    setStyleChanged(true);
    try {
      if (projectId) window.localStorage.setItem(`kai.studio.styleChanged.${projectId}`, '1');
    } catch {
      // Remembering this is optional.
    }
  }

  function clearStyleChanged(): void {
    setStyleChanged(false);
    try {
      if (projectId) window.localStorage.removeItem(`kai.studio.styleChanged.${projectId}`);
    } catch {
      // Remembering this is optional.
    }
  }

  /** `source` is the artifact list a prompt should be built from. It is passed explicitly by a build, which has just
   * re-read it, so a prompt is never built from the catalog as it looked before this run started. */
  function designContext(source?: StudioArtifacts | null): DesignContext {
    const list = source ?? artifacts;
    return {
      projectName: projectTitle,
      goal: state?.goal || state?.idea || '',
      hasTokens: Boolean(list?.artifacts.some((entry) => entry.kind === 'tokens')),
      hasStyleGuide: Boolean(list?.artifacts.some((entry) => entry.kind === 'style-guide')),
      // Gated on the description file, not the images: a reference described once still steers the drawing after the
      // image files are gone, and it was the images that were required here before.
      hasStyleReference: Boolean(styleRefs?.notes?.trim()),
      references: styleRefs?.images.map((image) => image.name) ?? [],
    };
  }

  /** The prompt for one drawing step, by its key: "Foundation", or a screen's name. `mode` says what to do about the
   * page the screen is drawn on — draw it fresh, refill it, or clear it first (see `DesignPromptMode`). */
  function promptFor(key: string, mode: DesignPromptMode = 'draw', source?: StudioArtifacts | null): string {
    if (key === 'Foundation') return buildFoundationPrompt(designContext(source));
    const row = designRows.find((item) => item.name === key);
    return row ? buildPagePrompt(row, designContext(source), mode) : '';
  }

  /**
   * Copies one drawing step and shows it right under its row, so you can read what was copied. The prompts are small
   * on purpose: a single prompt for a whole project is what can stall the editor, so the foundation and each screen
   * are their own, run one after another.
   */
  async function copyDrawPrompt(key: string): Promise<void> {
    setOpenPrompt(key);
    try {
      await navigator.clipboard.writeText(promptFor(key));
      setCopiedPrompt(key);
      window.setTimeout(() => setCopiedPrompt((current) => (current === key ? null : current)), 2_500);
    } catch {
      setNotice('Could not reach the clipboard. Select the prompt under the row and copy it by hand.');
    }
  }

  /**
   * The interview's image button. The images are saved with the project; when the model can read them, they are
   * described at once so the next questions already know the look, and when it cannot, the user is told so and asked
   * to say it in words. Either way the drawing agent can still see the files.
   */
  async function attachStyleImages(files: FileList | null): Promise<void> {
    if (!projectId || !files || files.length === 0) return;
    setBusy('design');
    setError(null);
    let latest: StudioStyleReferences | null = null;
    setAttachNote('Looking at your image…');
    const turnsSoFar = (state ? state.rounds.slice(0, -1).flatMap((round) => round.answers).length : 0) + step;
    try {
      for (const file of [...files]) {
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
          reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
          reader.readAsDataURL(file);
        });
        latest = unwrap(await window.kaiDesktop.addStudioStyleReference({ projectId, name: file.name, data }));
        setAttachedAt((current) => ({ ...current, [file.name]: turnsSoFar }));
      }
      // The thread shows these from the same set the style guide is written from, so it has to be the live one.
      if (latest) setStyleRefs(latest);
    } catch (caught) {
      setAttachNote(null);
      setError(messageOf(caught));
      setBusy(null);
      return;
    }
    try {
      const described = unwrap(await window.kaiDesktop.describeStudioStyle(projectId));
      const summary = (described.notes ?? '').split('\n').filter((line) => line.trim() && !line.startsWith('#') && !line.startsWith('_')).slice(0, 3).join(' ').replace(/[*-]\s*/g, '').slice(0, 300);
      setAttachNote(`I looked at your image${(files.length ?? 0) > 1 ? 's' : ''} and will use the look in the style guide. ${summary}`.trim());
    } catch (caught) {
      setAttachNote(`I saved your image, but I could not read it: ${messageOf(caught)}`);
    } finally {
      setBusy(null);
    }
  }

  async function addReferenceImages(files: FileList | null): Promise<void> {
    if (!projectId || !files || files.length === 0) return;
    setBusy('design');
    setError(null);
    try {
      let latest: StudioStyleReferences | null = null;
      for (const file of [...files]) {
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
          reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
          reader.readAsDataURL(file);
        });
        latest = unwrap(await window.kaiDesktop.addStudioStyleReference({ projectId, name: file.name, data }));
      }
      if (latest) setStyleRefs(latest);
      // A new image changes what the drawing agent is pointed at, so screens already drawn no longer follow it.
      if (designRows.some((row) => row.drawn)) markStyleChanged();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  async function removeReferenceImage(name: string): Promise<void> {
    if (!projectId) return;
    setBusy('design');
    try {
      setStyleRefs(unwrap(await window.kaiDesktop.removeStudioStyleReference({ projectId, name })));
      if (designRows.some((row) => row.drawn)) markStyleChanged();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  async function describeReferences(): Promise<void> {
    if (!projectId) return;
    setBusy('design');
    setError(null);
    try {
      setStyleRefs(unwrap(await window.kaiDesktop.describeStudioStyle(projectId)));
      if (designRows.some((row) => row.drawn)) markStyleChanged();
      setNotice('Described. Regenerate the style guide and the tokens in Artifacts, then redraw the screens so they follow it too.');
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
    setNotice(null);
    try {
      const next = unwrap(await window.kaiDesktop.studioReadiness());
      setReadiness(next);
      // Said out loud, whichever way it went. The line beside the button only changes when the answer itself changes,
      // so a check that came back the same used to look like a check that did nothing.
      setNotice(next.ready
        ? `Connected: ${next.displayName} · ${next.model}.`
        : `Not ready: ${next.reason ?? 'the Studio needs configuring before it can run.'}`);
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

  /**
   * Replaces an answer already given and asks again from that point.
   *
   * The studio drops the rounds that followed, because their questions were chosen from the answer being
   * corrected — so the next state comes back with the interview rewound and a fresh question to answer.
   */
  async function sendCorrection(question: string, answer: string): Promise<InterviewState | null> {
    if (!projectId) return null;
    setBusy('answer');
    setError(null);
    try {
      const next = unwrap(await window.kaiDesktop.correctStudioInterviewAnswer({ projectId, question, answer }));
      adopt(next);
      return next;
    } catch (caught) {
      setError(messageOf(caught));
      return null;
    } finally {
      setBusy(null);
    }
  }

  /** Opens an answered question for rewriting, with what was said before already in the box. */
  function startCorrection(question: string, answer: string): void {
    if (busy !== null) return;
    setAttachNote(null);
    setCorrecting({ question, answer });
    setDraft(answer);
  }

  function cancelCorrection(): void {
    setCorrecting(null);
    setDraft('');
  }

  /** Records the reply to the question on screen and moves on; the last one of the round sends them all. */
  async function submitStep(text: string): Promise<void> {
    if (busy !== null) return;
    const value = text.trim();
    setAttachNote(null);
    if (correcting) {
      const sent = await sendCorrection(correcting.question, value);
      // A failed correction keeps the box and the question it belongs to, so it can be sent again.
      if (!sent) setDraft(value);
      return;
    }
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
  async function writeArtifacts(id: string, everything = false): Promise<string[]> {
    let catalog = unwrap(await window.kaiDesktop.studioArtifacts(id));
    setArtifacts(catalog);
    // Missing or stale ones by default; every one except the interview's brief when the user asks to regenerate all.
    const todo = ARTIFACT_KINDS.filter((kind) => {
      if (kind === 'brief') return false;
      const entry = catalog.artifacts.find((item) => item.kind === kind);
      // Tokens pulled from open-pencil belong to the design tool; a model rewriting them would undo the design.
      if (everything) return !(kind === 'tokens' && entry?.generatedBy === 'open-pencil');
      return !entry || entry.stale;
    });
    if (todo.length === 0) {
      setNotice('Every artifact is already written and up to date. Use Regenerate all to rewrite them.');
      return [];
    }
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

  /** Five more questions, for someone who wants to be walked through the choices instead of deciding fast. */
  async function extendInterview(): Promise<void> {
    if (!projectId || busy !== null) return;
    setBusy('card');
    setError(null);
    try {
      setState(unwrap(await window.kaiDesktop.extendStudioInterview(projectId)));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
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
  /** Rewrites every artifact. The copies it replaces stay in the spec history, but a hand edit is replaced, so it asks first. */
  async function regenerateAll(): Promise<void> {
    if (!projectId || busy !== null) return;
    const confirmed = await confirmDialog({
      title: 'Regenerate every artifact?',
      detail: 'Each artifact is written again from the brief, one model call each. The copies now on disk are kept under .kai/spec/.history, but anything you edited by hand will be replaced by the new version.',
      confirmLabel: 'Regenerate all',
      destructive: true,
    });
    if (!confirmed) return;
    await generate(true);
  }

  async function generate(everything = false): Promise<void> {
    if (!projectId) return;
    setBusy('generate');
    setError(null);
    setNotice(null);
    try {
      const problems = await writeArtifacts(projectId, everything);
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
      // The open artifact was just rewritten, so the text the viewer holds is the version before it. Left alone, an
      // Edit then Save would write that older text back over the new file — the reader's own edit looking like the
      // thing that reverted their document. Re-read it, and drop any edit in flight, which is now the older text.
      if (viewing === kind) {
        setEditText(null);
        setViewText((await window.kaiDesktop.studioArtifactText({ projectId, kind }).then(unwrap)) ?? '');
      }
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

  /**
   * Points this plan at a folder, or at none.
   *
   * A plan is linked to a folder by its id, so renaming or moving the folder leaves the plan stranded on a path that
   * no longer exists — and every read of it fails. This is the way back: say where the folder lives now.
   */
  async function relink(linkedProjectId: string | null): Promise<void> {
    if (!projectId) return;
    setBusy('link');
    setError(null);
    try {
      await window.kaiDesktop.linkStudioProject({ projectId, linkedProjectId }).then(unwrap);
      setProjectsVersion((current) => current + 1);
      setNotice(linkedProjectId ? 'This plan now uses that folder.' : 'This plan keeps its own workspace again.');
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  /**
   * Reorders an existing board by what should be built first. A plan written before anything was built tends to hand
   * back hosting and managed services early; this is the second pass that moves them to where they belong. Every
   * card's status, runs and checks survive, so arranging never costs work.
   */
  async function arrange(): Promise<void> {
    if (!projectId) return;
    setBusy('arrange');
    setError(null);
    try {
      setBoard(unwrap(await window.kaiDesktop.arrangeStudioBoard(projectId)));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  /** The read itself, shared by the manual "Pull the design" button and each step of the build loop below — the
   * loop needs it without the button's own busy/notice handling, since it has its own for the whole run. */
  async function refreshDesign(): Promise<{ design: StudioDesign; changed: string[]; tokensChanged: boolean; tokenCount: number; tokensPreserved: boolean; differentDocument: boolean; artifacts: StudioArtifacts }> {
    const pulled = unwrap(await window.kaiDesktop.pullStudioDesign(projectId!));
    setDesign(pulled.design);
    setBoard(pulled.board);
    const artifacts = unwrap(await window.kaiDesktop.studioArtifacts(projectId!));
    setArtifacts(artifacts);
    // Returned as well as set: a build that just regenerated an artifact must build its next prompt from the new one,
    // and reading it back out of state would give it the catalog as it looked before the regeneration.
    return { ...pulled, artifacts };
  }

  /** Reads the design from open-pencil: the tokens go to `.kai/spec`, and a changed node restales its card. */
  async function pullDesign(): Promise<void> {
    if (!projectId) return;
    setBusy('design');
    setError(null);
    try {
      const pulled = await refreshDesign();
      setNotice(
        // Said first of all: the editor is on another project's file, so none of this belongs to this project.
        pulled.differentDocument
          ? 'The editor is open on a different document, so nothing was pulled into this project. Its pages share no id with the ones this project was drawn from. Open the document this project belongs to, then pull again.'
          // Said next, because it means the pull read the wrong document: the editor is open on something that has
          // no variables, or on a blank page. The token file was left as it was rather than emptied.
          : pulled.tokensPreserved
          ? 'The pull found no design variables, and this project already has tokens, so they were left alone. Check that the editor is open on the right document.'
          : pulled.changed.length > 0
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

  /** One step of the build loop: mints the id its live events will be tagged with, so the subscription above can
   * already be filtering for it before the call that produces them is even sent. */
  async function runBuildStep(name: string, prompt: string): Promise<{ status: 'completed' | 'failed'; output: string; error?: string; costUsd?: number }> {
    setBuildingStep(name);
    setBuildEvents([]);
    const stepId = `design_${crypto.randomUUID()}`;
    buildStepId.current = stepId;
    const result = unwrap(await window.kaiDesktop.buildStudioDesignStep(projectId!, prompt, stepId));
    if (result.costUsd) {
      buildCostRef.current += result.costUsd;
      setBuildCostUsd(buildCostRef.current);
    }
    return result;
  }

  /** A whole turn can fail for reasons that are gone a moment later — a provider hiccup, open-pencil briefly
   * unreachable between the per-step connection sync and the model's first call. One retry absorbs those without
   * making every transient blip stop the run and need a person to notice and click Build again. */
  async function runBuildStepWithRetry(name: string, prompt: string): Promise<{ status: 'completed' | 'failed'; output: string; error?: string }> {
    const first = await runBuildStep(name, prompt);
    if (first.status !== 'failed') return first;
    setNotice(`"${name}" failed, retrying once: ${first.error || 'the step failed.'}`);
    return runBuildStep(name, prompt);
  }

  /**
   * Runs the whole screen list end to end: the foundation first, then each undrawn screen in its own agent turn
   * against open-pencil's tools.
   *
   * Every step is judged by reading the design back, never by what the turn said about itself. A turn that reports
   * "completed" has only reported that it ended without a technical error — and a turn whose every call was refused
   * reports exactly that. So after each step the design is pulled, the step is checked against what the pull shows,
   * and the list of screens still to draw is read from that pull rather than from the list as it looked when the
   * button was pressed. Stops on the first step that did not land, rather than piling more work onto a failure.
   *
   * `action` changes what the loop asks for. Plain, it fills in only what is missing. A `redraw` of `'all'` draws
   * every screen in the pages list again and re-runs the foundation, because the variables and shared components come
   * from the same reference the screens do — the way to apply a look that changed after the screens were drawn; a
   * named redraw does just that one. A `clean` of one screen clears what is broken about it first. A redraw or clean
   * asks for screens that already exist, so it takes its list from the request (see `screensToRedraw`), not from
   * `remainingScreens`.
   */
  async function buildDesign(action?: DesignBuildAction): Promise<void> {
    if (!projectId || busy !== null) return;
    buildCancelled.current = false;
    setBusy('design-build');
    setError(null);
    setNotice(null);
    setLastFailedStep(null);
    setBuildCostUsd(0);
    buildCostRef.current = 0;
    let drawn = 0;
    const mode: DesignPromptMode = action?.kind === 'clean' ? 'clean' : 'redraw';
    // A screen that fails verification says what open-pencil holds instead, so a name that does not match is visible
    // rather than guessed at.
    const namesInPencil = (pull: Parameters<typeof drawnPageNames>[0]): string => drawnPageNames(pull).join(', ') || 'no pages';
    try {
      let pulled = await refreshDesign();
      if (!foundationDone || (action?.kind === 'redraw' && action.target === 'all')) {
        const result = await runBuildStepWithRetry('Foundation', promptFor('Foundation', 'draw', pulled.artifacts));
        if (result.status === 'failed') { setLastFailedStep('Foundation'); throw new Error(`Foundation: ${result.error || 'the step failed.'}`); }
        pulled = await refreshDesign();
        if (!foundationLanded(pulled)) {
          setLastFailedStep('Foundation');
          throw new Error(`Foundation: the turn finished, but open-pencil has no variables and no components of its own. ${describeTurn(result)}`);
        }
        toggleFoundation(true);
      }
      if (action) {
        const queue = screensToRedraw(pagesText, pulled, action.target === 'all' ? undefined : action.target);
        if (queue.length === 0) { setNotice('There is nothing to redraw: the pages list names no screens yet.'); return; }
        for (const target of queue) {
          if (buildCancelled.current) {
            setNotice(`Stopped with ${queue.length - drawn} screen${queue.length - drawn === 1 ? '' : 's'} still to redraw.`);
            return;
          }
          const result = await runBuildStepWithRetry(target.name, promptFor(target.name, mode, pulled.artifacts));
          if (result.status === 'failed') { setLastFailedStep(target.name); throw new Error(`${target.name}: ${result.error || 'the step failed.'}`); }
          pulled = await refreshDesign();
          if (!screenLanded(target.name, pulled)) {
            setLastFailedStep(target.name);
            throw new Error(`"${target.name}": the ${mode === 'clean' ? 'cleanup' : 'redraw'} finished, but open-pencil has no page named like it. It has: ${namesInPencil(pulled)}. ${describeTurn(result)}`);
          }
          drawn += 1;
        }
        setNotice(`${mode === 'clean' ? 'Fixed and redrew' : 'Redrew'} ${drawn} screen${drawn === 1 ? '' : 's'} in open-pencil${buildCostRef.current > 0 ? `, ~$${buildCostRef.current.toFixed(2)} spent` : ''}.`);
        clearStyleChanged();
        return;
      }
      // Recomputed from the pull each time round, so a screen drawn by an earlier step — or by hand, while this was
      // running — is never asked for twice. A skipped screen is left out, so it never blocks the rest.
      for (;;) {
        const remaining = remainingScreens(pagesText, pulled).filter((row) => !skipped.has(screenTitleKey(row.name)));
        if (remaining.length === 0) break;
        if (buildCancelled.current) {
          setNotice(`Stopped with ${remaining.length} screen${remaining.length === 1 ? '' : 's'} still to draw. Everything already drawn is kept; press Resume to carry on from here.`);
          return;
        }
        const row = remaining[0]!;
        const result = await runBuildStepWithRetry(row.name, promptFor(row.name, 'draw', pulled.artifacts));
        if (result.status === 'failed') { setLastFailedStep(row.name); throw new Error(`${row.name}: ${result.error || 'the step failed.'}`); }
        pulled = await refreshDesign();
        if (!screenLanded(row.name, pulled)) {
          setLastFailedStep(row.name);
          throw new Error(`"${row.name}": the turn finished, but open-pencil has no page named like it. It has: ${namesInPencil(pulled)}. ${describeTurn(result)}`);
        }
        drawn += 1;
      }
      setNotice(`Design build finished: ${drawn} screen${drawn === 1 ? '' : 's'} drawn and confirmed in open-pencil${buildCostRef.current > 0 ? `, ~$${buildCostRef.current.toFixed(2)} spent` : ''}.`);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      buildStepId.current = null;
      setBuildingStep(null);
      setBusy(null);
    }
  }

  /**
   * Draws every screen again, the foundation included. This is the way past a look that changed after the screens
   * were drawn — the tokens, the shared components and each screen all come from the same reference, so re-running
   * the whole thing is what makes them agree again. It is the expensive button, so it says how much it will replace.
   */
  async function redrawAll(): Promise<void> {
    if (busy !== null) return;
    const drawnCount = designRows.filter((row) => row.inPages && row.drawn).length;
    const confirmed = await confirmDialog({
      title: 'Redraw every screen?',
      detail: `The foundation and every screen in the pages list are drawn again in open-pencil, each as its own paid model call. ${drawnCount} screen${drawnCount === 1 ? '' : 's'} now drawn will be replaced. Nothing in .kai/spec changes, and Stop still works.`,
      confirmLabel: 'Redraw all',
      destructive: true,
    });
    if (!confirmed) return;
    await buildDesign({ kind: 'redraw', target: 'all' });
  }

  /**
   * The way past one screen Studio can never match — a page carrying the wrong name, a duplicate, a half-drawn
   * leftover. It authorizes the agent to delete whatever stands for this screen and then draw it again, and says so
   * before it runs: deleting in open-pencil cannot be undone from KAI. Only this screen's pages are in scope.
   */
  async function fixAndRedraw(name: string): Promise<void> {
    if (busy !== null) return;
    const confirmed = await confirmDialog({
      title: `Fix and redraw "${name}"?`,
      detail: 'The agent may delete, in open-pencil, whatever is blocking this screen — a duplicate page, a leftover only half drawn, a page named so Studio cannot match it — and then draw the screen again from scratch. Deleting in open-pencil cannot be undone from KAI. Only this screen\'s pages are touched; no other screen is.',
      confirmLabel: 'Fix and redraw',
      destructive: true,
    });
    if (!confirmed) return;
    await buildDesign({ kind: 'clean', target: name });
  }

  /**
   * Renames one screen. KAI owns the name, so it writes both places it lives — the `pages.md` heading and the
   * open-pencil page — and the route is left as it is. Works for a page that only exists in open-pencil too, which is
   * how a stray drawn under the wrong name is brought back under a planned screen's name.
   */
  async function renamePage(rowName: string): Promise<void> {
    if (!projectId || busy !== null) return;
    const next = await promptDialog({
      title: `Rename "${rowName}"`,
      label: 'Screen name',
      initialValue: rowName,
      confirmLabel: 'Rename',
      validate: (value) => {
        const trimmed = value.trim();
        if (!trimmed) return 'A screen needs a name.';
        if (trimmed.length > 80) return 'Keep it to 80 characters.';
        return trimmed === rowName ? 'That is the name it already has.' : null;
      },
    });
    if (next === null || next.trim() === rowName) return;
    setBusy('page-op');
    setError(null);
    try {
      const pulled = unwrap(await window.kaiDesktop.renameStudioDesignPage({ projectId, currentName: rowName, name: next.trim() }));
      setDesign(pulled.design);
      setBoard(pulled.board);
      // The pages list changed, so the catalog is read again — the same effect that re-reads it after a hand edit.
      setArtifacts(unwrap(await window.kaiDesktop.studioArtifacts(projectId)));
      setNotice(`Renamed to "${next.trim()}" in the pages list and in open-pencil.`);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  /**
   * Deletes one screen's page in open-pencil — the direct fix for a page that errored or is named so nothing matches
   * it. It cannot be undone from KAI, so it says so first. The screen stays in the pages list and reads as still to
   * draw, which is the recovery path.
   */
  async function deletePage(rowName: string, pageId: string): Promise<void> {
    if (!projectId || busy !== null) return;
    const confirmed = await confirmDialog({
      title: `Delete the drawn page "${rowName}"?`,
      detail: 'The page is deleted in open-pencil, and that cannot be undone from KAI. The screen stays in the pages list, so it shows as still to draw and you can draw it again. Only this one page is touched; no other screen is.',
      confirmLabel: 'Delete page',
      destructive: true,
    });
    if (!confirmed) return;
    setBusy('page-op');
    setError(null);
    try {
      const pulled = unwrap(await window.kaiDesktop.deleteStudioDesignPage({ projectId, pageId }));
      setDesign(pulled.design);
      setBoard(pulled.board);
      setNotice(`Deleted the open-pencil page for "${rowName}". The screen is still in the pages list — draw it again when you are ready.`);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  /**
   * Puts the design back in step with the style reference, in the one click the reference cannot do for itself.
   *
   * A reference added after the artifacts were written steers nothing until those artifacts are written again, and
   * the screens are drawn again to follow them — neither happens on its own. This does them in order: the style guide
   * and the tokens are regenerated from the reference, then the foundation and every screen are drawn again. With no
   * reference at all it skips the regeneration and just draws, and the prompts then take the look from the document.
   */
  async function applyStyleReference(): Promise<void> {
    if (!projectId || busy !== null) return;
    const hasReference = Boolean(styleRefs?.notes?.trim());
    const drawnCount = designRows.filter((row) => row.inPages && row.drawn).length;
    const confirmed = await confirmDialog({
      title: hasReference ? 'Apply the style reference to the design?' : 'Draw the screens from open-pencil?',
      detail: hasReference
        ? `The style guide and the tokens are written again from your reference, then the foundation and every screen are drawn again in open-pencil so they follow it. ${drawnCount} screen${drawnCount === 1 ? '' : 's'} now drawn will be replaced. Each step is its own paid model call. Nothing in .kai/spec is thrown away — the old copies stay in the spec history.`
        : 'There is no style reference yet, so there is nothing to write the style guide and tokens from. The foundation and every screen are drawn again from the look already in the open-pencil document — its variables, shared styles and components — and the agent\'s own judgment where nothing exists yet. Each step is its own paid model call.',
      confirmLabel: hasReference ? 'Apply and redraw' : 'Redraw the design',
      destructive: true,
    });
    if (!confirmed) return;
    try {
      if (hasReference) {
        await generateOne('style-guide');
        await generateOne('tokens');
      }
      await buildDesign({ kind: 'redraw', target: 'all' });
    } finally {
      clearStyleChanged();
    }
  }

  /**
   * What to add when a step finished but left nothing behind. The turn's own words are the most likely place the
   * reason is — a model that could not work usually says so — and without them the reader has a bare "it did not
   * work" and nowhere to look.
   */
  function describeTurn(result: { output: string }): string {
    const said = result.output.trim().replace(/\s+/g, ' ');
    return said ? `The turn said: "${said.slice(0, 400)}"` : 'The turn said nothing.';
  }

  function stopBuildingDesign(): void {
    buildCancelled.current = true;
    // And the turn in flight, which would otherwise finish drawing a screen nobody is waiting for. Best effort: a
    // step that has already answered cannot be called back.
    const stepId = buildStepId.current;
    if (stepId) void window.kaiDesktop.cancelStudioDesignStep(projectId!, stepId).catch(() => undefined);
  }

  // Leaving the Studio screen while a build is running used to orphan it: the component unmounts, so the loop keeps
  // making paid turns with no Stop button anywhere on screen, and coming back shows an idle tab that can start a
  // second build into the same document.
  useEffect(() => () => {
    if (!buildStepId.current) return;
    buildCancelled.current = true;
    void window.kaiDesktop.cancelStudioDesignStep(projectId ?? '', buildStepId.current).catch(() => undefined);
  }, [projectId]);

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

  /**
   * The walkthrough. The only call the guide makes, and the service only passes it on when the stored explanation is
   * for a different situation — so reading the same screen twice costs once.
   */
  async function explainGuide(): Promise<void> {
    if (!projectId) return;
    setExplaining(true);
    setError(null);
    try {
      setGuide(unwrap(await window.kaiDesktop.explainStudioGuide(projectId)));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setExplaining(false);
    }
  }

  /**
   * Presses the button the guide is offering.
   *
   * Every one of these is an operation the board already has, called the same way the button on the screen calls it —
   * the guide adds no path to the board that a person could not take by hand. A step with no action is the reader's
   * own to do, which is why two of these only change tabs.
   */
  async function runGuideAction(action: GuideAction): Promise<void> {
    if (!projectId) return;
    if (action === 'open-board') { setTab('board'); return; }
    if (action === 'open-design') { setTab('design'); return; }
    setError(null);
    setNotice(null);
    // `busy` is claimed by whichever operation runs, not here first: `buildDesign` refuses to start while another
    // action holds it, and it only passes today because the closure it reads is a render behind. Claiming it here
    // would make the guide's own button the thing that stops the guide's own button.
    try {
      // `writeArtifacts` reports what it could not write instead of throwing, so its answer has to be read here —
      // a button that says nothing after failing is the same as a button that did nothing.
      if (action === 'write-artifacts') {
        setBusy('generate');
        const problems = await writeArtifacts(projectId, true);
        if (problems.length > 0) setError(problems.join(' '));
      } else if (action === 'build-board') await plan();
      else if (action === 'pull-design') await pullDesign();
      else if (action === 'draw-screens') await buildDesign();
      else if (action === 'requeue-blocked') {
        setBusy('guide');
        const { requeued } = unwrap(await window.kaiDesktop.requeueAutopilot({ projectId }));
        setNotice(requeued === 0
          ? 'No cards parked by an agent were found.'
          : `${requeued} card${requeued === 1 ? '' : 's'} back in the queue. Start Autopilot when you are ready.`);
      } else if (action === 'run-autopilot') {
        // The same settings the Autopilot panel's own Start button uses, said out loud, since the panel is not on
        // screen to show them.
        setBusy('guide');
        await window.kaiDesktop.startAutopilot({ projectId, ...DEFAULT_AUTOPILOT_START }).then(unwrap);
        setNotice('Autopilot started with the panel’s default settings. Open the Board tab to watch it or stop it.');
      }
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  /** Sets the route a screen card is checked at. Without one the card can never pass, so it can never be done. */
  async function setRoute(cardId: string, route: string): Promise<void> {
    if (!projectId) return;
    setBusy('card');
    setError(null);
    try {
      const updated = unwrap(await window.kaiDesktop.setStudioCardRoute({ projectId, cardId, route }));
      setBoard((current) => (current ? { ...current, cards: current.cards.map((card) => (card.id === updated.id ? updated : card)) } : current));
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
            {screen === 'project' && (
              <span className="studio-relink">
                <select
                  aria-label="The folder this plan uses"
                  value={state?.linkedProjectId ?? ''}
                  disabled={busy !== null}
                  onChange={(event) => void relink(event.target.value || null)}
                >
                  <option value="">Independent (KAI's own folder)</option>
                  {desktopProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>
              </span>
            )}
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
            ['guide', 'Senior dev'],
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
                <p className="studio-note">Question {Math.min(state.rounds.flatMap((round) => round.questions).length, interviewQuestionBudget(state))} of up to {interviewQuestionBudget(state)}. Skip anything you would rather leave to the agents, or pick "Not sure, you decide".</p>
                {state.extraQuestions < STUDIO_EXTRA_QUESTIONS * STUDIO_MAX_EXTENSIONS && (
                  <button type="button" className="composer-text-button" onClick={() => void extendInterview()} disabled={busy !== null} title={`New to this? KAI will ask ${STUDIO_EXTRA_QUESTIONS} more questions and explain the choices.`}>
                    I am new to this: ask me {STUDIO_EXTRA_QUESTIONS} more
                  </button>
                )}
              </div>
              <div className="studio-thread" role="log" aria-live="polite">
                <div className="studio-bubble user">{state.idea}</div>
                {(() => {
                  const answered = state.rounds.slice(0, -1).flatMap((round) => round.answers);
                  const turns = answered.length + step;
                  // Images sit after the turn they were attached at; an unknown one sits after the idea.
                  const attachedAfter = (count: number) => (styleRefs?.images ?? []).filter((image) => Math.min(attachedAt[image.name] ?? 0, turns) === count);
                  const attachments = (count: number) => {
                    const images = attachedAfter(count);
                    if (images.length === 0) return null;
                    return (
                      <div key={`attached-${count}`} className="studio-bubble user studio-attached" aria-label="Images you attached">
                        <div className="message-attachments">
                          {images.map((image) => (
                            image.preview
                              ? <ImageCard key={image.name} name={image.name} dataUrl={image.preview} />
                              : <span key={image.name} className="studio-note">{image.name}</span>
                          ))}
                        </div>
                      </div>
                    );
                  };
                  const turnNodes = [
                    ...answered.map((item) => (
                      <ThreadTurn
                        key={item.question}
                        question={item.question}
                        answer={item.answer}
                        disabled={busy !== null}
                        onEdit={() => startCorrection(item.question, item.answer)}
                      />
                    )),
                    ...open.slice(0, step).map((question, index) => (
                      <ThreadTurn key={question} question={question} answer={answers[index] ?? ''} />
                    )),
                  ];
                  return (
                    <>
                      {attachments(0)}
                      {turnNodes.map((node, index) => (
                        <Fragment key={node.key}>
                          {node}
                          {attachments(index + 1)}
                        </Fragment>
                      ))}
                    </>
                  );
                })()}
                {attachNote && <div className="studio-bubble ai">{attachNote}</div>}
                {open[step] !== undefined && <div className="studio-bubble ai">{open[step]}</div>}
                {open.length === 0 && <p className="studio-note">No questions this round.</p>}
                {busy === 'answer' && <div className="studio-bubble ai"><Loader2 className="spin" size={13} /> Thinking about what to ask next…</div>}
                <div ref={threadEnd} />
              </div>
              {(open[step] !== undefined || correcting !== null) && (
                <div className="studio-reply">
                  {correcting && (
                    <div className="studio-correcting" role="status">
                      <PencilLine size={13} />
                      <span>Correcting: <strong>{correcting.question}</strong>. KAI asks again from here, so anything you answered after it is asked again too.</span>
                      <button type="button" className="composer-text-button" onClick={cancelCorrection} disabled={busy !== null}>Cancel</button>
                    </div>
                  )}
                  {!correcting && (openOptions[step] ?? []).length > 0 && (
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
                    placeholder={correcting ? 'Rewrite your answer' : 'Pick a suggestion or type your own answer'}
                    ariaLabel="Your answer"
                    disabled={busy !== null}
                    sending={busy === 'answer'}
                    enhancing={busy === 'enhance'}
                    onEnhance={() => void enhanceDraft()}
                    extra={(
                      <>
                        {/* Reference images and the suggestions belong to the question on screen, not to a correction. */}
                        {!correcting && (
                          <label className="composer-text-button studio-file-button" title="Attach images of a look you like (PNG, JPEG or WebP)">
                            <ImagePlus size={13} /> Image
                            <input type="file" accept="image/png,image/jpeg,image/webp" multiple hidden disabled={busy !== null} onChange={(event) => { void attachStyleImages(event.target.files); event.target.value = ''; }} />
                          </label>
                        )}
                        <button type="button" className="composer-text-button" onClick={() => void submitStep('')} disabled={busy !== null} title={correcting ? 'Change this answer to a skip, and let the agents decide' : 'Leave this one to the agents'}>Skip</button>
                        {!correcting && (
                          <button type="button" className="composer-text-button" onClick={() => void submitStep(open[step] ? (openOptions[step]?.[0] ?? '') : '')} disabled={busy !== null || !openOptions[step]?.[0]} title="Let KAI choose the first suggestion">Decide for me</button>
                        )}
                      </>
                    )}
                    footer={<><span>Enter to send · Shift+Enter for a new line</span><span>{state.rounds.flatMap((round) => round.questions).length} of up to {interviewQuestionBudget(state)} questions</span></>}
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
              <button type="button" className="primary-button" onClick={() => void generate()} disabled={busy !== null || !readiness?.ready} title="Write the artifacts that are missing or stale">
                {busy === 'generate' ? <Loader2 className="spin" size={14} /> : <Wand2 size={14} />} Generate all
              </button>
              <button type="button" className="secondary-button" onClick={() => void regenerateAll()} disabled={busy !== null || !readiness?.ready} title="Rewrite every artifact from the brief, even the ones that are up to date">
                <RefreshCw size={14} /> Regenerate all
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
              <section className={`studio-viewer${viewerFull ? ' studio-viewer-full' : ''}`} aria-label={`${viewing} artifact`}>
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
                    {viewing === 'flows' && flowJourneys.length > 0 && editText === null && (
                      <button type="button" className="secondary-button" onClick={() => setViewMode(viewMode === 'diagram' ? 'text' : 'diagram')}>{viewMode === 'diagram' ? 'Show text' : 'Show diagram'}</button>
                    )}
                    <button type="button" className="secondary-button" onClick={() => setViewerFull((current) => !current)} aria-pressed={viewerFull} title={viewerFull ? 'Leave full screen (Esc)' : 'Show this artifact full screen'}>
                      {viewerFull ? <Minimize2 size={13} /> : <Maximize2 size={13} />} {viewerFull ? 'Exit full screen' : 'Full screen'}
                    </button>
                    <button type="button" className="secondary-button" onClick={() => { setViewing(null); setEditText(null); setViewerFull(false); }}>Close</button>
                  </span>
                </header>
                {viewText === null ? (
                  <p className="studio-note"><Loader2 className="spin" size={13} /> Reading…</p>
                ) : editText !== null ? (
                  <textarea className="studio-viewer-edit" value={editText} onChange={(event) => setEditText(event.target.value)} spellCheck={false} aria-label={`Edit ${viewing}`} />
                ) : !viewText.trim() ? (
                  <p className="studio-note">This artifact is empty.</p>
                ) : viewing === 'flows' && flowJourneys.length > 0 && viewMode === 'diagram' ? (
                  <FlowDiagram journeys={flowJourneys} fill={viewerFull} />
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
              open-pencil is the source of truth for tokens and for which screens exist. Pulling writes <code>.kai/spec/design/tokens.json</code> (the style guide is written from those tokens), gives each component and page its card, and marks the cards drawn from a node you changed. Pull the design also launches the editor for you and reconnects KAI to whatever it reports, so there is nothing to start by hand.
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

          {tab === 'design' && (
            <>
              <article className="studio-card">
                <h2><LayoutGrid size={16} /> Draw in open-pencil</h2>
                <p className="studio-note">
                  Build the design runs the whole list for you: the foundation first, then one screen at a time, checking after each step that open-pencil really holds the screen before moving on. Stop any time — the screens already drawn are kept and Resume carries on from the first one still missing. Copy prompt is still here for running a single step yourself.
                </p>
                <div className="page-actions">
                  {busy === 'design-build' ? (
                    <button type="button" className="secondary-button" onClick={stopBuildingDesign}>
                      <Square size={14} /> Stop
                    </button>
                  ) : (
                    <button type="button" className="primary-button" onClick={() => void buildDesign()} disabled={busy !== null || !readiness?.ready || toDraw.length === 0}>
                      <Wand2 size={14} /> {buildButtonLabel}
                    </button>
                  )}
                  <button type="button" className="secondary-button" onClick={() => void pullDesign()} disabled={busy !== null}>
                    {busy === 'design' ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />} Pull the design
                  </button>
                  {designRows.some((row) => row.inPages && row.drawn) && (
                    <button type="button" className="secondary-button" onClick={() => void redrawAll()} disabled={busy !== null || !readiness?.ready} title="Draw every screen again, foundation included — the way to apply a look you changed after drawing">
                      <RotateCcw size={14} /> Redraw all
                    </button>
                  )}
                  {!pagesText && (
                    <button type="button" className="secondary-button" onClick={() => void generateOne('pages')} disabled={busy !== null || !readiness?.ready}>
                      {busy === 'generate' ? <Loader2 className="spin" size={14} /> : <Play size={14} />} Write the pages list
                    </button>
                  )}
                  <span className="studio-model">{designRows.filter((row) => row.drawn).length} of {designRows.length} screens drawn</span>
                  {skipped.size > 0 && <span className="studio-model">{designRows.filter((row) => row.inPages && !row.drawn && skipped.has(screenTitleKey(row.name))).length} skipped</span>}
                  {buildCostUsd > 0 && <span className="studio-model">~${buildCostUsd.toFixed(2)} spent this build</span>}
                </div>
                {busy === 'design-build' && (() => {
                  const activity = deriveAgentActivity(buildEvents, true, false, false);
                  return (
                    <p className="studio-note">
                      <Loader2 className="spin" size={13} /> Building {buildingStep ? `"${buildingStep}"` : '…'}
                      {buildEvents.length > 0 ? `: ${activity.label.toLowerCase()} — ${activity.detail}` : ' — connecting to open-pencil (launched automatically if it is not already running)…'}
                    </p>
                  );
                })()}
                <ul className="studio-steps">
                  <li className={foundationDone ? 'done' : undefined}>
                    <label className="studio-step-check">
                      <input type="checkbox" checked={foundationDone} onChange={(event) => toggleFoundation(event.target.checked)} aria-label="Foundation step finished" />
                      <span><strong>1 · Foundation</strong><small>Variables from the tokens, text styles and the shared components. No screens.</small></span>
                    </label>
                    <PromptButtons id="Foundation" openPrompt={openPrompt} copiedPrompt={copiedPrompt} onToggle={setOpenPrompt} onCopy={(key) => void copyDrawPrompt(key)} />
                    {openPrompt === 'Foundation' && <PromptPanel text={promptFor('Foundation')} copied={copiedPrompt === 'Foundation'} onCopy={() => void copyDrawPrompt('Foundation')} onClose={() => setOpenPrompt(null)} />}
                  </li>
                </ul>
                <label className="studio-search">
                  <Search size={13} />
                  <input type="search" value={screenQuery} onChange={(event) => setScreenQuery(event.target.value)} placeholder="Search screens by name, route or what is on them" aria-label="Search screens" />
                </label>
                {designRows.length > 0 ? (
                  <ul className="studio-steps">
                    {visibleRows.map((row) => {
                      const isSkipped = !row.drawn && skipped.has(screenTitleKey(row.name));
                      const pageId = screenPageId(design, row.name);
                      return (
                        <li key={row.name} className={row.drawn ? 'done' : undefined}>
                          <div className="studio-step-text">
                            <strong>{row.name}{row.route ? <code> {row.route}</code> : null}</strong>
                            <small>
                              <span className={`studio-kind ${row.drawn ? 'drawn' : ''}`}>{row.drawn ? 'drawn' : isSkipped ? 'skipped' : 'to draw'}</span>
                              {!row.inPages && <span className="studio-kind"> not in the pages list</span>}
                            </small>
                          </div>
                          {row.inPages ? (
                            <PromptButtons
                              id={row.name}
                              openPrompt={openPrompt}
                              copiedPrompt={copiedPrompt}
                              onToggle={setOpenPrompt}
                              onCopy={(key) => void copyDrawPrompt(key)}
                              extra={<>
                                {row.drawn ? (
                                  <button type="button" className="secondary-button" onClick={() => void buildDesign({ kind: 'redraw', target: row.name })} disabled={busy !== null || !readiness?.ready} aria-label={`Redraw ${row.name}`}>
                                    <RotateCcw size={13} /> Redraw
                                  </button>
                                ) : (
                                  <button type="button" className="secondary-button" onClick={() => toggleSkip(row.name)} aria-label={`${isSkipped ? 'Draw' : 'Skip'} ${row.name}`}>
                                    <SkipForward size={13} /> {isSkipped ? 'Draw it anyway' : 'Skip'}
                                  </button>
                                )}
                                <button type="button" className="secondary-button" onClick={() => void fixAndRedraw(row.name)} disabled={busy !== null || !readiness?.ready} aria-label={`Fix and redraw ${row.name}`} title="Ask an agent to clear whatever is blocking this screen in open-pencil — a duplicate, a leftover, a page named so nothing matches it — and draw it again">
                                  <Wand2 size={13} /> Fix & redraw
                                </button>
                                <PageButtons name={row.name} pageId={pageId} canRename disabled={busy !== null} onRename={(name) => void renamePage(name)} onDelete={(name, id) => void deletePage(name, id)} />
                              </>}
                            />
                          ) : (
                            <span className="studio-step-buttons">
                              <PageButtons name={row.name} pageId={pageId} canRename disabled={busy !== null} onRename={(name) => void renamePage(name)} onDelete={(name, id) => void deletePage(name, id)} />
                            </span>
                          )}
                          {row.inPages && openPrompt === row.name && <PromptPanel text={promptFor(row.name)} copied={copiedPrompt === row.name} onCopy={() => void copyDrawPrompt(row.name)} onClose={() => setOpenPrompt(null)} />}
                        </li>
                      );
                    })}
                    {visibleRows.length === 0 && <li className="studio-note">No screen matches "{screenQuery}".</li>}
                  </ul>
                ) : (
                  <p className="studio-note">{pagesText === null ? 'No pages list yet. Write it, or generate all artifacts.' : 'The pages artifact has no screens in it yet.'}</p>
                )}
              </article>

              <article className="studio-card">
                <h2><Palette size={16} /> Style reference</h2>
                <p className="studio-note">Add up to four images of a look you like (a screenshot, a mood board, a competitor), then describe them. The description is written to <code>.kai/spec/design/style-reference.md</code> and steers the drawing — and the style guide and tokens are written from it, but only when they are regenerated. So after adding or changing a reference, use Apply below: it writes the style guide and the tokens from the reference, then draws every screen again to follow them. open-pencil itself never reads the images.</p>
                <div className="page-actions">
                  <label className="secondary-button studio-file-button">
                    <Plus size={14} /> Add images
                    <input type="file" accept="image/png,image/jpeg,image/webp" multiple hidden disabled={busy !== null} onChange={(event) => { void addReferenceImages(event.target.files); event.target.value = ''; }} />
                  </label>
                  <button type="button" className="secondary-button" onClick={() => void describeReferences()} disabled={busy !== null || !styleRefs || styleRefs.images.length === 0 || !readiness?.ready}>
                    {busy === 'design' ? <Loader2 className="spin" size={14} /> : <Eye size={14} />} Describe the style
                  </button>
                </div>
                {styleRefs && styleRefs.images.length > 0 ? (
                  <ul className="studio-refs">
                    {styleRefs.images.map((image) => (
                      <li key={image.name}>
                        {image.preview ? <img src={image.preview} alt={image.name} /> : <span className="studio-note">No preview</span>}
                        <span className="studio-note">{image.name}</span>
                        <button type="button" className="secondary-button" onClick={() => void removeReferenceImage(image.name)} disabled={busy !== null} aria-label={`Remove ${image.name}`}><Trash2 size={13} /></button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="studio-note">No images yet.</p>
                )}
                {styleChanged && designRows.some((row) => row.drawn) && (
                  <div className="studio-note">
                    <AlertTriangle size={13} /> The look changed after these screens were drawn — apply it below so the style guide, the tokens and the screens all follow it.
                  </div>
                )}
                {designRows.some((row) => row.inPages && row.drawn) && (
                  <div className="page-actions">
                    <button type="button" className="secondary-button" onClick={() => void applyStyleReference()} disabled={busy !== null || !readiness?.ready}>
                      <Wand2 size={14} /> {hasStyleReference ? 'Apply the style reference' : 'Draw from open-pencil'}
                    </button>
                    <span className="studio-model">
                      {hasStyleReference
                        ? 'Writes the style guide and tokens from your reference, then draws every screen again.'
                        : 'No reference yet — draws every screen from the look already in the open-pencil document.'}
                    </span>
                  </div>
                )}
                {styleRefs?.notes && <div className="studio-viewer-body"><Markdown text={styleRefs.notes} /></div>}
              </article>
            </>
          )}

          {tab === 'guide' && (
            <GuidePanel
              view={guide}
              explaining={explaining}
              busy={busy !== null}
              onExplain={() => void explainGuide()}
              onAction={(action) => void runGuideAction(action)}
            />
          )}

          {tab === 'board' && (
          <article className={`studio-card${boardFull ? ' studio-fullscreen' : ''}`}>
            <h2><LayoutGrid size={16} /> Board
              <button type="button" className="secondary-button studio-fullscreen-toggle" onClick={() => setBoardFull((current) => !current)} aria-pressed={boardFull} title={boardFull ? 'Leave full screen (Esc)' : 'Show the board full screen'}>
                {boardFull ? <Minimize2 size={13} /> : <Maximize2 size={13} />} {boardFull ? 'Exit full screen' : 'Full screen'}
              </button>
            </h2>
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
              <button type="button" className="secondary-button" onClick={() => void arrange()} disabled={busy !== null || !board?.cards.length} title="Puts the cards in the order they should be built, so the product runs on your machine before anything is hosted. Status, runs and checks are kept.">
                {busy === 'arrange' ? <Loader2 className="spin" size={14} /> : <Sparkles size={14} />} Arrange with AI
              </button>
            </div>
            {projectId && board && board.cards.length > 0 && (
              <NeedsYouBanner
                board={board}
                artifacts={artifacts}
                design={design}
                guide={guide}
                run={autopilot}
                busy={busy !== null}
                onAction={(action) => void runGuideAction(action)}
              />
            )}
            {projectId && board && board.cards.length > 0 && (
              <GuideStrip
                view={guide}
                busy={busy !== null}
                onAction={(action) => void runGuideAction(action)}
                onOpen={() => setTab('guide')}
              />
            )}
            {projectId && board && board.cards.length > 0 && (
              <AutopilotPanel
                projectId={projectId}
                ready={board.cards.filter((card) => card.status === 'ready').length}
                inProgress={board.cards.filter((card) => card.status === 'inProgress').length}
                waiting={board.cards.filter((card) => card.status === 'backlog').length}
                blocked={board.cards.filter((card) => card.status === 'blocked').length}
                disabled={busy !== null}
              />
            )}
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
                      <h3>{BOARD_STATUS_LABEL[status]} <span className="studio-count">{cards.length}</span></h3>
                      {cards.map((card) => <BoardCardView key={card.id} card={card} busy={busy !== null} onMove={move} onCheckUi={checkUi} onSetRoute={setRoute} />)}
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
              footer={<><span>Enter to start · Shift+Enter for a new line</span><span>KAI will ask up to {STUDIO_MAX_QUESTIONS} questions, and more if you ask</span></>}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * A card's own note — where a blocked card's reason lives.
 *
 * A long one scrolls inside the tile rather than being cut. The note is the card's only account of why it is where it
 * is, and an ellipsis in the middle of a failure report is worse than a shorter card. The cap is in whole line-heights
 * with the breathing room in margin, because a scroll container clips at its padding box and lets the next line show
 * through under the last one.
 */
function CardNote({ note, blocked }: { note: string; blocked: boolean }): ReactNode {
  return (
    <div className={`studio-note studio-why${blocked ? ' blocked' : ''}`}>
      <span className="studio-why-icon" aria-hidden="true">{blocked ? <AlertTriangle size={12} /> : <FileText size={12} />}</span>
      <div className="studio-why-text">{note.trim()}</div>
    </div>
  );
}

/**
 * The route a screen card is checked at.
 *
 * It is here because nothing else could set it: the board will not close a component or page card without a passing
 * screen check, the check needs a route to open, and a page pulled from the design carries one only when its name
 * does. A card with no route was therefore unclosable and everything waiting on it was stuck behind it.
 */
function CardRoute({ cardId, title, route, busy, onSetRoute }: { cardId: string; title: string; route: string; busy: boolean; onSetRoute: (id: string, route: string) => Promise<void> }): ReactNode {
  const [value, setValue] = useState(route);
  useEffect(() => setValue(route), [route]);
  const changed = value.trim() !== route;
  return (
    <div className="studio-route">
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && changed) void onSetRoute(cardId, value); }}
        placeholder="/pricing"
        aria-label={`Route for ${title}`}
        disabled={busy}
      />
      {changed && <button type="button" className="secondary-button" onClick={() => void onSetRoute(cardId, value)} disabled={busy}>Save route</button>}
    </div>
  );
}

function BoardCardView({ card, busy, onMove, onCheckUi, onSetRoute }: { card: BoardCard; busy: boolean; onMove: (id: string, status: BoardStatus) => Promise<void>; onCheckUi: (id: string) => Promise<void>; onSetRoute: (id: string, route: string) => Promise<void> }): ReactNode {
  const ui = card.kind === 'component' || card.kind === 'page';
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
      {/* The reason a card is where it is. It was always on the card and never on the screen, so a board full of
          blocked cards read as a board with no reason — while the reason sat in this field. */}
      {card.notes.trim() && <CardNote note={card.notes} blocked={card.status === 'blocked'} />}
      {card.claimedBy && <p className="studio-note"><Loader2 size={12} /> Held by {card.claimedBy}</p>}
      {card.movedBy && card.movedAt && (
        <p className="studio-note studio-moved">
          <span className={`studio-who ${card.movedBy}`}>{card.movedBy === 'user' ? 'you' : card.movedBy === 'check' ? 'check' : 'agent'}</span>
          moved {card.movedAt.slice(0, 16).replace('T', ' ')}
        </p>
      )}
      {card.check && <p className="studio-note">{card.check.visual === 'passed' ? <Check size={12} /> : <AlertTriangle size={12} />} Visual check {card.check.visual ?? 'not run'} · {card.check.screenshots.length} shots</p>}
      {ui && !card.route && (
        <p className="studio-note studio-why blocked">
          <AlertTriangle size={12} /> No route, so this screen cannot be checked and the board will not close it. Set one below.
        </p>
      )}
      {ui && (
        <button type="button" className="secondary-button" onClick={() => void onCheckUi(card.id)} disabled={busy || !card.route}>
          <Eye size={13} /> {card.route ? 'Check the screen' : 'No route set'}
        </button>
      )}
      {ui && <CardRoute cardId={card.id} title={card.title} route={card.route} busy={busy} onSetRoute={onSetRoute} />}
      <select
        className="studio-move"
        value={card.status}
        onChange={(event) => void onMove(card.id, event.target.value as BoardStatus)}
        disabled={busy}
        aria-label={`Move ${card.title}`}
      >
        {BOARD_STATUSES.map((status) => <option key={status} value={status}>{BOARD_STATUS_LABEL[status]}</option>)}
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

/** View and Copy for one drawing step. Copy also opens the prompt, so what was copied is never hidden.
 * `extra` is the per-screen action that sits alongside them — Redraw once drawn, Skip while it is not. */
function PromptButtons({ id, openPrompt, copiedPrompt, onToggle, onCopy, extra }: {
  id: string;
  openPrompt: string | null;
  copiedPrompt: string | null;
  onToggle: (key: string | null) => void;
  onCopy: (key: string) => void;
  extra?: ReactNode;
}): ReactNode {
  const open = openPrompt === id;
  return (
    <span className="studio-step-buttons">
      <button type="button" className="secondary-button" onClick={() => onToggle(open ? null : id)} aria-expanded={open} aria-label={`${open ? 'Hide' : 'View'} the prompt for ${id}`}>
        <Eye size={13} /> {open ? 'Hide' : 'View'}
      </button>
      <button type="button" className="secondary-button" onClick={() => onCopy(id)} aria-label={`Copy the prompt for ${id}`}>
        {copiedPrompt === id ? <Check size={13} /> : <Send size={13} />} {copiedPrompt === id ? 'Copied' : 'Copy prompt'}
      </button>
      {extra}
    </span>
  );
}

/**
 * Rename and Delete for one screen: the acts the build loop cannot aim at a single page. Rename is offered wherever
 * the name lives — the pages list, open-pencil, or both — because either side can be the wrong one. Delete is offered
 * only when a page exists to delete, and it is the one control here that says, before it runs, that open-pencil
 * cannot undo it from KAI.
 */
function PageButtons({ name, pageId, canRename, disabled, onRename, onDelete }: {
  name: string;
  pageId: string | null;
  canRename: boolean;
  disabled: boolean;
  onRename: (name: string) => void;
  onDelete: (name: string, pageId: string) => void;
}): ReactNode {
  if (!canRename && pageId === null) return null;
  return (
    <>
      {canRename && (
        <button type="button" className="secondary-button" onClick={() => onRename(name)} disabled={disabled} aria-label={`Rename ${name}`} title="Rename this screen in the pages list and, when it is drawn, in open-pencil too. The route is left as it is.">
          <PencilLine size={13} /> Rename
        </button>
      )}
      {pageId !== null && (
        <button type="button" className="secondary-button" onClick={() => onDelete(name, pageId)} disabled={disabled} aria-label={`Delete the open-pencil page for ${name}`} title="Delete this screen's page in open-pencil. It cannot be undone from KAI.">
          <Trash2 size={13} /> Delete page
        </button>
      )}
    </>
  );
}

/** The prompt itself, under its row: read it, copy it again, or close it. */
function PromptPanel({ text, copied, onCopy, onClose }: { text: string; copied: boolean; onCopy: () => void; onClose: () => void }): ReactNode {
  return (
    <div className="studio-step-prompt">
      <p className="studio-note">{copied ? 'Copied to the clipboard.' : 'This is the prompt.'} Paste it into the Workspace composer for a KAI agent that has open-pencil connected, and let it finish before the next one. Build the design does this for you.</p>
      <textarea readOnly value={text} rows={Math.min(14, text.split('\n').length + 1)} aria-label="The prompt" onFocus={(event) => event.currentTarget.select()} />
      <span className="studio-step-buttons">
        <button type="button" className="secondary-button" onClick={onCopy}><Send size={13} /> Copy again</button>
        <button type="button" className="secondary-button" onClick={onClose}>Close</button>
      </span>
    </div>
  );
}

function ThreadTurn({ question, answer, onEdit, disabled }: { question: string; answer: string; onEdit?: () => void; disabled?: boolean }): ReactNode {
  return (
    <>
      <div className="studio-bubble ai">{question}</div>
      <div className={`studio-bubble user${answer ? '' : ' skipped'}`}>
        {answer || 'Skipped, you decide'}
        {onEdit && (
          <button type="button" className="studio-answer-edit" onClick={onEdit} disabled={disabled} title="Change this answer; KAI asks again from here">
            <PencilLine size={12} /> Edit
          </button>
        )}
      </div>
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
