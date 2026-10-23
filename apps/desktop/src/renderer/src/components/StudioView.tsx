import { AlertTriangle, Archive, ArchiveRestore, ArrowLeft, Check, Code2, Eye, FileText, FolderOpen, FolderPlus, ImagePlus, LayoutGrid, Loader2, Maximize2, Minimize2, NotebookPen, Palette, PencilLine, Play, Plus, RefreshCw, RotateCcw, Search, Send, Settings, SkipForward, Sparkles, Square, Trash2, Users, Wand2 } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AgentOrb } from './AgentOrb';
import { deriveAgentActivity } from './AgentActivity';
import { drawnPageNames, foundationLanded, remainingScreens, screenLanded, screenPageId, screensToRedraw } from '../design-build';
import { AutopilotPanel, DEFAULT_AUTOPILOT_START } from './AutopilotPanel';
import { GuidePanel, GuideStrip } from './GuidePanel';
import { StudioTeamPanel } from './StudioTeamPanel';
import { NeedsYouBanner } from './NeedsYouBanner';
import { PlanActionEditor } from './PlanActionEditor';
import { AUTOPILOT_ACTIVE, useAutopilotStatus } from './use-autopilot-status';
import { FlowDiagram } from './FlowDiagram';
import { ImageCard } from './ImageAttachment';
import { buildFoundationPrompt, buildPagePrompt, filterScreens, parseFlows, parsePages, screenRows, screenTitleKey, type DesignContext, type DesignPromptMode } from '../flow-diagram';
import { Markdown } from './Markdown';
import {
  ARTIFACT_KINDS,
  ARTIFACT_PATHS,
  directDependencies,
  BOARD_STATUSES,
  explainBlocked,
  machineBlocked,
  interviewGivenAnswers,
  interviewOpenOptions,
  interviewOpenQuestions,
  projectTitleFrom,
  readyCards,
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
  type StudioDesignStatus,
  boardHousekeeping,
  type StudioGuideView,
  type StudioProjectSummary,
  type StudioPlanAction,
  type StudioPlanStage,
  type StudioReadiness,
  type TeamPlanDraft,
  lacksRoute,
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

/** What the Studio chat says while each part of its turn is running. */
const PLAN_STAGE_LABEL: Record<StudioPlanStage, string> = {
  'reading-plan': 'Reading the plan...',
  'reading-design': 'Checking the open-pencil design...',
  'asking-model': 'Asking the model...',
  'extracting-actions': 'The model described the change; turning it into actions...',
  done: 'Done.',
  failed: 'The request failed.',
};

/**
 * Projects whose design build was stopped because the Studio was left while it ran, so the Studio can say so when it
 * is opened again. Held outside the component because the component is gone by the time anyone could read it.
 */
const stoppedByLeaving = new Set<string>();

/**
 * What a step's error looks like when the cause is the connection and not the step: open-pencil restarting (its
 * token is reissued and the editor is unreachable for about twenty seconds), the provider rate-limiting or
 * overloaded, a request timing out. Retried after a wait rather than straight away, because straight away is inside
 * the outage and fails the same way.
 */
const TRANSIENT_STEP_ERROR = /not connected|fetch failed|terminated|unauthori[sz]ed|\b401\b|econn|socket|timed? ?out|did not finish starting|could not be found|network|overloaded|rate.?limit|too many requests|\b429\b|\b50[234]\b/i;
const TRANSIENT_WAITS_MS = [8_000, 20_000, 45_000];

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
export function StudioView({ activeProject, projects: desktopProjects, planRequest, onOpenSettings, onLaunchProject, onPlanForTeam, onLearnCard }: {
  activeProject: ProjectRecord | null;
  projects: ProjectRecord[];
  /** Set by the composer's "Plan in Studio" button: open a fresh plan attached to this project's folder. */
  planRequest?: { projectId: string; nonce: number } | null;
  onOpenSettings: () => void;
  onLaunchProject: (studioProjectId: string, destination: 'composer' | 'editor' | 'generate') => Promise<boolean>;
  onPlanForTeam: (plan: TeamPlanDraft) => void;
  /**
   * Hands one card, and the plan that owns it, to the Learning tutor. The plan is needed as well as the card: the
   * board, the artifacts and the files the card's runs touched all live in that plan's own project folder.
   */
  onLearnCard: (card: BoardCard, studioProjectId: string) => void;
}): ReactNode {
  const [screen, setScreen] = useState<'list' | 'project' | 'new'>('list');
  const [viewedProjectId, setViewedProjectId] = useState<string | null>(null);
  const [draftProjectId, setDraftProjectId] = useState<string | null>(null);
  const [projects, setProjects] = useState<StudioProjectSummary[]>([]);
  const [projectsBusy, setProjectsBusy] = useState(true);
  const [projectsVersion, setProjectsVersion] = useState(0);
  const [detailVersion, setDetailVersion] = useState(0);
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
  const [tab, setTab] = useState<'interview' | 'artifacts' | 'board' | 'design' | 'chat' | 'guide' | 'team'>('interview');
  // How the last design build ended, shown beside the buttons that start it. The page's own banner is at the very top,
  // a long way above the build controls, and a build that stopped there looked like one that had not said anything.
  const [buildOutcome, setBuildOutcome] = useState<string | null>(null);
  // What the last "Sync OpenPencil designs" found, shown beside the button. Its notice used to go to the banner at the
  // top of the page, which is out of sight from the board, so a sync that worked looked like a button that did nothing.
  const [syncOutcome, setSyncOutcome] = useState<string[] | null>(null);
  const [designChatText, setDesignChatText] = useState('');
  const [designChatImage, setDesignChatImage] = useState<{ name: string; dataUrl: string } | null>(null);
  const [designChatMessages, setDesignChatMessages] = useState<Array<{ role: 'user' | 'assistant'; text: string }>>([]);
  // The Studio chat works on the plan, not on the drawing: it explains what a drawn page is or what changed, and
  // answers with a change set the person ticks before anything is written.
  const [planChatText, setPlanChatText] = useState('');
  const [planChatMessages, setPlanChatMessages] = useState<Array<{ role: 'user' | 'assistant'; text: string }>>([]);
  const [planActions, setPlanActions] = useState<StudioPlanAction[] | null>(null);
  const [planSelected, setPlanSelected] = useState<boolean[]>([]);
  const [planDropped, setPlanDropped] = useState(0);
  const [editingAction, setEditingAction] = useState<number | null>(null);
  const [lastPlanRequest, setLastPlanRequest] = useState<string | null>(null);
  // Open-pencil pages the person has said are not product screens. They are not deleted; they stop appearing as
  // "drawn but not planned" in this project.
  const [ignoredDesignPages, setIgnoredDesignPages] = useState<Set<string>>(new Set());
  const [planIntent, setPlanIntent] = useState<'ask' | 'screen' | 'feature'>('feature');
  const [planHydrated, setPlanHydrated] = useState<string | null>(null);
  const [planOutcome, setPlanOutcome] = useState<{ applied: string[]; failed: Array<{ summary: string; reason: string }> } | null>(null);
  // What the board looks like after an applied change set, so the chat can say what to do next and offer the
  // handoff to Autopilot or Code rather than stopping at "applied".
  const [planNext, setPlanNext] = useState<{ ready: number; undrawn: number; unrouted: number; cards: number } | null>(null);
  // What the chat is doing while it waits. The main composer shows a run as it happens; the Studio chat used to
  // show only a disabled button, which read as nothing happening at all.
  const [planPhase, setPlanPhase] = useState<'thinking' | 'applying' | null>(null);
  const [planStage, setPlanStage] = useState<StudioPlanStage>('reading-plan');
  const [planElapsed, setPlanElapsed] = useState(0);
  // Artifacts ticked in the Artifacts tab, for "write only what I chose" rather than the whole set.
  const [selectedKinds, setSelectedKinds] = useState<Set<ArtifactKind>>(new Set());
  const [routeSuggestions, setRouteSuggestions] = useState<import('@kai/contracts').StudioRouteSuggestion[] | null>(null);
  const [routeUnresolved, setRouteUnresolved] = useState<string[]>([]);
  // Where the project is, from the rules — free to read, so it is refreshed whenever the board changes. The
  // explanation inside it is the paid part, and arrives only when the Guide tab asks for it.
  const [guide, setGuide] = useState<StudioGuideView | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [handoffDismissed, setHandoffDismissed] = useState(false);
  const [dropColumn, setDropColumn] = useState<BoardStatus | null>(null);
  const threadEnd = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState<'load' | 'start' | 'answer' | 'enhance' | 'finish' | 'reset' | 'generate' | 'plan' | 'arrange' | 'card' | 'team' | 'work' | 'design' | 'design-build' | 'page-op' | 'archive' | 'delete' | 'folder' | 'launch' | 'link' | 'guide' | 'plan-chat' | null>(null);
  const [useCurrentFolder, setUseCurrentFolder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [design, setDesign] = useState<StudioDesign | null>(null);
  const [designStatus, setDesignStatus] = useState<StudioDesignStatus | null>(null);
  // One automatic pull per change: set when KAI pulls because the editor differs, cleared once they agree again.
  const autoPullTried = useRef(false);
  // What the design-build loop is on right now, shown beside the button; the ref is read inside the loop itself,
  // since reading state there would only ever see the value the loop closed over, not a later click of Stop.
  const [buildingStep, setBuildingStep] = useState<string | null>(null);
  const buildCancelled = useRef(false);
  // The current step's own tool calls, arriving live on the same channel a composer run's events already use —
  // `stepId` is minted before the step starts and carried in the request, so this can filter to just this step.
  const [buildEvents, setBuildEvents] = useState<PersistedEvent[]>([]);
  const buildStepId = useRef<string | null>(null);
  // Set while a whole-design restart runs: it draws into whatever document is open, so that document is the project's
  // now, and a pull must accept it instead of refusing it for sharing no page with the one drawn before.
  const adoptPulls = useRef(false);
  // The last pull was refused because the editor holds a different document; offers "Use this document".
  const [differentDocument, setDifferentDocument] = useState(false);
  const designChatStepId = useRef<string | null>(null);
  // The last composer request acted on, so a re-render does not open the new-project screen twice for one press.
  const handledPlanRequest = useRef<number | null>(null);
  // Identifies the Studio chat turn on screen. Stopping waiting bumps this, so a late answer from the provider is
  // ignored instead of appearing under a message the person already gave up on.
  const planRequestSeq = useRef(0);
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
  // Read by the Design tab's background look, which must not pull while the page is busy or Autopilot holds cards.
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const autopilotActiveRef = useRef(false);
  autopilotActiveRef.current = Boolean(autopilot && AUTOPILOT_ACTIVE.has(autopilot.phase));
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
  }, [projectId, detailVersion]);

  // The board is shared work: an agent, or the other window, can move a card while this screen is open.
  useEffect(() => {
    if (!projectId) return undefined;
    return window.kaiDesktop.onStudioBoardChanged((payload) => {
      if (payload.projectId === projectId) setBoard(payload.board);
    });
  }, [projectId]);

  /**
   * The composer's "Plan in Studio" button lands here. It opens a fresh plan with the open project's folder attached,
   * so the interview and the design read the code that is already there. The nonce is what makes a second press do
   * the same thing again, rather than looking like a request this screen has already handled.
   */
  useEffect(() => {
    if (!planRequest || !activeProject || planRequest.projectId !== activeProject.id) return;
    // Wait for the plan list, so a project that already has a plan reopens it instead of gaining a duplicate.
    if (handledPlanRequest.current === planRequest.nonce || busy !== null || projectsBusy) return;
    handledPlanRequest.current = planRequest.nonce;
    const existing = projects.find((project) => !project.archivedAt && project.linkedProjectId === activeProject.id);
    if (existing) openProjectStudio(existing.id);
    else startNewProject(true);
  }, [planRequest, activeProject, busy, projectsBusy, projects]);

  // The Studio chat's waiting line counts seconds, so a slow provider looks like something running rather than a
  // control that did nothing.
  useEffect(() => {
    if (planPhase !== 'thinking') {
      setPlanElapsed(0);
      return undefined;
    }
    const started = Date.now();
    const timer = setInterval(() => setPlanElapsed(Math.floor((Date.now() - started) / 1000)), 1_000);
    return () => clearInterval(timer);
  }, [planPhase]);

  // The main process reports which part of the chat turn is running. Listening only while one is in flight keeps a
  // late event from changing a thread the person has already moved on from.
  useEffect(() => {
    if (!projectId || planPhase !== 'thinking') return undefined;
    return window.kaiDesktop.onStudioPlanProgress((payload) => {
      if (payload.projectId === projectId) setPlanStage(payload.stage);
    });
  }, [projectId, planPhase]);

  // The conversation belongs to the Studio project, not to whichever tab happens to be open. It is kept per
  // project, bounded, and restored when the project is opened again.
  useEffect(() => {
    setPlanHydrated(null);
    if (!projectId) return;
    try {
      const saved = JSON.parse(localStorage.getItem(`kai.studio.planChat.${projectId}`) ?? 'null') as {
        messages?: Array<{ role: 'user' | 'assistant'; text: string }>;
        actions?: StudioPlanAction[] | null;
        selected?: boolean[];
        intent?: 'ask' | 'screen' | 'feature';
        outcome?: { applied: string[]; failed: Array<{ summary: string; reason: string }> } | null;
        next?: { ready: number; undrawn: number; unrouted: number; cards: number } | null;
        dropped?: number;
        lastRequest?: string | null;
        ignored?: string[];
      } | null;
      setPlanChatMessages(Array.isArray(saved?.messages) ? saved!.messages : []);
      setPlanActions(Array.isArray(saved?.actions) ? saved!.actions : null);
      setPlanSelected(Array.isArray(saved?.selected) ? saved!.selected : []);
      setPlanIntent(saved?.intent === 'ask' || saved?.intent === 'screen' ? saved.intent : 'feature');
      setPlanOutcome(saved?.outcome ?? null);
      setPlanNext(saved?.next ?? null);
      setPlanDropped(typeof saved?.dropped === 'number' ? saved.dropped : 0);
      setLastPlanRequest(typeof saved?.lastRequest === 'string' ? saved.lastRequest : null);
      setIgnoredDesignPages(new Set(Array.isArray(saved?.ignored) ? saved.ignored : []));
    } catch {
      setPlanChatMessages([]);
      setPlanActions(null);
      setPlanSelected([]);
      setPlanOutcome(null);
      setPlanNext(null);
      setPlanDropped(0);
      setLastPlanRequest(null);
      setIgnoredDesignPages(new Set());
    }
    setPlanHydrated(projectId);
  }, [projectId]);

  useEffect(() => {
    if (!projectId || planHydrated !== projectId) return;
    try {
      localStorage.setItem(`kai.studio.planChat.${projectId}`, JSON.stringify({
        messages: planChatMessages.slice(-40),
        actions: planActions,
        selected: planSelected,
        intent: planIntent,
        outcome: planOutcome,
        next: planNext,
        dropped: planDropped,
        lastRequest: lastPlanRequest,
        ignored: [...ignoredDesignPages],
      }));
    } catch {
      // Storage is optional; the conversation still works for this window.
    }
  }, [projectId, planHydrated, planChatMessages, planActions, planSelected, planIntent, planOutcome, planNext, planDropped, lastPlanRequest, ignoredDesignPages]);

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

  function startNewProject(attachCurrentFolder = false): void {
    if (busy !== null) return;
    setError(null);
    setNotice(null);
    setViewedProjectId(null);
    setDraftProjectId(`studio_${crypto.randomUUID()}`);
    setUseCurrentFolder(attachCurrentFolder && Boolean(currentFolder));
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
    // The chat needs the pages inventory too: it is what the "drawn but not planned" rows are compared against.
    if ((tab !== 'design' && tab !== 'chat') || !projectId || state?.status !== 'done') return undefined;
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
    if (conversationId === buildStepId.current || conversationId === designChatStepId.current) setBuildEvents((current) => [...current, event]);
  }), []);

  // While the Design tab is open, look at open-pencil every 15 seconds. The look launches nothing and switches no page.
  // When the editor holds different pages from the last pull — a design restarted or redrawn — pull once, on its own,
  // unless something else is writing to the board. This is what makes a redrawn design get noticed without a button.
  useEffect(() => {
    if (tab !== 'design' || !projectId) return undefined;
    let cancelled = false;
    const look = async (): Promise<void> => {
      if (document.hidden) return;
      let status: StudioDesignStatus;
      try { status = unwrap(await window.kaiDesktop.studioDesignStatus(projectId)); } catch { return; }
      if (cancelled) return;
      setDesignStatus(status);
      if (status.state !== 'running' || status.inSync) { autoPullTried.current = false; return; }
      if (autoPullTried.current || busyRef.current !== null || autopilotActiveRef.current) return;
      autoPullTried.current = true;
      try {
        const pulled = unwrap(await window.kaiDesktop.pullStudioDesign(projectId));
        if (cancelled) return;
        setDifferentDocument(pulled.differentDocument);
        setDesign(pulled.design);
        setBoard(pulled.board);
        if (pulled.differentDocument) setNotice('open-pencil holds a different document from the last pull of this project. Press Use this document if you restarted the design.');
        else setNotice('open-pencil changed, so the design was pulled again and the board updated.');
      } catch { /* The status line already says what is wrong; a failed background pull must not raise an error. */ }
    };
    void look();
    const timer = window.setInterval(() => { void look(); }, 15_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [tab, projectId]);

  const flowJourneys = useMemo(() => (viewing === 'flows' && viewText ? parseFlows(viewText) : []), [viewing, viewText]);
  const designPages = useMemo(() => (pagesText ? parsePages(pagesText) : []), [pagesText]);

  const housekeeping = useMemo(
    () => boardHousekeeping(board?.cards ?? [], pagesText ?? '', design && design.components.length > 0 ? design.components.map((component) => component.id) : null),
    [board, pagesText, design],
  );

  const designRows = useMemo(
    () => screenRows(designPages, design?.components.filter((component) => component.screen).map((component) => component.name) ?? []),
    [designPages, design],
  );
  // Drawn pages the plan does not carry, minus the ones the person has already said are not screens.
  const unplannedDesignRows = useMemo(
    () => designRows.filter((row) => !row.inPages && row.drawn && !ignoredDesignPages.has(screenTitleKey(row.name))),
    [designRows, ignoredDesignPages],
  );

  /**
   * What is wrong with the proposed set, checked against the plan as it stands. These are warnings, not refusals:
   * an action that already exists is reused, a missing dependency is ignored, and the person can still apply.
   */
  const planWarnings = useMemo(() => {
    const warnings = new Map<number, Array<{ code: string; message: string }>>();
    if (!planActions) return warnings;
    const pageKeys = new Set(designPages.map((page) => screenTitleKey(page.name)));
    const cards = board?.cards ?? [];
    const cardsByKey = new Map(cards.map((card) => [screenTitleKey(card.title), card]));
    const proposedAdds = planActions.flatMap((action, index) => (action.kind === 'add' ? [{ action, index }] : []));
    const proposedKeys = new Set(proposedAdds.map((entry) => screenTitleKey(entry.action.title)));
    const routeOwners = new Map<string, string>();
    for (const card of cards) if (card.route.trim()) routeOwners.set(card.route.trim(), card.title);
    for (const entry of proposedAdds) if (entry.action.route.trim()) routeOwners.set(entry.action.route.trim(), entry.action.title);
    const drawn = new Set((design?.components ?? []).filter((component) => component.screen).map((component) => screenTitleKey(component.name)));

    planActions.forEach((action, index) => {
      const found: Array<{ code: string; message: string }> = [];
      if (action.kind === 'add') {
        const key = screenTitleKey(action.title);
        if (pageKeys.has(key) || cardsByKey.has(key)) {
          found.push({ code: 'exists', message: `"${action.title}" already exists. Applying this reuses it rather than creating a second.` });
        }
        if (action.route.trim()) {
          const owner = routeOwners.get(action.route.trim());
          if (owner && owner !== action.title) found.push({ code: 'route', message: `Route ${action.route} is already used by "${owner}".` });
        } else if (action.cardKind === 'page') {
          found.push({ code: 'no-route', message: 'This page has no route, so the screen check cannot open it.' });
        }
        for (const dependency of action.dependsOn) {
          const dependencyKey = screenTitleKey(dependency);
          if (!cardsByKey.has(dependencyKey) && !proposedKeys.has(dependencyKey)) {
            found.push({ code: `dep-${dependency}`, message: `No card called "${dependency}" exists, so that dependency will be ignored.` });
          }
        }
        if (action.designName && !drawn.has(screenTitleKey(action.designName))) {
          found.push({ code: 'design', message: `No drawn OpenPencil page called "${action.designName}" was found in the last pull.` });
        }
      }
      if (action.kind === 'link') {
        if (!drawn.has(screenTitleKey(action.designName))) found.push({ code: 'design', message: 'That drawn page is not in the last pull. Pull the design, then try again.' });
        if (!pageKeys.has(screenTitleKey(action.screenName)) && !cardsByKey.has(screenTitleKey(action.screenName))) {
          found.push({ code: 'screen', message: 'The plan has no screen with that name.' });
        }
      }
      if (action.kind === 'route' && !cardsByKey.has(screenTitleKey(action.screenName)) && !pageKeys.has(screenTitleKey(action.screenName))) {
        found.push({ code: 'screen', message: 'The plan has no screen with that name.' });
      }
      if (action.kind === 'remove' && !cardsByKey.has(screenTitleKey(action.screenName)) && !pageKeys.has(screenTitleKey(action.screenName))) {
        found.push({ code: 'screen', message: 'The plan has no screen with that name.' });
      }
      if (found.length > 0) warnings.set(index, found);
    });
    return warnings;
  }, [planActions, designPages, board, design]);

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
  async function refreshDesign(adopt = adoptPulls.current): Promise<{ design: StudioDesign; board: StudioBoard; changed: string[]; tokensChanged: boolean; tokenCount: number; tokensPreserved: boolean; differentDocument: boolean; artifacts: StudioArtifacts }> {
    const pulled = unwrap(await window.kaiDesktop.pullStudioDesign(projectId!, adopt));
    setDifferentDocument(pulled.differentDocument);
    setDesign(pulled.design);
    setBoard(pulled.board);
    const artifacts = unwrap(await window.kaiDesktop.studioArtifacts(projectId!));
    setArtifacts(artifacts);
    // Returned as well as set: a build that just regenerated an artifact must build its next prompt from the new one,
    // and reading it back out of state would give it the catalog as it looked before the regeneration.
    return { ...pulled, artifacts };
  }

  /** A pull of another document was refused, so it holds nothing of this project's. The build judges every step by
   * reading the design back, and judging against the record from before — which is what a refused pull hands back —
   * would call a screen that is really there "not drawn" and retry it for ever. */
  function requireSameDocument(pull: { differentDocument: boolean }): void {
    if (pull.differentDocument) {
      throw new Error('open-pencil is open on a different document from the one this project was drawn in, so the build stopped instead of judging screens against it. Open this project\'s document, then press Resume.');
    }
  }

  /**
   * Accepts the document open-pencil holds as this project's, after a pull refused it for sharing no page with the
   * one drawn before. This is what a design restarted from scratch looks like. Cards whose screen is not in the new
   * document are flagged to be drawn again, and the ones that match by name are linked to the new pages.
   */
  async function useThisDocument(): Promise<void> {
    if (!projectId || busy !== null) return;
    const confirmed = await confirmDialog({
      title: 'Use the document open in open-pencil?',
      detail: 'Its pages replace the ones this project was drawn from. Cards whose screen is in it are linked to the new pages; cards whose screen is not are marked to draw again. Nothing in open-pencil changes.',
      confirmLabel: 'Use this document',
      destructive: false,
    });
    if (!confirmed) return;
    setBusy('design'); setError(null);
    try {
      const pulled = await refreshDesign(true);
      setNotice(`Now using the open-pencil document: ${pulled.design.components.filter((component) => component.screen).length} pages read, ${pulled.tokenCount} tokens.`);
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
      const pulled = await refreshDesign();
      setNotice(
        // Said first of all: the editor is on another project's file, so none of this belongs to this project.
        pulled.differentDocument
          ? 'The editor is open on a different document, so nothing was pulled into this project. Its pages share no id, and not enough names, with the ones this project was drawn from. Open the document this project belongs to and pull again, or press Use this document if you restarted the design.'
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
  async function runBuildStepWithRetry(
    name: string,
    prompt: string,
    landed?: (pull: Awaited<ReturnType<typeof refreshDesign>>) => boolean,
  ): Promise<{ status: 'completed' | 'failed'; output: string; error?: string }> {
    // A turn can end in an error after it has done the work — cut off at the last step, a provider error while it
    // checked its own drawing. Reading the design back before doing anything else is what tells that apart from a
    // turn that drew nothing: a screen that is there is kept, not drawn over a second time. `landed` is given only
    // where "it exists now" proves the step worked, which is a plain draw and not a redraw of what was already there.
    const keptIfDrawn = async (failed: { status: 'completed' | 'failed'; output: string; error?: string }): Promise<{ status: 'completed' | 'failed'; output: string; error?: string }> => {
      if (!landed || failed.status !== 'failed') return failed;
      const pull = await refreshDesign().catch(() => null);
      if (!pull || !landed(pull)) return failed;
      setNotice(`"${name}" ended with an error (${failed.error || 'no reason given'}), but it is in open-pencil, so it was kept.`);
      return { ...failed, status: 'completed' };
    };
    let latest = await keptIfDrawn(await runBuildStep(name, prompt));
    // Any failure is tried again once straight away; one that looks like the connection is waited out, up to three
    // times, which is longer than the editor takes to come back.
    for (let attempt = 0; latest.status === 'failed'; attempt += 1) {
      const transient = TRANSIENT_STEP_ERROR.test(latest.error ?? '');
      if (attempt >= (transient ? TRANSIENT_WAITS_MS.length : 1) || buildCancelled.current) break;
      const wait = transient ? TRANSIENT_WAITS_MS[attempt]! : 0;
      announceBuild(`"${name}" failed (${latest.error || 'the turn ended with an error and gave no reason'}). ${wait > 0 ? `Waiting ${wait / 1000}s and trying again (${attempt + 1} of ${TRANSIENT_WAITS_MS.length}).` : 'Retrying once.'}`);
      if (wait > 0) await new Promise<void>((resolve) => { setTimeout(resolve, wait); });
      if (buildCancelled.current) break;
      latest = await keptIfDrawn(await runBuildStep(name, prompt));
    }
    return latest;
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
    adoptPulls.current = action?.kind === 'redraw' && action.target === 'all';
    setBusy('design-build');
    setError(null);
    setNotice(null);
    setBuildOutcome(null);
    setLastFailedStep(null);
    setBuildCostUsd(0);
    buildCostRef.current = 0;
    let drawn = 0;
    const mode: DesignPromptMode = action?.kind === 'clean' ? 'clean' : 'redraw';
    // A screen that fails verification says what open-pencil holds instead, so a name that does not match is visible
    // rather than guessed at.
    const namesInPencil = (pull: Parameters<typeof drawnPageNames>[0]): string => drawnPageNames(pull).join(', ') || 'no pages';
    try {
      let pulled = await refreshDesign(); requireSameDocument(pulled);
      if (!foundationDone || (action?.kind === 'redraw' && action.target === 'all')) {
        const result = await runBuildStepWithRetry('Foundation', promptFor('Foundation', 'draw', pulled.artifacts), foundationDone ? undefined : foundationLanded);
        if (result.status === 'failed') { setLastFailedStep('Foundation'); throw new Error(`Foundation: ${result.error || 'the step failed.'}`); }
        pulled = await refreshDesign(); requireSameDocument(pulled);
        if (!foundationLanded(pulled)) {
          setLastFailedStep('Foundation');
          throw new Error(`Foundation: the turn finished, but open-pencil has no variables and no components of its own. ${describeTurn(result)}`);
        }
        toggleFoundation(true);
      }
      if (action) {
        const queue = screensToRedraw(pagesText, pulled, action.target === 'all' ? undefined : action.target);
        if (queue.length === 0) { announceBuild('There is nothing to redraw: the pages list names no screens yet.'); return; }
        for (const target of queue) {
          if (buildCancelled.current) {
            announceBuild(`Stopped with ${queue.length - drawn} screen${queue.length - drawn === 1 ? '' : 's'} still to redraw.`);
            return;
          }
          const result = await runBuildStepWithRetry(target.name, promptFor(target.name, mode, pulled.artifacts));
          if (result.status === 'failed') { setLastFailedStep(target.name); throw new Error(`${target.name}: ${result.error || 'the step failed.'}`); }
          pulled = await refreshDesign(); requireSameDocument(pulled);
          if (!screenLanded(target.name, pulled)) {
            setLastFailedStep(target.name);
            throw new Error(`"${target.name}": the ${mode === 'clean' ? 'cleanup' : 'redraw'} finished, but open-pencil has no page named like it. It has: ${namesInPencil(pulled)}. ${describeTurn(result)}`);
          }
          drawn += 1;
        }
        announceBuild(`${mode === 'clean' ? 'Fixed and redrew' : 'Redrew'} ${drawn} screen${drawn === 1 ? '' : 's'} in open-pencil${buildCostRef.current > 0 ? `, ~$${buildCostRef.current.toFixed(2)} spent` : ''}.`);
        clearStyleChanged();
        return;
      }
      // Recomputed from the pull each time round, so a screen drawn by an earlier step — or by hand, while this was
      // running — is never asked for twice. A skipped screen is left out, so it never blocks the rest.
      for (;;) {
        const remaining = remainingScreens(pagesText, pulled).filter((row) => !skipped.has(screenTitleKey(row.name)));
        if (remaining.length === 0) break;
        if (buildCancelled.current) {
          announceBuild(`Stopped with ${remaining.length} screen${remaining.length === 1 ? '' : 's'} still to draw. Everything already drawn is kept; press Resume to carry on from here.`);
          return;
        }
        const row = remaining[0]!;
        const result = await runBuildStepWithRetry(row.name, promptFor(row.name, 'draw', pulled.artifacts), (pull) => screenLanded(row.name, pull));
        if (result.status === 'failed') { setLastFailedStep(row.name); throw new Error(`${row.name}: ${result.error || 'the step failed.'}`); }
        pulled = await refreshDesign(); requireSameDocument(pulled);
        if (!screenLanded(row.name, pulled)) {
          setLastFailedStep(row.name);
          throw new Error(`"${row.name}": the turn finished, but open-pencil has no page named like it. It has: ${namesInPencil(pulled)}. ${describeTurn(result)}`);
        }
        drawn += 1;
      }
      announceBuild(`Design build finished: ${drawn} screen${drawn === 1 ? '' : 's'} drawn and confirmed in open-pencil${buildCostRef.current > 0 ? `, ~$${buildCostRef.current.toFixed(2)} spent` : ''}.`);
    } catch (caught) {
      setError(messageOf(caught));
      setBuildOutcome(`Stopped: ${messageOf(caught)}`);
    } finally {
      adoptPulls.current = false;
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
      title: 'Restart the whole design?',
      detail: `The foundation and every screen in the pages list are drawn from the start in open-pencil, each as its own paid model call. ${drawnCount === 0 ? 'Nothing is drawn yet, so nothing is replaced.' : `${drawnCount} screen${drawnCount === 1 ? '' : 's'} now drawn will be replaced.`} Nothing in .kai/spec changes, and Stop still works.`,
      confirmLabel: 'Restart all',
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
    if (projectId) stoppedByLeaving.add(projectId);
    buildCancelled.current = true;
    void window.kaiDesktop.cancelStudioDesignStep(projectId ?? '', buildStepId.current).catch(() => undefined);
  }, [projectId]);

  // Coming back to a Studio whose build was stopped by leaving it: say so, so it does not look like it quietly gave up.
  useEffect(() => {
    if (!projectId || !stoppedByLeaving.delete(projectId)) return;
    const text = 'The design build was stopped when you left the Studio. Everything already drawn is kept; Resume carries on from the first screen still missing.';
    setNotice(text);
    setBuildOutcome(text);
  }, [projectId]);

  /** Says how a design build ended, in the page banner and beside the build buttons. */
  function announceBuild(text: string): void {
    setNotice(text);
    setBuildOutcome(text);
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

  async function rememberBlockedApproach(card: BoardCard): Promise<void> {
    if (!projectId) return;
    const approach = await promptDialog({
      title: `Remember an approach for “${card.title}”`,
      label: 'When a similar blocker appears, tell Autopilot what approach it should try first.',
      placeholder: 'For example: use the existing mock provider in tests; do not wait for production credentials.',
      multiline: true,
      rows: 4,
      confirmLabel: 'Remember approach',
      validate: (value) => value.trim() ? null : 'Describe the approach or cancel.',
    });
    if (!approach?.trim()) return;
    setBusy('card');
    setError(null);
    try {
      const current = unwrap(await window.kaiDesktop.studioArtifactText({ projectId, kind: 'decisions' })) ?? '';
      const entry = `\n\n## Approved approach for similar blockers\n\n- Card context: ${card.title}\n- Blocker: ${card.notes.slice(0, 700)}\n- Approach: ${approach.trim().slice(0, 1_500)}\n`;
      setArtifacts(unwrap(await window.kaiDesktop.saveStudioArtifact({ projectId, kind: 'decisions', content: `${current.trimEnd()}${entry}`.trimStart() })));
      setNotice('Saved to the project decision log. Future Autopilot cards will see it when the situation matches.');
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
    // Switching to the board did nothing for a person already on it, which is where this button is shown. It matches the
    // routes it can from the design and the project and lists what is left to confirm, as the toolbar button does.
    if (action === 'repair-routes') { setTab('board'); await suggestRoutes(); return; }
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

  /** Pulls the currently open Pencil document and reports how many project screens now match its pages. */
  async function reconcileDesignPages(): Promise<void> {
    if (!projectId) return;
    setBusy('design'); setError(null);
    try {
      const result = await refreshDesign();
      if (result.differentDocument) {
        setNotice('The current Open Pencil document does not match this project’s previously pulled document. No pages were reconciled.');
      } else {
        const drawnCount = designRows.filter((row) => row.inPages && screenLanded(row.name, result)).length;
        setNotice(`Reconciled the current Open Pencil document: ${drawnCount} of ${designRows.filter((row) => row.inPages).length} planned screens now match and are marked drawn.`);
      }
    } catch (caught) { setError(messageOf(caught)); }
    finally { setBusy(null); }
  }

  async function syncDesignFromBoard(): Promise<void> {
    if (!projectId) return;
    setBusy('design'); setError(null); setSyncOutcome(null);
    // Which cards were linked to a design before, so the result can say what this sync added and not only what exists.
    const linkedBefore = new Set((board?.cards ?? []).filter((card) => card.designRef).map((card) => card.id));
    try {
      const pulled = await refreshDesign();
      if (pulled.differentDocument) {
        const text = 'The open-pencil document belongs to another project, so no board cards were reconciled.';
        setNotice(text);
        setSyncOutcome([text]);
        return;
      }
      const planned = designRows.filter((row) => row.inPages);
      const notDrawn = planned.filter((row) => !screenLanded(row.name, pulled)).map((row) => row.name);
      const linked = pulled.board.cards.filter((card) => card.designRef);
      const newlyLinked = linked.filter((card) => !linkedBefore.has(card.id));
      const stale = pulled.board.cards.filter((card) => card.stale);
      const lines = [
        `${planned.length - notDrawn.length} of ${planned.length} planned screens are drawn in OpenPencil.`,
        `${linked.length} board card${linked.length === 1 ? ' is' : 's are'} linked to a design${newlyLinked.length > 0 ? `, ${newlyLinked.length} of them new in this sync` : ' (none new in this sync)'}. Linked cards show "Drawn in OpenPencil".`,
        stale.length > 0 ? `${stale.length} card${stale.length === 1 ? ' is' : 's are'} marked for rebuilding because their design changed.` : 'No card is marked for rebuilding.',
        notDrawn.length > 0
          ? `Not drawn yet: ${notDrawn.slice(0, 5).join(', ')}${notDrawn.length > 5 ? ` and ${notDrawn.length - 5} more` : ''}.`
          : 'Every planned screen is drawn.',
      ];
      setSyncOutcome(lines);
      setNotice(lines[0]!);
    } catch (caught) {
      const text = messageOf(caught);
      setError(text);
      setSyncOutcome([`The sync failed: ${text}`]);
    } finally { setBusy(null); }
  }

  async function suggestRoutes(): Promise<void> {
    if (!projectId) return;
    setBusy('card'); setError(null); setRouteSuggestions(null);
    try {
      const result = unwrap(await window.kaiDesktop.suggestStudioRouteRepairs(projectId));
      // Route repair also reconciles explicit routes from the pulled design. Refresh here so that work is visible
      // immediately, including cases where the provider cannot suggest anything further.
      const updated = unwrap(await window.kaiDesktop.studioBoard(projectId));
      const stillMissing = new Set(updated.cards.filter(lacksRoute).map((card) => card.id));
      const suggestions = result.suggestions.filter((item) => stillMissing.has(item.cardId));
      const unresolved = updated.cards.filter((card) => stillMissing.has(card.id)).map((card) => card.id);
      setBoard(updated);
      setRouteSuggestions(suggestions); setRouteUnresolved(unresolved);
      setNotice(result.suggestions.length
        ? `Found ${suggestions.length} route suggestion${suggestions.length === 1 ? '' : 's'} to review${unresolved.length ? `; ${unresolved.length} screen${unresolved.length === 1 ? '' : 's'} still need a route` : ''}.`
        : `No additional routes could be matched from the available evidence${unresolved.length ? `; ${unresolved.length} screen${unresolved.length === 1 ? '' : 's'} still need a route` : ''}.`);
    } catch (caught) { setError(messageOf(caught)); }
    finally { setBusy(null); }
  }

  async function markNotAScreen(cardId: string): Promise<void> {
    if (!projectId) return;
    setBusy('card'); setError(null);
    try {
      await window.kaiDesktop.setStudioCardRoute({ projectId, cardId, route: '', notAScreen: true }).then(unwrap);
      const updated = unwrap(await window.kaiDesktop.studioBoard(projectId));
      setBoard(updated);
      setRouteUnresolved((current) => current.filter((id) => id !== cardId));
      setNotice('Marked as not a screen: it needs no route and no screen check.');
    } catch (caught) { setError(messageOf(caught)); }
    finally { setBusy(null); }
  }

  async function applyRouteSuggestions(): Promise<void> {
    if (!projectId || !routeSuggestions?.length) return;
    setBusy('card'); setError(null);
    try {
      const applied = routeSuggestions.length;
      for (const suggestion of routeSuggestions) await window.kaiDesktop.setStudioCardRoute({ projectId, cardId: suggestion.cardId, route: suggestion.route }).then(unwrap);
      const updated = unwrap(await window.kaiDesktop.studioBoard(projectId));
      const unresolved = updated.cards.filter(lacksRoute).map((card) => card.id);
      setBoard(updated);
      setRouteSuggestions([]);
      setRouteUnresolved(unresolved);
      setNotice(unresolved.length
        ? `Saved ${applied} route${applied === 1 ? '' : 's'}. ${unresolved.length} screen${unresolved.length === 1 ? '' : 's'} still need a route before Autopilot can check every screen.`
        : 'All screen routes are set. The board is ready to retry those screen checks.');
    } catch (caught) { setError(messageOf(caught)); }
    finally { setBusy(null); }
  }

  async function sendDesignChat(): Promise<void> {
    if (!projectId || (!designChatText.trim() && !designChatImage)) return;
    const message = designChatText.trim() || `Please inspect this screenshot and reconcile it with the existing project design.`;
    const imageDataUrl = designChatImage?.dataUrl;
    const stepId = `studio-design-chat-${crypto.randomUUID()}`;
    designChatStepId.current = stepId;
    setDesignChatMessages((items) => [...items, { role: 'user', text: `${message}${designChatImage ? ` [Screenshot: ${designChatImage.name}]` : ''}` }]);
    setDesignChatText(''); setDesignChatImage(null); setBusy('design'); setError(null); setBuildEvents([]);
    try {
      const response = unwrap(await window.kaiDesktop.chatWithStudioDesign({ projectId, message, ...(imageDataUrl ? { imageDataUrl } : {}), stepId }));
      const text = response.status === 'completed' ? response.output : response.error ?? response.output ?? 'The design turn failed.';
      setDesignChatMessages((items) => [...items, { role: 'assistant', text }]);
      if (response.status === 'completed') {
        try {
          const pulled = await refreshDesign();
          setNotice(pulled.differentDocument ? 'The Open Pencil page could not be reconciled because the editor is showing another document.' : 'Design chat finished; the design and board records have been refreshed.');
        } catch { setNotice('Design chat finished. Pull the design to update the board records.'); }
      }
    } catch (caught) { const text = messageOf(caught); setError(text); setDesignChatMessages((items) => [...items, { role: 'assistant', text }]); }
    finally { designChatStepId.current = null; setBusy(null); }
  }

  async function selectDesignChatImage(file: File | undefined): Promise<void> {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { setError('Attach a PNG, JPEG or WebP screenshot.'); return; }
    const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error(`Could not read ${file.name}.`)); reader.readAsDataURL(file); });
    setDesignChatImage({ name: file.name, dataUrl });
  }

  function toggleSelectedKind(kind: ArtifactKind): void {
    setSelectedKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind); else next.add(kind);
      return next;
    });
  }

  /** Everything not written yet, plus everything that went stale: the set "Generate selected" was made for. */
  function selectMissingKinds(): void {
    const missing = ARTIFACT_KINDS.filter((kind) => kind !== 'brief' && (() => {
      const entry = artifacts?.artifacts.find((item) => item.kind === kind);
      return !entry || entry.stale;
    })());
    setSelectedKinds(new Set(missing));
  }

  /** The design-only preset: the three artifacts the design layer actually reads, and nothing upstream of them. */
  function selectDesignKinds(): void {
    setSelectedKinds(new Set<ArtifactKind>(['style-guide', 'tokens', 'pages']));
  }

  async function generateSelectedKinds(): Promise<void> {
    if (!projectId || selectedKinds.size === 0 || busy !== null) return;
    const kinds = [...selectedKinds];
    setBusy('generate');
    setError(null);
    setNotice(null);
    try {
      const result = unwrap(await window.kaiDesktop.generateStudioArtifactsSelected({ projectId, kinds }));
      setArtifacts(result.artifacts);
      if (kinds.includes('pages')) setPagesText(unwrap(await window.kaiDesktop.studioArtifactText({ projectId, kind: 'pages' })));
      setSelectedKinds(new Set());
      if (result.failed.length > 0) {
        setError(`Could not write ${result.failed.map((entry) => `${entry.kind} (${entry.reason})`).join(', ')}.`);
      } else {
        setNotice(`Wrote ${result.wrote.length} artifact${result.wrote.length === 1 ? '' : 's'}: ${result.wrote.join(', ')}.`);
      }
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  function togglePlanAction(index: number): void {
    setPlanSelected((current) => current.map((value, at) => (at === index ? !value : value)));
  }

  /** One proposal, corrected in place. The edited action is what the apply call sends. */
  function replacePlanAction(index: number, next: StudioPlanAction): void {
    setPlanActions((current) => (current ? current.map((action, at) => (at === index ? next : action)) : current));
  }

  async function sendPlanChat(override?: string): Promise<void> {
    if (!projectId || busy !== null) return;
    const message = (override ?? planChatText).trim();
    if (!message) return;
    const requestId = ++planRequestSeq.current;
    setLastPlanRequest(message);
    setPlanChatMessages((items) => [...items, { role: 'user', text: message }]);
    setPlanChatText('');
    setPlanActions(null);
    setEditingAction(null);
    setPlanSelected([]);
    setPlanOutcome(null);
    setPlanNext(null);
    setPlanDropped(0);
    setBusy('plan-chat');
    setPlanPhase('thinking');
    setPlanStage('reading-plan');
    setError(null);
    try {
      const result = unwrap(await window.kaiDesktop.chatWithStudioPlan({ projectId, message, intent: planIntent }));
      if (planRequestSeq.current !== requestId) return;
      setPlanChatMessages((items) => [...items, { role: 'assistant', text: result.reply }]);
      setPlanActions(result.actions);
      setPlanSelected(result.actions.map(() => true));
      setPlanDropped(result.dropped);
    } catch (caught) {
      if (planRequestSeq.current !== requestId) return;
      const text = messageOf(caught);
      setError(text);
      setPlanChatMessages((items) => [...items, { role: 'assistant', text }]);
    } finally {
      // A newer turn, or Stop waiting, owns the state now; a late answer must not clear its spinner.
      if (planRequestSeq.current === requestId) {
        setPlanPhase(null);
        setBusy(null);
      }
    }
  }

  /**
   * The composer has Stop; the Studio chat needs the same way out. The provider request cannot be cancelled from
   * here, so this stops waiting for it and ignores whatever arrives later.
   */
  function stopPlanChat(): void {
    planRequestSeq.current += 1;
    setPlanPhase(null);
    setBusy(null);
    setPlanChatMessages((items) => [...items, {
      role: 'assistant',
      text: 'Stopped waiting. The request may still finish in the background; ask again if you want a fresh change set.',
    }]);
  }

  async function applyPlanChanges(startAutopilotAfter = false): Promise<void> {
    if (!projectId || !planActions || busy !== null) return;
    const chosen = planActions.filter((_, index) => planSelected[index]);
    if (chosen.length === 0) return;
    let readyCount = 0;
    setBusy('plan-chat');
    setPlanPhase('applying');
    setError(null);
    try {
      const result = unwrap(await window.kaiDesktop.applyStudioPlanChanges({ projectId, actions: chosen }));
      setBoard(result.board);
      setArtifacts(result.artifacts);
      setDesign(result.design);
      setPagesText(result.pages);
      setPlanOutcome({ applied: result.applied, failed: result.failed });
      const pageList = parsePages(result.pages);
      const drawnKeys = new Set(result.design.components.filter((component) => component.screen).map((component) => screenTitleKey(component.name)));
      const undrawn = pageList.filter((page) => !drawnKeys.has(screenTitleKey(page.name))).length;
      const unrouted = result.board.cards.filter((card) => (card.kind === 'page' || card.kind === 'component') && !card.route.trim()).length;
      readyCount = readyCards(result.board).length;
      setPlanNext({ ready: readyCount, undrawn, unrouted, cards: result.board.cards.length });
      setPlanActions(null);
      setEditingAction(null);
      setPlanSelected([]);
      const summary = [
        ...result.applied.map((line) => `Applied: ${line}`),
        ...result.failed.map((entry) => `Not applied: ${entry.summary} (${entry.reason})`),
      ].join('\n');
      setPlanChatMessages((items) => [...items, { role: 'assistant', text: summary || 'Nothing changed.' }]);
      if (result.failed.length > 0) setError(`${result.failed.length} change${result.failed.length === 1 ? '' : 's'} could not be applied.`);
      else setNotice(`Applied ${result.applied.length} change${result.applied.length === 1 ? '' : 's'}.`);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setPlanPhase(null);
      setBusy(null);
    }
    // Applied and then started, in that order. The finally above has already released the busy state, which is what
    // the Autopilot start checks before it will run.
    if (startAutopilotAfter && readyCount > 0) await startPlanAutopilot();
  }

  /** The second line under a proposed action: what it will actually touch. */
  function planActionDetail(action: StudioPlanAction): string {
    switch (action.kind) {
      case 'add': {
        const parts = [
          action.cardKind,
          action.route ? `route ${action.route}` : '',
          action.dependsOn.length > 0 ? `after ${action.dependsOn.join(', ')}` : '',
        ];
        return parts.filter(Boolean).join(' · ');
      }
      case 'story':
        return action.acceptance.length > 0
          ? `${action.acceptance.length} acceptance check${action.acceptance.length === 1 ? '' : 's'}`
          : 'Adds the feature story';
      case 'generate':
        return `Writes ${action.artifacts.join(', ')}`;
      case 'link':
        return `${action.designName} becomes ${action.screenName}`;
      case 'remove':
        return action.deletePage ? `${action.screenName} and its drawing` : action.screenName;
      case 'route':
        return `${action.screenName} at ${action.route}`;
    }
  }

  /** Hands the applied feature to Autopilot with the same defaults the Autopilot panel's own Start button uses. */
  async function startPlanAutopilot(): Promise<void> {
    if (!projectId || busy !== null) return;
    setBusy('guide');
    setError(null);
    try {
      await window.kaiDesktop.startAutopilot({ projectId, ...DEFAULT_AUTOPILOT_START }).then(unwrap);
      setNotice('Autopilot started with the panel’s default settings. Open the Board tab to watch it.');
      setTab('board');
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  /** A drawn page that is a component page or a working artboard, not a product screen. Kept in open-pencil. */
  function ignoreDesignPage(name: string): void {
    setIgnoredDesignPages((current) => new Set(current).add(screenTitleKey(name)));
  }

  /**
   * The direct question for a drawn page the plan does not know about. "Link" asks which planned screen it is, then
   * the agent proposes the rename on both sides; "new" and "remove" say the rest in the person's own words.
   */
  async function explainDrawnPage(name: string, mode: 'link' | 'add' | 'remove'): Promise<void> {
    if (mode === 'link') {
      const target = await promptDialog({
        title: `Link "${name}" to a planned screen`,
        label: 'Planned screen name',
        initialValue: '',
        confirmLabel: 'Ask Studio to link them',
        validate: (value) => (value.trim() ? null : 'Name the screen in the plan.'),
      });
      if (target === null || !target.trim()) return;
      await sendPlanChat(`The page "${name}" drawn in OpenPencil is the planned screen "${target.trim()}". Link them, renaming the drawn page so the names match.`);
      return;
    }
    if (mode === 'add') {
      await sendPlanChat(`The page "${name}" I drew in OpenPencil is a new screen. Add it to the plan and the board.`);
      return;
    }
    await sendPlanChat(`The page "${name}" is not needed. Remove it from the plan and the board, but keep the drawing.`);
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
                <button type="button" className="primary-button" onClick={() => startNewProject()}>
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
                          <div className="studio-project-action-row">
                            <button type="button" className="primary-button" onClick={() => void launchProject(project.id, 'composer')} disabled={busy !== null}>
                              {busy === 'launch' ? <Loader2 className="spin" size={14} /> : <Send size={14} />}
                              <span>Start on composer</span>
                            </button>
                            <button type="button" className="secondary-button" onClick={() => void launchProject(project.id, 'generate')} disabled={busy !== null}>
                              <Play size={14} />
                              <span>Start generating</span>
                            </button>
                          </div>
                          <div className="studio-project-action-row">
                            <button type="button" className="secondary-button" onClick={() => void launchProject(project.id, 'editor')} disabled={busy !== null}>
                              <Code2 size={14} />
                              <span>Open in code editor</span>
                            </button>
                            {!project.linkedProjectId ? (
                              <button type="button" className="secondary-button" onClick={() => void chooseProjectFolder(project.id)} disabled={busy !== null}>
                                {busy === 'folder' ? <Loader2 className="spin" size={14} /> : <FolderPlus size={14} />}
                                <span>Create folder</span>
                              </button>
                            ) : <span aria-hidden="true" />}
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="studio-project-action-row">
                            <button type="button" className="primary-button" onClick={() => openProjectStudio(project.id)} disabled={busy !== null}>
                              <Play size={14} />
                              <span>Open Studio</span>
                            </button>
                          </div>
                          <div className="studio-project-action-row" aria-hidden="true" />
                        </>
                      )}
                      <div className="studio-project-action-tools">
                        {!project.archivedAt && project.status === 'done' && (
                          <button type="button" className="icon-button" onClick={() => openProjectStudio(project.id)} disabled={busy !== null} title={`Open Studio for ${project.title}`} aria-label={`Open Studio for ${project.title}`}>
                            <LayoutGrid size={15} />
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
                  <button type="button" className="primary-button" onClick={() => startNewProject()}>
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
            <span className="studio-project-label">{screen === 'new' ? 'New project' : busy === 'load' ? 'Loading project' : error && !state ? 'Project unavailable' : state?.status === 'done' ? 'Brief ready' : 'In discussion'}</span>
            <strong title={projectTitle}>{projectTitle}</strong>
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

      {error && <p className="studio-notice error" role="alert"><AlertTriangle size={14} /><span>{error}</span>{screen === 'project' && <button type="button" className="secondary-button" onClick={() => { setError(null); setDetailVersion((version) => version + 1); }}>Retry</button>}</p>}
      {notice && <p className="studio-notice" role="status"><Check size={14} /> {notice}</p>}
      {/* The Studio keeps its own project, apart from the one in the top bar, and nothing said so: a person on one
          project saw another's brief, style guide and drawing run. Say it whenever the two names disagree. */}
      {screen === 'project' && currentFolder && state && state.linkedProjectId !== currentFolder.id && (
        <p className="studio-notice warning" role="status">
          <AlertTriangle size={14} />
          <span>
            This Studio project is <strong>{projectTitle.split(/[,.:—-]/)[0]?.trim()}</strong>
            {state.linkedProjectId
              ? <> and writes to <strong>{desktopProjects.find((project) => project.id === state.linkedProjectId)?.name ?? 'another folder'}</strong></>
              : ' and lives in the Studio workspace'}
            , not the open project <strong>{currentFolder.name}</strong>. Everything written or drawn here is for the Studio project.
          </span>
          <button type="button" className="composer-text-button" onClick={leaveProjectStudio} disabled={busy !== null}>Choose another project</button>
        </p>
      )}
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
            ['chat', 'Studio chat'],
            ['guide', 'Senior dev'],
            ['team', 'Team'],
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
              <button type="button" className="secondary-button" onClick={selectMissingKinds} disabled={busy !== null || !artifacts} title="Tick every artifact that is missing or stale">
                Select missing &amp; stale
              </button>
              <button type="button" className="secondary-button" onClick={selectDesignKinds} disabled={busy !== null} title="Tick the style guide, tokens and pages: the design layer, without the PRD and stories">
                Design only
              </button>
              <button type="button" className="primary-button" onClick={() => void generateSelectedKinds()} disabled={busy !== null || !readiness?.ready || selectedKinds.size === 0} title="Write only the ticked artifacts, in dependency order">
                {busy === 'generate' ? <Loader2 className="spin" size={14} /> : <Wand2 size={14} />} Generate selected ({selectedKinds.size})
              </button>
              {staleCount > 0 && <span className="studio-model">{staleCount} stale</span>}
            </div>
            {busy === 'generate' && progress && <GenerationProgress progress={progress} />}
            <ul className="studio-artifacts">
              {ARTIFACT_KINDS.map((kind) => {
                const entry = artifacts?.artifacts.find((item) => item.kind === kind);
                return (
                  <li key={kind} className={[entry?.stale ? 'stale' : '', progress?.current === kind && busy === 'generate' ? 'writing' : '', progress?.failed[kind] ? 'failed' : ''].filter(Boolean).join(' ') || undefined}>
                    {kind !== 'brief' && (
                      <input
                        type="checkbox"
                        checked={selectedKinds.has(kind)}
                        onChange={() => toggleSelectedKind(kind)}
                        onClick={(event) => event.stopPropagation()}
                        aria-label={`Select ${kind} for generation`}
                      />
                    )}
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
            {unplannedDesignRows.length > 0 && (() => {
              const unplanned = unplannedDesignRows.map((row) => row.name);
              return (
                <p className="studio-notice warning" role="status">
                  <AlertTriangle size={14} />
                  <span>
                    {unplanned.length} drawn page{unplanned.length === 1 ? ' is' : 's are'} not in the plan: {unplanned.slice(0, 4).join(', ')}{unplanned.length > 4 ? ` and ${unplanned.length - 4} more` : ''}. Tell Studio what {unplanned.length === 1 ? 'it is' : 'they are'} so the plan, the board and the drawing agree.
                  </span>
                  <button type="button" className="secondary-button" onClick={() => setTab('chat')}>Open Studio chat</button>
                </p>
              );
            })()}
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
            <section className="studio-design-chat" aria-label="Design assistant chat">
              <h3>Chat with the design assistant</h3>
              <p className="studio-note">Explain a correction or attach a screenshot. The assistant checks the project page list, board, and Open Pencil design before replying.</p>
              <div className="studio-design-chat-thread" aria-live="polite">
                {designChatMessages.length === 0 && <p className="studio-note">For example: “Academic sessions and terms already exists at /admin/setup/terms. Please find the existing page and sync the board.”</p>}
                {designChatMessages.map((item, index) => <p key={`${item.role}-${index}`} className={`studio-chat-message ${item.role}`}><strong>{item.role === 'user' ? 'You' : 'Design AI'}</strong><br />{item.text}</p>)}
              </div>
              {designChatImage && <p className="studio-note">Screenshot attached: {designChatImage.name} <button type="button" className="composer-text-button" onClick={() => setDesignChatImage(null)}>Remove</button></p>}
              <textarea value={designChatText} onChange={(event) => setDesignChatText(event.target.value)} placeholder="Tell the design AI what is already there or what needs fixing…" rows={3} disabled={busy !== null} />
              <div className="page-actions">
                <label className="secondary-button"><ImagePlus size={14} /> Attach screenshot<input type="file" accept="image/png,image/jpeg,image/webp" hidden disabled={busy !== null} onChange={(event) => { void selectDesignChatImage(event.target.files?.[0]); event.target.value = ''; }} /></label>
                <button type="button" className="primary-button" onClick={() => void sendDesignChat()} disabled={busy !== null || (!designChatText.trim() && !designChatImage)}>{busy === 'design' ? <Loader2 className="spin" size={14} /> : <Send size={14} />} Send to design AI</button>
              </div>
            </section>
          </article>
          )}

          {tab === 'design' && (
            <>
              <article className="studio-card">
                <h2><LayoutGrid size={16} /> Draw in open-pencil</h2>
                {autopilot && AUTOPILOT_ACTIVE.has(autopilot.phase) && (
                  <p className="studio-note" role="status">Autopilot is working this board right now. Drawing here as well is fine, but pulling the design can mark cards it is holding stale, so it may park or redo one.</p>
                )}
                <p className="studio-note">
                  Build the design runs the whole list for you: the foundation first, then one screen at a time, checking after each step that open-pencil really holds the screen before moving on. Stop any time — the screens already drawn are kept and Resume carries on from the first one still missing. Copy prompt is still here for running a single step yourself.
                </p>
                {designStatus && (
                  <p className="studio-note" role="status">
                    {designStatus.message}
                    {designStatus.pulledAt ? ` Last pulled ${designStatus.pulledAt.slice(0, 16).replace('T', ' ')}.` : ' Nothing has been pulled yet.'}
                  </p>
                )}
                {buildOutcome && <p className="studio-note" role="status">{buildOutcome}</p>}
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
                  {differentDocument && (
                    <button type="button" className="primary-button" onClick={() => void useThisDocument()} disabled={busy !== null} title="The editor holds a document with none of this project's pages, which is what a restarted design looks like.">
                      <Check size={14} /> Use this document
                    </button>
                  )}
                  <button type="button" className="secondary-button" onClick={() => void reconcileDesignPages()} disabled={busy !== null || designRows.length === 0} title="Read the current Open Pencil document and match its existing pages to the project screen list.">
                    {busy === 'design' ? <Loader2 className="spin" size={14} /> : <Check size={14} />} Reconcile pages
                  </button>
                  {designRows.some((row) => row.inPages) && (
                    <button type="button" className="secondary-button" onClick={() => void redrawAll()} disabled={busy !== null || !readiness?.ready} title="Start the whole design again, foundation included — after a failed run, or to apply a look you changed after drawing">
                      <RotateCcw size={14} /> Restart all
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

          {tab === 'chat' && (
          <article className="studio-card studio-chat-shell">
            <h2><NotebookPen size={16} /> Studio chat</h2>
            <p className="studio-note">
              Ask about the plan, correct one screen, or add a whole feature. Studio reads the plan, the board and the design, then proposes the changes. Nothing is written until you tick the ones you want and apply them.
            </p>
            <p className="studio-model">
              Uses {readiness?.displayName ?? 'the Prompt Guide'}{readiness?.model ? ` · ${readiness.model}` : ''}. No separate key.
            </p>
            {(() => {
              const unplanned = unplannedDesignRows;
              if (unplanned.length === 0) return null;
              return (
                <section>
                  <h3>Drawn but not planned</h3>
                  <p className="studio-note">These pages exist in open-pencil but not in the pages list, which is why the board cannot match them.</p>
                  <ul className="studio-list">
                    {unplanned.map((row) => (
                      <li key={row.name}>
                        <strong>{row.name}</strong>
                        <span className="studio-step-buttons">
                          <button type="button" className="secondary-button" onClick={() => void explainDrawnPage(row.name, 'link')} disabled={busy !== null}>This is a planned screen</button>
                          <button type="button" className="secondary-button" onClick={() => void explainDrawnPage(row.name, 'add')} disabled={busy !== null}>It is new</button>
                          <button type="button" className="secondary-button" onClick={() => void explainDrawnPage(row.name, 'remove')} disabled={busy !== null}>Not needed</button>
                          <button type="button" className="secondary-button" onClick={() => ignoreDesignPage(row.name)} disabled={busy !== null}>Not a screen</button>
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })()}
            <section className="studio-design-chat" aria-label="Studio chat">
              <div className="studio-design-chat-thread studio-chat-thread-full" aria-live="polite">
                {planChatMessages.length === 0 && (
                  <div className="studio-note">
                    <p>Ask about the plan, correct one screen, or add a whole feature.</p>
                    <div className="page-actions">
                      <button type="button" className="secondary-button" onClick={() => setPlanIntent('feature')} disabled={busy !== null}>Add a feature</button>
                      <button type="button" className="secondary-button" onClick={() => setPlanIntent('screen')} disabled={busy !== null}>Fix a screen</button>
                      <button type="button" className="secondary-button" onClick={() => setPlanIntent('ask')} disabled={busy !== null}>Ask a question</button>
                    </div>
                    <p>For example: “Add a parent portal with a report card page.” “Register is the sign-up screen, just named differently.” “The old dashboard is not needed.”</p>
                  </div>
                )}
                {planChatMessages.map((item, index) => <p key={`${item.role}-${index}`} className={`studio-chat-message ${item.role}`}><strong>{item.role === 'user' ? 'You' : 'Studio'}</strong><br />{item.text}</p>)}
                {planPhase && (
                  <p className="studio-chat-message assistant studio-chat-pending" role="status">
                    <strong>Studio</strong><br />
                    <Loader2 className="spin" size={13} />{' '}
                    {planPhase === 'applying'
                      ? 'Applying the changes...'
                      : `${PLAN_STAGE_LABEL[planStage]}${planElapsed > 0 ? ` (${planElapsed}s)` : ''}`}
                  </p>
                )}
              </div>
              <div className="studio-chat-dock">
                <div className="studio-chat-intents" role="group" aria-label="What do you want to do?">
                  {([
                    ['ask', 'Ask'],
                    ['screen', 'Change a screen'],
                    ['feature', 'Add a feature'],
                  ] as const).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      className={planIntent === id ? 'secondary-button selected' : 'secondary-button'}
                      aria-pressed={planIntent === id}
                      onClick={() => setPlanIntent(id)}
                      disabled={busy !== null}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <span className="studio-model">One or two model calls, usually under a minute.</span>
                <textarea
                  value={planChatText}
                  onChange={(event) => setPlanChatText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void sendPlanChat();
                    }
                  }}
                  placeholder="Tell Studio what this page is, or what should change…"
                  rows={3}
                  disabled={busy !== null}
                />
                <div className="page-actions">
                  <button type="button" className="primary-button" onClick={() => void sendPlanChat()} disabled={busy !== null || !planChatText.trim()}>{busy === 'plan-chat' ? <Loader2 className="spin" size={14} /> : <Send size={14} />} Ask Studio</button>
                  {planPhase === 'thinking' && <button type="button" className="secondary-button" onClick={stopPlanChat}>Stop waiting</button>}
                  <span className="studio-model">It proposes; you decide what to apply.</span>
                </div>
              </div>
            </section>
            {planActions && planActions.length > 0 && (
              <section className="studio-handoff">
                <h3><Check size={15} /> Proposed changes</h3>
                <ul className="studio-list">
                  {planActions.map((action, index) => (
                    <li key={`${action.kind}-${index}`}>
                      <span className="studio-plan-action">
                        <span className="studio-plan-action-head">
                          <label>
                            <input type="checkbox" checked={planSelected[index] ?? false} onChange={() => togglePlanAction(index)} disabled={busy !== null} />
                            {' '}{action.summary}
                          </label>
                          <button
                            type="button"
                            className="composer-text-button"
                            onClick={() => setEditingAction(editingAction === index ? null : index)}
                            disabled={busy !== null}
                          >
                            {editingAction === index ? 'Done' : 'Edit'}
                          </button>
                        </span>
                        <span className="studio-note">{action.kind}: {planActionDetail(action)}</span>
                        {editingAction === index && (
                          <PlanActionEditor
                            action={action}
                            onChange={(next) => replacePlanAction(index, next)}
                            disabled={busy !== null}
                          />
                        )}
                        {(planWarnings.get(index) ?? []).map((warning) => (
                          <span key={warning.code} className="studio-note"><AlertTriangle size={12} /> {warning.message}</span>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
                {planDropped > 0 && (
                  <p className="studio-note">
                    <AlertTriangle size={13} /> {planDropped} proposed change{planDropped === 1 ? '' : 's'} could not be read. Try asking again with simpler wording.
                  </p>
                )}
                <div className="page-actions">
                  <button type="button" className="primary-button" onClick={() => void applyPlanChanges()} disabled={busy !== null || !planSelected.some(Boolean)}>
                    {busy === 'plan-chat' ? <Loader2 className="spin" size={14} /> : <Check size={14} />} Apply selected ({planSelected.filter(Boolean).length})
                  </button>
                  <button type="button" className="secondary-button" onClick={() => void applyPlanChanges(true)} disabled={busy !== null || !planSelected.some(Boolean)}>
                    <Play size={14} /> Apply and start Autopilot
                  </button>
                  <button type="button" className="secondary-button" onClick={() => { setPlanActions(null); setPlanSelected([]); setEditingAction(null); }} disabled={busy !== null}>Dismiss</button>
                </div>
              </section>
            )}
            {planActions && planActions.length === 0 && (
              <p className="studio-note" role="status">
                <span>
                  {planDropped > 0
                    ? `${planDropped} proposed change${planDropped === 1 ? '' : 's'} could not be read. Try again with simpler wording, or switch to Add a feature.`
                    : planIntent === 'ask'
                      ? 'No plan change was proposed. Switch to Add a feature or Change a screen if you wanted one.'
                      : 'Studio did not return a usable change set. Try again, or name the screens and cards you want added.'}
                </span>
                {lastPlanRequest && (
                  <button type="button" className="secondary-button" onClick={() => void sendPlanChat(lastPlanRequest)} disabled={busy !== null}>Try again</button>
                )}
              </p>
            )}
            {planOutcome && (
              <section className="studio-note" role="status">
                {planOutcome.applied.map((line) => <p key={line}><Check size={13} /> {line}</p>)}
                {planOutcome.failed.map((entry) => <p key={entry.summary} className="studio-fail"><AlertTriangle size={13} /> {entry.summary}: {entry.reason}</p>)}
              </section>
            )}
            {planNext && (
              <section className="studio-handoff">
                <h3><Play size={15} /> What next</h3>
                <p className="studio-note">
                  {planNext.ready > 0 ? `${planNext.ready} card${planNext.ready === 1 ? ' is' : 's are'} ready to work.` : 'Nothing is ready to work yet.'}
                  {planNext.undrawn > 0 ? ` ${planNext.undrawn} planned screen${planNext.undrawn === 1 ? '' : 's'} still need drawing.` : ''}
                  {planNext.unrouted > 0 ? ` ${planNext.unrouted} card${planNext.unrouted === 1 ? '' : 's'} still need a route.` : ''}
                </p>
                <div className="page-actions">
                  {planNext.ready > 0 && (
                    <button type="button" className="primary-button" onClick={() => void startPlanAutopilot()} disabled={busy !== null}>
                      {busy === 'guide' ? <Loader2 className="spin" size={14} /> : <Play size={14} />} Start Autopilot
                    </button>
                  )}
                  <button type="button" className="secondary-button" onClick={() => setTab('board')} disabled={busy !== null}>Review the board</button>
                  <button type="button" className="secondary-button" onClick={() => { if (projectId) void launchProject(projectId, 'editor'); }} disabled={busy !== null}>Open in Code</button>
                  {planNext.undrawn > 0 && <button type="button" className="secondary-button" onClick={() => setTab('design')} disabled={busy !== null}>Draw the screens</button>}
                </div>
                <p className="studio-note">Autopilot works the ready cards and stops each at Review. Code opens the project for a hand-run.</p>
              </section>
            )}
          </article>
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

          {/* Keep the room connected while someone reviews another Studio tab. */}
          {projectId && <div hidden={tab !== 'team'}>
            <StudioTeamPanel projectId={projectId} projectTitle={projectTitle} linkedProjectId={state?.linkedProjectId ?? null} artifacts={artifacts} onArtifactsChanged={setArtifacts} />
          </div>}

          {tab === 'board' && (
          <article className={`studio-card${boardFull ? ' studio-fullscreen' : ''}`}>
            <h2><LayoutGrid size={16} /> Board
              <button type="button" className="secondary-button studio-fullscreen-toggle" onClick={() => setBoardFull((current) => !current)} aria-pressed={boardFull} title={boardFull ? 'Leave full screen (Esc)' : 'Show the board full screen'}>
                {boardFull ? <Minimize2 size={13} /> : <Maximize2 size={13} />} {boardFull ? 'Exit full screen' : 'Full screen'}
              </button>
            </h2>
            <p className="studio-note">Cards built from the stories. A card reaches done only through a passing check that still matches the working tree.</p>
            {housekeeping.length > 0 && (
              <details className="studio-note">
                <summary>Board housekeeping: {housekeeping.reduce((total, finding) => total + finding.cards.length, 0)} cards to look at</summary>
                {housekeeping.map((finding) => (
                  <div key={finding.code}>
                    <p><strong>{finding.heading}</strong> ({finding.cards.length}). {finding.hint}</p>
                    <ul className="studio-list">
                      {finding.cards.slice(0, 12).map((item) => <li key={item.id}>{item.title}</li>)}
                      {finding.cards.length > 12 && <li>and {finding.cards.length - 12} more</li>}
                    </ul>
                  </div>
                ))}
              </details>
            )}
            <div className="page-actions">
              <button type="button" className="primary-button" onClick={() => void plan()} disabled={busy !== null || !readiness?.ready}>
                {busy === 'plan' ? <Loader2 className="spin" size={14} /> : <LayoutGrid size={14} />} {board?.cards.length ? 'Rebuild the board' : 'Build the board'}
              </button>
              <button type="button" className="secondary-button" onClick={() => void planForTeam()} disabled={busy !== null || !board?.cards.some((card) => card.status === 'ready')} title="One agent per ready card, reviewed on the Workflows page before anything runs">
                {busy === 'team' ? <Loader2 className="spin" size={14} /> : <Users size={14} />} Plan these for the team
              </button>
              <button type="button" className="secondary-button" onClick={() => void syncDesignFromBoard()} disabled={busy !== null} title="Pull the current OpenPencil document, compare its screens with the board, and mark changed designs for rebuilding.">
                {busy === 'design' ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />} Sync OpenPencil designs
              </button>
              <button type="button" className="secondary-button" onClick={() => void workCard()} disabled={busy !== null || !board?.cards.some((card) => card.status === 'ready')} title="Runs the next ready card with one agent. The card stops at review; the board decides when it is done.">
                {busy === 'work' ? <Loader2 className="spin" size={14} /> : <Play size={14} />} Work the next card
              </button>
              <button type="button" className="secondary-button" onClick={() => void arrange()} disabled={busy !== null || !board?.cards.length} title="Puts the cards in the order they should be built, so the product runs on your machine before anything is hosted. Status, runs and checks are kept.">
                {busy === 'arrange' ? <Loader2 className="spin" size={14} /> : <Sparkles size={14} />} Arrange with AI
              </button>
              {!!board?.cards.some(lacksRoute) && <button type="button" className="secondary-button" onClick={() => void suggestRoutes()} disabled={busy !== null} title="Match routes from the page inventory and pulled design, then suggest any remaining routes from project context.">{busy === 'card' ? <Loader2 className="spin" size={14} /> : <Sparkles size={14} />} Suggest route fixes</button>}
            </div>
            {syncOutcome && (
              <section className="studio-route-review studio-sync-result" role="status" aria-label="OpenPencil sync result">
                <h3>OpenPencil sync</h3>
                {syncOutcome.map((line) => <p key={line} className="studio-note">{line}</p>)}
              </section>
            )}
            {routeSuggestions && <section className="studio-route-review" aria-label="Review suggested routes">
              <h3>Review route suggestions</h3>
              <p className="studio-note">Routes found in the page inventory or screen name are marked high confidence. Model suggestions need your review before they are saved.</p>
              {routeSuggestions.map((suggestion) => { const card = board?.cards.find((item) => item.id === suggestion.cardId); return <p key={suggestion.cardId}><strong>{card?.title ?? suggestion.cardId}</strong> → <code>{suggestion.route}</code> <span className="studio-kind">{suggestion.confidence} confidence · {suggestion.reason}</span></p>; })}
              {routeUnresolved.length > 0 && <div className="studio-note">
                <p>Still without a route. Give each one a route, or say it is not a screen of its own (a label, a note, or a dialog drawn inside another screen) so it needs none.</p>
                {routeUnresolved.map((id) => <p key={id}><strong>{board?.cards.find((card) => card.id === id)?.title ?? id}</strong> <button type="button" className="secondary-button" onClick={() => void markNotAScreen(id)} disabled={busy !== null}>Needs no route</button></p>)}
              </div>}
              <div className="page-actions"><button type="button" className="primary-button" onClick={() => void applyRouteSuggestions()} disabled={busy !== null || routeSuggestions.length === 0}>Apply reviewed routes</button><button type="button" className="secondary-button" onClick={() => setRouteSuggestions(null)} disabled={busy !== null}>Dismiss</button></div>
            </section>}
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
                inReview={board.cards.filter((card) => card.status === 'review').length}
                unchecked={board.cards.filter((card) => card.status === 'review' && !card.check && card.notes.includes('has no check command')).length}
                // Design work in the same Studio does not hold Autopilot back: drawing happens in open-pencil, and the board's writes are
                // checked against its revision. Anything else that edits the board still does.
                disabled={busy !== null && busy !== 'design' && busy !== 'design-build' && busy !== 'page-op'}
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
                      {cards.map((card) => <BoardCardView key={card.id} card={card} busy={busy !== null} onMove={move} onCheckUi={checkUi} onSetRoute={setRoute} onRememberApproach={rememberBlockedApproach} onLearn={(chosen) => { if (projectId) onLearnCard(chosen, projectId); }} />)}
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
                    <FolderOpen size={13} /> Plan {currentFolder.name}
                  </button>
                )}
              </div>
              <small>{currentFolder ? 'Attach this plan to the open project, so the interview and the design read the code that is already there. The plan is written under that folder\'s .kai/spec.' : 'Plan first. You can create a project folder after the brief is ready.'}</small>
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
  const explanation = blocked ? explainBlocked(note) : null;
  return (
    <div className={`studio-note studio-why${blocked ? ' blocked' : ''}`}>
      <span className="studio-why-icon" aria-hidden="true">{blocked ? <AlertTriangle size={12} /> : <FileText size={12} />}</span>
      <div className="studio-why-text">
        <div>{note.trim()}</div>
        {explanation && <div className="studio-blocked-next"><strong>Suggested next step:</strong> {explanation.ask}</div>}
      </div>
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

function BoardCardView({ card, busy, onMove, onCheckUi, onSetRoute, onRememberApproach, onLearn }: { card: BoardCard; busy: boolean; onMove: (id: string, status: BoardStatus) => Promise<void>; onCheckUi: (id: string) => Promise<void>; onSetRoute: (id: string, route: string) => Promise<void>; onRememberApproach: (card: BoardCard) => Promise<void>; onLearn: (card: BoardCard) => void }): ReactNode {
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
      {ui && card.designRef && !card.stale && <p className="studio-note studio-drawn"><Check size={12} /> Drawn in OpenPencil</p>}
      {card.kind === 'page' && !card.designRef && <p className="studio-note">Not drawn in OpenPencil yet.</p>}
      {/* The reason a card is where it is. It was always on the card and never on the screen, so a board full of
          blocked cards read as a board with no reason — while the reason sat in this field. */}
      {card.notes.trim() && <CardNote note={card.notes} blocked={card.status === 'blocked'} />}
      {card.status === 'blocked' && machineBlocked(card) && (
        <div className="page-actions">
          <p className="studio-note"><AlertTriangle size={12} /> This card is parked while other independent cards continue. Review the suggested next step above, then move it to Ready when you want Autopilot to try again.</p>
          <button type="button" className="secondary-button" onClick={() => void onRememberApproach(card)} disabled={busy}>Remember an approach</button>
        </div>
      )}
      {card.claimedBy && <p className="studio-note"><Loader2 size={12} /> Held by {card.claimedBy}</p>}
      {card.movedBy && card.movedAt && (
        <p className="studio-note studio-moved">
          <span className={`studio-who ${card.movedBy}`}>{card.movedBy === 'user' ? 'you' : card.movedBy === 'check' ? 'check' : 'agent'}</span>
          moved {card.movedAt.slice(0, 16).replace('T', ' ')}
        </p>
      )}
      {card.check && <p className="studio-note">{card.check.visual === 'passed' ? <Check size={12} /> : <AlertTriangle size={12} />} Visual check {card.check.visual ?? 'not run'} · {card.check.screenshots.length} shots</p>}
      {card.acceptance.length > 0 && (
        <div className="studio-note studio-acceptance" aria-label={`Acceptance criteria for ${card.title}`}>
          <strong>Acceptance evidence</strong>
          <ul>
            {card.acceptance.map((criterion) => {
              const evidence = card.check?.acceptanceEvidence?.find((item) => item.criterion === criterion);
              return <li key={criterion}>{evidence?.status === 'passed' ? <Check size={12} /> : <AlertTriangle size={12} />} {criterion}{evidence?.evidence ? <small> — {evidence.evidence}</small> : <small> — no passing evidence yet</small>}</li>;
            })}
          </ul>
        </div>
      )}
      {ui && !card.route && card.kind === 'page' && (
        <p className="studio-note studio-why blocked">
          <AlertTriangle size={12} /> No route, so this screen cannot be checked and the board will not close it. Set one below.
        </p>
      )}
      {ui && !card.route && card.kind !== 'page' && (
        <p className="studio-note">This sits inside a page, so it is closed on the build check. Give it a route below only if it has its own screen.</p>
      )}
      {ui && (
        <button type="button" className="secondary-button" onClick={() => void onCheckUi(card.id)} disabled={busy || !card.route}>
          <Eye size={13} /> {card.route ? 'Check the screen' : 'No route set'}
        </button>
      )}
      {ui && <CardRoute cardId={card.id} title={card.title} route={card.route} busy={busy} onSetRoute={onSetRoute} />}
      {/* The card, its acceptance criteria, its dependencies and the files its runs touched are exactly the context a
          tutor needs, and the board is where that context already lives — so it is offered from the card rather than
          re-described in the question box. It opens the tutor with the question written and waiting, not sent. */}
      <button type="button" className="secondary-button" onClick={() => onLearn(card)} title={`Ask the tutor about "${card.title}"`}>
        <Code2 size={13} /> Learn this card
      </button>
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
