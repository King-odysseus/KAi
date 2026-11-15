import { Textarea } from 'flowbite-react';
import { Switch } from './ui/Switch';
import {
  Activity, AlertTriangle, ClipboardList, Coins, Compass, FileCheck, FileText, FlaskConical, Kanban, Lock, MessageSquare, Minus, Palette, Pause, Pencil, Play, Plus, RefreshCw, Rocket, RotateCcw, Save, Scale, ScanSearch, ShieldCheck, Square, Trash2, Users, Wrench,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  CLI_MODEL_SUGGESTIONS, CREW_ROLE_INFO, directProviderPreset, CREW_ROLE_KINDS, MAX_CREW_ROLES, MAX_SUB_AGENTS_PER_ROLE, buildReport, createDefaultCrewConfig, crewConfigSchema, roleAccess, studioBriefChangeDiff,
} from '@kai/contracts';
import { apiChoices, targetFromValue, targetValue } from './architect-settings';
import type { PersistedEvent, RoleTarget } from '@kai/contracts';
import type { AgentCapability, AgentId, AppSettings, AutonomyMode, CrewConfig, CrewInterview, CrewDesign, CrewRole, CrewRun, CrewTask, ProjectRecord } from '@kai/contracts';
import { relativeTime, unwrap } from '../types';
import { crewTitle } from '../crew-title';
import { Pill, type PillTone } from './Pill';
import { ModelField } from './ModelField';
import { Select } from './ui/Select';
import { UiButton } from './UiButton';
import { usePersistentChoice } from '../persistent-choice';
import { UiTextInput } from './UiTextInput';
import { PageHeader } from './ui/PageHeader';
import { crewLimitPolicy } from '../cost-visibility';
import { collapseFeed } from '../crew-feed';
import { CrewApprovals } from './CrewApprovals';
import { CrewChat } from './CrewChat';
import { CrewDone } from './CrewDone';
import { CrewInterviewPanel } from './CrewInterviewPanel';
import { compileBrief, keepGoingFrom, type InterviewAnswer } from '../crew-brief';

type Tab = 'board' | 'chat' | 'crew' | 'design' | 'cost' | 'report';
const TABS: ReadonlyArray<{ id: Tab; label: string; icon: typeof Kanban }> = [
  { id: 'board', label: 'Board', icon: Kanban },
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'crew', label: 'Crew', icon: Users },
  { id: 'design', label: 'Design', icon: Palette },
  { id: 'cost', label: 'Cost', icon: Coins },
  { id: 'report', label: 'Report', icon: FileText },
];

const ROLE_ICON: Record<CrewRole['kind'], typeof Compass> = {
  lead: Compass, planner: ClipboardList, builder: Wrench, reviewer: ShieldCheck, security: ShieldCheck,
  tester: FlaskConical, auditor: ScanSearch, license: FileCheck, compliance: Scale, designer: Palette, operator: Rocket, custom: Users,
};

const AUTONOMY: ReadonlyArray<{ value: AutonomyMode; label: string }> = [
  { value: 'plan', label: 'Plan' }, { value: 'ask', label: 'Ask' }, { value: 'autoEdit', label: 'Auto-edit' }, { value: 'full', label: 'Full control' }, { value: 'custom', label: 'Custom' },
];

const RUN_STATUS: Record<CrewRun['status'], { label: string; tone: PillTone }> = {
  planning: { label: 'Planning', tone: 'info' },
  awaitingApproval: { label: 'Needs your approval', tone: 'warning' },
  running: { label: 'Running', tone: 'success' },
  paused: { label: 'Paused', tone: 'warning' },
  needsYou: { label: 'Needs you', tone: 'error' },
  completed: { label: 'Done', tone: 'success' },
  stopped: { label: 'Stopped', tone: 'neutral' },
};

const TASK_STATUS: Record<CrewTask['status'], { label: string; tone: PillTone }> = {
  backlog: { label: 'Waiting', tone: 'neutral' },
  building: { label: 'Building', tone: 'info' },
  review: { label: 'In review', tone: 'info' },
  sentBack: { label: 'Sent back', tone: 'warning' },
  accepted: { label: 'Accepted', tone: 'success' },
  blocked: { label: 'Blocked', tone: 'warning' },
  needsYou: { label: 'Needs you', tone: 'error' },
  skipped: { label: 'Skipped', tone: 'neutral' },
};

/** The five board columns; each takes one or two task states so the board stays readable. */
const COLUMNS: ReadonlyArray<{ id: string; label: string; statuses: CrewTask['status'][] }> = [
  { id: 'waiting', label: 'Waiting', statuses: ['backlog', 'blocked'] },
  { id: 'building', label: 'Building', statuses: ['building'] },
  { id: 'review', label: 'In review', statuses: ['review'] },
  { id: 'back', label: 'Sent back', statuses: ['sentBack', 'needsYou'] },
  { id: 'accepted', label: 'Accepted', statuses: ['accepted', 'skipped'] },
];

type RunsOn = 'cli' | 'api' | 'cli-proxy';
const runsOn = (role: Pick<CrewRole, 'execution' | 'route'>): RunsOn => (role.execution === 'api' ? 'api' : role.route === 'proxy' ? 'cli-proxy' : 'cli');

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function CrewView({ activeProject, agentCapabilities, settings, goalRequest = null, onOpenGit, onOpenPreview, onOpenConversation }: {
  /** Opens a conversation in the Workspace, so the full transcript of what the crew did can be read. */
  onOpenConversation?: (conversationId: string) => void;
  /** Opens the Git page, where a finished crew's changes are read and committed. */
  onOpenGit?: () => void;
  /** Opens the live preview pane. */
  onOpenPreview?: () => void;
  /** A goal handed over from elsewhere (the Project Studio); it fills the box and the user still presses Start. */
  goalRequest?: { goal: string; nonce: number } | null;
  activeProject: ProjectRecord | null;
  agentCapabilities: AgentCapability[];
  settings: AppSettings;
}): ReactNode {
  const [runs, setRuns] = useState<CrewRun[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CrewConfig>(() => createDefaultCrewConfig(settings.defaultAgent));
  const [goal, setGoal] = useState('');
  const [tab, setTab] = usePersistentChoice<Tab>('kai.tab.crew', 'board', TABS.map((item) => item.id));
  const [guidance, setGuidance] = useState('');
  /** The start interview: null when not in use, 'loading' while the Lead reads the goal, then its questions. */
  const [interview, setInterview] = useState<CrewInterview | 'loading' | null>(null);
  const [askFirst, setAskFirst] = usePersistentChoice<'on' | 'off'>('kai.crew.askFirst', 'on', ['on', 'off']);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [design, setDesign] = useState<CrewDesign | null>(null);
  const [briefDiff, setBriefDiff] = useState<string | null>(null);

  // A handed-over goal needs the new-crew form, so the run list loading afterwards must not pick an old run over it.
  const wantsNewRun = useRef(false);
  /** Changes to an existing crew's team that are not saved yet, kept with the crew they belong to. */
  const [edited, setEdited] = useState<{ runId: string; config: CrewConfig } | null>(null);
  useEffect(() => {
    if (!goalRequest) return;
    setGoal(goalRequest.goal);
    setActiveRunId(null);
    wantsNewRun.current = true;
  }, [goalRequest?.nonce]);

  const activeRun = runs.find((run) => run.id === activeRunId) ?? null;
  const unsaved = activeRun && edited?.runId === activeRun.id ? edited.config : null;
  const config = unsaved ?? activeRun?.config ?? draft;
  // A crew can be changed whenever it is not working: its next task uses whatever is saved.
  const readOnly = Boolean(activeRun && (activeRun.status === 'running' || activeRun.status === 'planning'));

  useEffect(() => {
    if (!activeRun?.briefSnapshot || !activeProject) { setBriefDiff(null); return; }
    let mounted = true;
    const refresh = async () => {
      try {
        const studios = unwrap(await window.kaiDesktop.studioProjects());
        const studio = studios.find((item) => item.linkedProjectId === activeProject.id || item.id === activeProject.id);
        if (!studio) { if (mounted) setBriefDiff(null); return; }
        const current = unwrap(await window.kaiDesktop.studioArtifactText({ projectId: studio.id, kind: 'brief' }));
        if (mounted) setBriefDiff(current ? studioBriefChangeDiff(activeRun.briefSnapshot!, current) : null);
      } catch {
        if (mounted) setBriefDiff(null);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, [activeRunId, activeRun?.briefSnapshot, activeProject?.id]);

  function reconcile(run: CrewRun): void {
    setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)].sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
  }

  /** A message to the Lead from the Chat tab: a question, a change of direction, or more to build. */
  async function sendMessage(kind: 'ask' | 'steer' | 'work', text: string): Promise<void> {
    if (!activeRun) return;
    reconcile(unwrap(await window.kaiDesktop.messageCrew(activeRun.id, kind, text)));
  }

  /** Stops the Lead answering a question, without touching the crew's own agents. */
  async function stopAsk(): Promise<void> {
    if (!activeRun) return;
    reconcile(unwrap(await window.kaiDesktop.stopCrewAsk(activeRun.id)));
  }

  async function keepGoing(on: boolean): Promise<void> {
    if (!activeRun) return;
    reconcile(unwrap(await window.kaiDesktop.setCrewKeepGoing(activeRun.id, on)));
  }

  async function explainSimply(on: boolean): Promise<void> {
    if (!activeRun) return;
    reconcile(unwrap(await window.kaiDesktop.setCrewExplainSimply(activeRun.id, on)));
  }

  async function findPhases(): Promise<void> {
    if (!activeRun) return;
    reconcile(unwrap(await window.kaiDesktop.findCrewPhases(activeRun.id)));
  }

  /** One yes or no on an approval card. The crew carries on once every card is answered. */
  function decideApproval(approvalId: string, approve: boolean): void {
    if (!activeRun) return;
    void run(async () => unwrap(await window.kaiDesktop.decideCrewApproval(activeRun.id, approvalId, approve)));
  }

  /** Hands a finished crew more work. The Lead plans it onto the same board, which then runs again. */
  async function followUp(prompt: string): Promise<void> {
    if (!activeRun) return;
    reconcile(unwrap(await window.kaiDesktop.followUpCrew(activeRun.id, prompt)));
    setTab('board');
  }

  useEffect(() => {
    setActiveRunId(null);
    void window.kaiDesktop.listCrewRuns(activeProject?.id).then(unwrap).then((loaded) => {
      setRuns(loaded);
      if (wantsNewRun.current) { wantsNewRun.current = false; return; }
      setActiveRunId(loaded.find((run) => run.status !== 'completed' && run.status !== 'stopped')?.id ?? loaded[0]?.id ?? null);
    }).catch((caught) => setError(messageOf(caught)));
  }, [activeProject?.id]);

  // A saved default replaces the built-in roles for new crews; the conventions are read from the developer's own projects.
  useEffect(() => {
    if (!activeProject) return;
    void window.kaiDesktop.crewDefaults(activeProject.id).then(unwrap).then((saved) => { if (saved) setDraft(saved); }).catch(() => undefined);
  }, [activeProject?.id]);

  useEffect(() => {
    if (tab !== 'design' && !activeRun?.design) return;
    void window.kaiDesktop.crewDesign(false).then(unwrap).then(setDesign).catch(() => undefined);
  }, [tab, activeProject?.id, activeRun?.design?.pages.length]);

  async function readDesign(launch: boolean): Promise<void> {
    try { setDesign(unwrap(await window.kaiDesktop.crewDesign(launch))); } catch (caught) { setError(messageOf(caught)); }
  }

  async function saveDefault(): Promise<void> {
    const parsed = crewConfigSchema.safeParse(config);
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check the crew settings.'); return; }
    try {
      unwrap(await window.kaiDesktop.saveCrewDefaults(parsed.data, activeProject?.id));
      setNotice('Saved. New crews in this project start with these roles and limits.');
      setError(null);
    } catch (caught) { setError(messageOf(caught)); }
  }

  async function resetDefault(): Promise<void> {
    try {
      unwrap(await window.kaiDesktop.saveCrewDefaults(null, activeProject?.id));
      setDraft(createDefaultCrewConfig(settings.defaultAgent));
      setNotice('Back to the built-in roles and limits.');
      setError(null);
    } catch (caught) { setError(messageOf(caught)); }
  }

  useEffect(() => window.kaiDesktop.onCrewChanged((run) => {
    if (run.projectId !== activeProject?.id) return;
    reconcile(run);
    setActiveRunId((current) => current ?? run.id);
  }), [activeProject?.id]);

  const capabilityOf = (agent: AgentId): AgentCapability | undefined => agentCapabilities.find((item) => item.id === agent);

  function updateDraft(change: (current: CrewConfig) => CrewConfig): void {
    // With a crew selected the change is to that crew, held until saved; otherwise it is to the next new crew.
    if (activeRun) {
      setEdited({ runId: activeRun.id, config: change(unsaved ?? activeRun.config) });
      return;
    }
    setDraft((current) => change(current));
  }

  /** Saves a changed team onto the crew itself. It applies from the crew's next task. */
  async function saveTeam(): Promise<void> {
    if (!activeRun || !unsaved) return;
    const parsed = crewConfigSchema.safeParse(unsaved);
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check the crew settings.'); return; }
    setWorking(true);
    setError(null);
    try {
      reconcile(unwrap(await window.kaiDesktop.updateCrewConfig(activeRun.id, parsed.data)));
      setEdited(null);
      setNotice('Saved. The new team applies from the crew’s next task.');
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setWorking(false);
    }
  }

  function updateRole(id: string, patch: Partial<CrewRole>): void {
    updateDraft((current) => ({ ...current, roles: current.roles.map((role) => (role.id === id ? { ...role, ...patch } : role)) }));
  }

  function addRole(kind: CrewRole['kind']): void {
    updateDraft((current) => {
      if (current.roles.length >= MAX_CREW_ROLES) return current;
      const base = kind === 'custom' ? 'custom' : kind;
      let id = kind === 'custom' ? 'custom-1' : base;
      for (let n = 2; current.roles.some((role) => role.id === id); n += 1) id = `${base}-${n}`;
      const info = kind === 'custom' ? null : CREW_ROLE_INFO[kind];
      const role: CrewRole = { id, kind, label: info ? info.label : `Role ${current.roles.length + 1}`, agent: settings.defaultAgent, execution: 'cli', route: 'direct', access: info ? info.access : 'edit', subAgents: { max: 0 }, instructions: '' };
      return { ...current, roles: [...current.roles, role] };
    });
  }

  async function run(action: () => Promise<CrewRun>): Promise<void> {
    setWorking(true);
    setError(null);
    try {
      const next = await action();
      reconcile(next);
      setActiveRunId(next.id);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setWorking(false);
    }
  }

  /** Starts the crew on a goal, with what the start interview settled if it was used. */
  async function begin(finalGoal: string, keepGoingChoice?: boolean): Promise<void> {
    if (!activeProject) return;
    const parsed = crewConfigSchema.safeParse(draft);
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check the crew settings.'); return; }
    await run(async () => unwrap(await window.kaiDesktop.startCrew({
      projectId: activeProject.id, goal: finalGoal, config: parsed.data,
      ...(keepGoingChoice !== undefined ? { keepGoing: keepGoingChoice } : {}),
    })));
    setInterview(null);
    setTab('board');
  }

  /**
   * Press Start: with "ask me first" on, the Lead reads the goal (and any plan file it names) and brings back the few
   * questions it could not answer itself. A goal that needs none, or a Lead that cannot answer, starts straight away.
   */
  async function start(): Promise<void> {
    if (!activeProject) return;
    const text = goal.trim();
    if (askFirst !== 'on') { await begin(text); return; }
    setInterview('loading');
    try {
      const read = unwrap(await window.kaiDesktop.crewInterview(activeProject.id, text));
      if (read.items.length === 0) {
        if (read.note) setNotice(read.note);
        await begin(text);
        return;
      }
      setInterview(read);
    } catch (caught) {
      setNotice(`Could not ask questions first (${messageOf(caught)}). Planning now.`);
      await begin(text);
    }
  }

  async function startWithAnswers(answers: InterviewAnswer[]): Promise<void> {
    await begin(compileBrief(goal.trim(), answers), keepGoingFrom(answers));
  }

  function newCrew(): void {
    if (activeRun) setDraft(unsaved ?? activeRun.config);
    setEdited(null);
    setActiveRunId(null);
    setGoal('');
    setTab('board');
  }

  return (
    <div className="page-view crew-view">
      <PageHeader title="Crew" detail={<>A Lead plans the tasks, builders write the code, and every result is checked before it counts{activeProject ? ` · ${activeProject.name}` : ''}</>} actions={<>{runs.length > 0 && (
            <Select aria-label="Crew run" value={activeRunId ?? ''} onChange={(event) => { setActiveRunId(event.target.value || null); setTab('board'); }}>
              <option value="">New crew</option>
              {runs.map((item) => <option key={item.id} value={item.id}>{`${crewTitle(item.goal)} · ${RUN_STATUS[item.status].label} · ${relativeTime(item.startedAt)}`}</option>)}
            </Select>
          )}
          <UiButton type="button" className="secondary-button" onClick={newCrew} disabled={!activeRun}><Plus size={14} /><span>New crew</span></UiButton></>} />

      {!activeProject && <div className="empty-list">Open a project to start a crew.</div>}
      {error && <div className="workbench-error" role="alert">{error}</div>}
      {notice && !error && <div className="workbench-notice" role="status"><span>{notice}</span><UiButton type="button" className="secondary-button" onClick={() => setNotice(null)}>Dismiss</UiButton></div>}

      {activeProject && (
        <>
          {activeRun && <RunBar run={activeRun} working={working} onPause={() => void run(async () => unwrap(await window.kaiDesktop.pauseCrew(activeRun.id)))} onResume={() => void run(async () => unwrap(await window.kaiDesktop.resumeCrew(activeRun.id)))} onStop={() => void run(async () => unwrap(await window.kaiDesktop.stopCrew(activeRun.id)))} onApprove={() => void run(async () => unwrap(await window.kaiDesktop.approveCrew(activeRun.id)))} />}
          {activeRun && briefDiff && (
            <div className="workbench-notice" role="status">
              <span><strong>The brief changed since this run began.</strong> Tell the Lead so upcoming work follows the latest scope.</span>
              <UiButton type="button" className="primary-button" disabled={working} onClick={() => void run(async () => { const next = unwrap(await window.kaiDesktop.answerCrew(activeRun.id, 'continue', briefDiff)); setBriefDiff(null); return next; })}>Tell the Lead</UiButton>
            </div>
          )}
          {activeRun?.ask?.reason === 'approval' && <CrewApprovals run={activeRun} working={working} onDecide={decideApproval} />}
          {activeRun?.ask && activeRun.ask.reason !== 'approval' && (
            <div className="needs-you tone-needs-you" role="status">
              <span className="needs-you-icon" aria-hidden="true"><AlertTriangle size={15} /></span>
              <div className="needs-you-body">
                <strong>Needs you</strong>
                <p className="needs-you-detail">{activeRun.ask.message}</p>
                <Textarea className="crew-guidance" rows={2} value={guidance} onChange={(event) => setGuidance(event.target.value)} placeholder="Optional: tell the crew what to do, in your own words" aria-label="Guidance for the crew" />
              </div>
              <div className="crew-answer-actions">
                <UiButton type="button" className="primary-button" disabled={working} onClick={() => void run(async () => { const next = unwrap(await window.kaiDesktop.answerCrew(activeRun.id, 'continue', guidance)); setGuidance(''); return next; })}>Continue</UiButton>
                {activeRun.ask.taskId && <UiButton type="button" className="secondary-button" disabled={working} onClick={() => void run(async () => unwrap(await window.kaiDesktop.answerCrew(activeRun.id, 'skip', '')))}>Skip task</UiButton>}
                <UiButton type="button" className="secondary-button" disabled={working} onClick={() => void run(async () => unwrap(await window.kaiDesktop.answerCrew(activeRun.id, 'finish', '')))}>Finish</UiButton>
              </div>
            </div>
          )}

          {activeRun && unsaved && (
            <div className="workbench-notice" role="status">
              <span><strong>You changed this crew’s team.</strong> It applies from the crew’s next task.{readOnly ? ' Pause the crew to save it.' : ''}</span>
              <UiButton type="button" className="primary-button" disabled={working || readOnly} onClick={() => void saveTeam()}>Save team</UiButton>
              <UiButton type="button" className="secondary-button" disabled={working} onClick={() => setEdited(null)}>Discard</UiButton>
            </div>
          )}

          <div className="ops-tabs" role="tablist" aria-label="Crew sections">
            {TABS.map((item) => (
              <UiButton key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={`ops-tab ${tab === item.id ? 'active' : ''}`} onClick={() => setTab(item.id)}>
                <item.icon size={14} /><span>{item.label}</span>
              </UiButton>
            ))}
          </div>

          {tab === 'board' && (activeRun
            ? (
              <>
                {(activeRun.status === 'completed' || activeRun.status === 'stopped') && (
                  <CrewDone run={activeRun} project={activeProject} onFollowUp={followUp} onOpenGit={onOpenGit} onPreview={onOpenPreview} onReport={() => setTab('report')} onKeepGoing={keepGoing} onChat={() => setTab('chat')} />
                )}
                <Board run={activeRun} />
              </>
            )
            : (
              <>
              {typeof interview === 'object' && interview !== null && (
                <CrewInterviewPanel interview={interview} busy={working} onStart={(answers) => void startWithAnswers(answers)} onSkip={() => void begin(goal.trim())} onBack={() => setInterview(null)} />
              )}
              <section className="ops-panel crew-start" hidden={typeof interview === 'object' && interview !== null}>
                <label className="workflow-field" htmlFor="crew-goal"><span>What should the crew build?</span></label>
                <Textarea id="crew-goal" rows={4} value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="For example: build the Zuri log viewer with search, saved filters and sign-in." />
                <div className="crew-start-row">
                  <label className="workflow-field" htmlFor="crew-autonomy"><span>Autonomy</span>
                    <Select id="crew-autonomy" value={draft.autonomy} onChange={(event) => updateDraft((current) => ({ ...current, autonomy: event.target.value as AutonomyMode }))}>
                      {AUTONOMY.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                    </Select>
                  </label>
                  <label className="toggle-row"><span><strong>Show me the plan first</strong><small>The crew waits for your approval before it builds.</small></span><Switch checked={draft.approvePlan} onChange={(event) => updateDraft((current) => ({ ...current, approvePlan: event.target.checked }))} /></label>
                </div>
                <label className="workflow-field" htmlFor="crew-check"><span>Project check (optional)</span>
                  <UiTextInput id="crew-check" value={draft.checkCommand} onChange={(event) => updateDraft((current) => ({ ...current, checkCommand: event.target.value }))} placeholder="For example: npm test. The project is not done until it passes." />
                </label>
                <div className="ops-actions">
                  <UiButton type="button" className="primary-button" disabled={working || interview === 'loading' || goal.trim().length === 0} onClick={() => void start()}><Play size={14} /><span>{interview === 'loading' ? 'Reading your goal…' : 'Start crew'}</span></UiButton>
                  <label className="crew-ask-first" title="The Lead reads your goal, and any plan file it names, and asks a few questions before it plans"><Switch checked={askFirst === 'on'} onChange={(event) => setAskFirst(event.target.checked ? 'on' : 'off')} /><span>Ask me a few questions first</span></label>
                  <small>{draft.roles.length} roles · up to {draft.limits.maxSubAgents} sub-agents at once · {draft.limits.maxUsd > 0 ? `asks at ${money(draft.limits.maxUsd)}` : 'no spend limit'}</small>
                </div>
                <small className="crew-empty">Every agent on this crew is also told how you usually build and want things to look. See and change that under C1 Brain, How you build.</small>
              </section>
              {runs.length > 0 && (
                <section className="ops-panel crew-previous" aria-label="Previous crews">
                  <h3 className="crew-subheading">Previous crews</h3>
                  <ul className="crew-previous-list">
                    {runs.map((item) => {
                      const board = item.tasks.filter((task) => !task.proposed);
                      return (
                        <li key={item.id}>
                          <UiButton type="button" className="secondary-button" onClick={() => { setActiveRunId(item.id); setTab('board'); }}>
                            <strong>{crewTitle(item.goal)}</strong>
                            <Pill tone={RUN_STATUS[item.status].tone}>{RUN_STATUS[item.status].label}</Pill>
                            <small>{board.filter((task) => task.status === 'accepted').length} of {board.length} tasks · {relativeTime(item.startedAt)}</small>
                          </UiButton>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}
              <EmptyBoard />
              </>
            ))}

          {tab === 'crew' && (
            <CrewTab directApi={settings.directApi} config={config} readOnly={readOnly} capabilityOf={capabilityOf} agentCapabilities={agentCapabilities} onRole={updateRole} onAdd={addRole} onSaveDefault={() => void saveDefault()} onResetDefault={() => void resetDefault()}
              onRemove={(id) => updateDraft((current) => ({ ...current, roles: current.roles.filter((role) => role.id !== id) }))}
              onLimits={(patch) => updateDraft((current) => ({ ...current, limits: { ...current.limits, ...patch } }))} />
          )}
          {tab === 'design' && <DesignTab run={activeRun} design={design} onRead={(launch) => void readDesign(launch)} />}
          {tab === 'cost' && (
            <CostTab config={config} readOnly={readOnly} run={activeRun}
              onLimits={(patch) => updateDraft((current) => ({ ...current, limits: { ...current.limits, ...patch } }))}
              onSavings={(patch) => updateDraft((current) => ({ ...current, savings: { ...current.savings, ...patch } }))} />
          )}
          {tab === 'chat' && (activeRun
            ? <CrewChat run={activeRun} activity={<LiveActivity run={activeRun} />} working={working} onSend={sendMessage} onStopAsk={stopAsk} onKeepGoing={keepGoing} onExplainSimply={explainSimply} onFindPhases={findPhases} onDecide={decideApproval}
                onPause={() => void run(async () => unwrap(await window.kaiDesktop.pauseCrew(activeRun.id)))}
                onResume={() => void run(async () => unwrap(await window.kaiDesktop.resumeCrew(activeRun.id)))}
                onStop={() => void run(async () => unwrap(await window.kaiDesktop.stopCrew(activeRun.id)))}
                {...(onOpenConversation ? { onOpenConversation } : {})} />
            : <div className="empty-list">Start a crew to chat with its Lead.</div>)}
          {tab === 'report' && <ReportTab run={activeRun} />}
        </>
      )}
    </div>
  );
}

function RunBar({ run, working, onPause, onResume, onStop, onApprove }: { run: CrewRun; working: boolean; onPause: () => void; onResume: () => void; onStop: () => void; onApprove: () => void }): ReactNode {
  const board = run.tasks.filter((task) => !task.proposed);
  const accepted = board.filter((task) => task.status === 'accepted').length;
  const status = RUN_STATUS[run.status];
  const live = run.status === 'running' || run.status === 'planning';
  const { maxUsd } = run.config.limits;
  return (
    <section className="crew-runbar" aria-label="Run overview">
      <div className="crew-runbar-title">
        <Pill tone={status.tone} role="status">{status.label}</Pill>
        <strong title={run.goal}>{run.goal}</strong>
      </div>
      <dl className="crew-stats">
        <div><dt>Accepted</dt><dd>{accepted} of {board.length}</dd></div>
        <div><dt>Spent</dt><dd>{money(run.spentUsd)}{maxUsd > 0 ? ` of ${money(maxUsd)}` : ''}</dd></div>
        <div><dt>Roles</dt><dd>{run.config.roles.length}</dd></div>
      </dl>
      <small className="basis-full text-[var(--text-dim)]">{crewLimitPolicy(run.config.limits)}</small>
      <div className="crew-runbar-actions">
        {run.status === 'awaitingApproval' && <UiButton type="button" className="primary-button" disabled={working} onClick={onApprove}><Play size={14} /><span>Approve plan</span></UiButton>}
        {live && <UiButton type="button" className="secondary-button" disabled={working} onClick={onPause}><Pause size={14} /><span>Pause</span></UiButton>}
        {run.status === 'paused' && <UiButton type="button" className="primary-button" disabled={working} onClick={onResume}><Play size={14} /><span>Resume</span></UiButton>}
        {run.status !== 'completed' && run.status !== 'stopped' && <UiButton type="button" className="danger-button" disabled={working} onClick={onStop}><Square size={14} /><span>Stop</span></UiButton>}
      </div>
    </section>
  );
}

/** The board as it will look once the crew starts, so it is clear the work happens right here on this page. */
function EmptyBoard(): ReactNode {
  return (
    <section className="crew-preview" aria-label="Where the crew will work">
      <h3 className="crew-subheading"><Kanban size={13} /> Your board</h3>
      <small className="crew-empty">Press Start crew and the Lead writes the tasks here. You will see each task move across as it is built, checked, sent back or accepted, with a live feed beside it.</small>
      <div className="crew-board-wrap">
        <div className="crew-board">
          {COLUMNS.map((column) => (
            <section key={column.id} className="kanban-column" aria-label={column.label}>
              <h3>{column.label} <small>0</small></h3>
              <small className="crew-empty">Nothing here yet</small>
            </section>
          ))}
        </div>
        <aside className="crew-feed" aria-label="Live feed">
          <h3><Activity size={14} /><span>Live feed</span></h3>
          <small className="crew-empty">What each role is doing shows here, in plain sentences.</small>
        </aside>
      </div>
    </section>
  );
}

const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** One plain line for an agent event, or null for the ones that say nothing a person needs (most text, cost, snapshots). */
function describeEvent(event: PersistedEvent): string | null {
  switch (event.type) {
    case 'tool.call': {
      if (event.status === 'completed') return null;
      const input = event.input && typeof event.input === 'object' ? event.input as Record<string, unknown> : {};
      const hint = [input.file_path, input.path, input.pattern, input.command, input.url].find((value): value is string => typeof value === 'string' && value.length > 0);
      const name = event.name.replace(/^mcp__[^_]+(?:_[^_]+)*__/, '');
      if (event.status === 'failed') return `${name} did not work, trying another way`;
      return hint ? `${name}: ${hint.length > 70 ? `${hint.slice(0, 67)}…` : hint}` : `Using ${name}`;
    }
    case 'file.edit.applied': return `Edited ${baseName(event.filePath)}`;
    case 'file.change': return `${event.action === 'created' ? 'Created' : event.action === 'deleted' ? 'Deleted' : 'Edited'} ${baseName(event.path)}`;
    case 'text.delta': return event.channel === 'assistant' ? 'Writing its reply' : null;
    case 'agent.lifecycle': return event.status === 'starting' ? 'Starting the agent' : null;
    default: return null;
  }
}

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/**
 * Shows that the crew is alive: a moving bar, who is doing what, the agent's latest step, and how long since it last
 * did anything. A long step with no output says so, instead of looking the same as a crew that has hung.
 */
function LiveActivity({ run }: { run: CrewRun }): ReactNode {
  const [step, setStep] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const lastAt = useRef<number | null>(null);
  const live = run.liveConversations ?? [];
  const liveKey = live.join('|');

  useEffect(() => window.kaiDesktop.onAgentEvent(({ conversationId, event }) => {
    if (!live.includes(conversationId)) return;
    lastAt.current = Date.now();
    const text = describeEvent(event);
    if (text) setStep(text);
  }), [liveKey]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const roleLabel = (id: string): string => run.config.roles.find((role) => role.id === id)?.label ?? id;
  const titles = (statuses: CrewTask['status'][]): CrewTask[] => run.tasks.filter((task) => !task.proposed && statuses.includes(task.status));
  const building = titles(['building']);
  const reviewing = titles(['review']);
  const lead = run.config.roles.find((role) => role.kind === 'lead')?.label ?? 'The Lead';
  const headline = run.status === 'planning'
    ? `${lead} is reading the project and planning the tasks`
    : building.length > 0
      ? `${building.map((task) => `${roleLabel(task.role)} is building "${task.title}"`).join(' · ')}`
      : reviewing.length > 0
        ? `Checking ${reviewing.map((task) => `"${task.title}"`).join(', ')}`
        : `${lead} is choosing the next task`;
  const quiet = now - (lastAt.current ?? Date.parse(run.updatedAt));
  return (
    <div className="crew-live" role="status" aria-live="polite">
      <span className="crew-live-dot" aria-hidden="true" />
      <div className="crew-live-body">
        <strong>{headline}</strong>
        <small>{step ? `Now: ${step}` : 'Waiting for the agent to start answering…'}</small>
      </div>
      <small className="crew-live-time">
        {lastAt.current ? `Last activity ${elapsed(quiet)} ago` : `Working for ${elapsed(now - Date.parse(run.updatedAt))}`}
        {quiet > 90_000 && <><br />Still working. Long steps can run for minutes without output.</>}
      </small>
      <span className="crew-live-bar" aria-hidden="true" />
    </div>
  );
}

function Board({ run }: { run: CrewRun }): ReactNode {
  const board = run.tasks.filter((task) => !task.proposed);
  const roleLabel = (id: string): string => run.config.roles.find((role) => role.id === id)?.label ?? id;
  const working = run.status === 'running' || run.status === 'planning';
  if (run.status === 'planning' && board.length === 0) {
    return (
      <div className="crew-board-wrap">
        <LiveActivity run={run} />
      </div>
    );
  }
  return (
    <div className="crew-board-wrap">
      {working && <LiveActivity run={run} />}
      <div className="crew-board" role="list">
        {COLUMNS.map((column) => {
          const tasks = board.filter((task) => column.statuses.includes(task.status));
          return (
            <section key={column.id} className="kanban-column" role="listitem" aria-label={column.label}>
              <h3>{column.label} <small>{tasks.length}</small></h3>
              {tasks.map((task) => {
                const status = TASK_STATUS[task.status];
                const feedback = [...task.reviews].reverse().find((review) => review.verdict !== 'accept' && review.feedback);
                return (
                  <article key={task.id} className={`kanban-card crew-task ${task.status === 'needsYou' ? 'flag' : ''}`}>
                    <strong>{task.title}</strong>
                    <small>{roleLabel(task.role)}{task.round > 0 ? ` · round ${task.round}` : ''} · {task.acceptance.length} {task.acceptance.length === 1 ? 'criterion' : 'criteria'}</small>
                    {task.designRef && <small className="crew-design-ref"><Palette size={11} />{task.designRef}</small>}
                    {(task.status === 'sentBack' || task.status === 'needsYou') && feedback && <p className="crew-feedback">{feedback.reviewer}: {feedback.feedback}</p>}
                    <span className="crew-task-foot">
                      {task.status !== 'accepted' && task.status !== 'backlog' && <Pill tone={status.tone}>{status.label}</Pill>}
                      {task.costUsd > 0 && <small>{money(task.costUsd)}</small>}
                    </span>
                  </article>
                );
              })}
              {tasks.length === 0 && <small className="crew-empty">Nothing here</small>}
            </section>
          );
        })}
      </div>
      <LiveFeed run={run} />
    </div>
  );
}

const FEED_FIRST_PAGE = 15;
const FEED_PAGE = 25;

/**
 * The run's feed, kept short on screen: repeats fold into one line with a count, the newest lines show first and the
 * rest wait behind "Show earlier", and whatever is waiting on the user stays pinned above the list.
 */
function LiveFeed({ run }: { run: CrewRun }): ReactNode {
  const [shown, setShown] = useState(FEED_FIRST_PAGE);
  const groups = useMemo(() => collapseFeed(run.feed), [run.feed]);
  const visible = groups.slice(0, shown);
  const earlier = groups.length - visible.length;
  return (
    <aside className="crew-feed" aria-label="Live feed">
      <h3><Activity size={14} /><span>Live feed</span></h3>
      {run.status === 'needsYou' && run.ask && (
        <p className="crew-feed-pinned" role="status"><strong>Needs you</strong> {run.ask.message}</p>
      )}
      {run.feed.length === 0 && <small className="crew-empty">Nothing has happened yet.</small>}
      <ol>
        {visible.map(({ entry, count }) => (
          <li key={entry.id} className={`crew-feed-${entry.kind}`}>
            <span>{entry.text}{count > 1 && <em className="crew-feed-count"> ×{count}</em>}</span>
            <small>{entry.who} · {new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>
          </li>
        ))}
      </ol>
      {earlier > 0 && (
        <UiButton type="button" className="composer-text-button" onClick={() => setShown((current) => current + FEED_PAGE)}>
          Show {Math.min(earlier, FEED_PAGE)} earlier{earlier > FEED_PAGE ? ` (${earlier} in all)` : ''}
        </UiButton>
      )}
      {shown > FEED_FIRST_PAGE && (
        <UiButton type="button" className="composer-text-button" onClick={() => setShown(FEED_FIRST_PAGE)}>Show less</UiButton>
      )}
    </aside>
  );
}

function DesignTab({ run, design, onRead }: { run: CrewRun | null; design: CrewDesign | null; onRead: (launch: boolean) => void }): ReactNode {
  const view = run?.design ?? design;
  const tasks = (run?.tasks ?? []).filter((task) => !task.proposed);
  const forPage = (name: string, id: string): CrewTask[] => tasks.filter((task) => task.designRef && (task.designRef.toLowerCase() === name.toLowerCase() || task.designRef === id));
  const known = new Set((view?.pages ?? []).flatMap((page) => [page.name.toLowerCase(), page.id]));
  const undrawn = [...new Set(tasks.filter((task) => task.designRef && !known.has(task.designRef.toLowerCase()) && !known.has(task.designRef)).map((task) => task.designRef!))];
  const words: Record<CrewDesign['state'], string> = {
    running: 'Open Pencil is open.',
    'not-running': 'Open Pencil is not open. Open it to draw or to see the pages.',
    'not-configured': 'Open Pencil is not set up. Add it under Settings, Design tools.',
    'token-mismatch': 'Open Pencil refused KAI\'s token. Open it again to reconnect.',
    unreachable: 'Open Pencil is open but is not answering.',
  };
  return (
    <section className="ops-panel">
      <div className="ops-actions">
        <Pill tone={view?.state === 'running' ? 'success' : 'warning'}>{view ? words[view.state] : 'Looking…'}</Pill>
        <UiButton type="button" className="secondary-button" onClick={() => onRead(false)}><RefreshCw size={14} /><span>Check again</span></UiButton>
        {view && view.state !== 'running' && <UiButton type="button" className="primary-button" onClick={() => onRead(true)}><Palette size={14} /><span>Open Open Pencil</span></UiButton>}
      </div>
      <p className="tasks-tab-help">The Designer draws pages here and builders match them. Each page shows the task that builds it. A page with no task has not been planned yet.</p>
      {view && view.pages.length === 0 && view.state === 'running' && <div className="empty-list">Nothing is drawn yet. Add a Designer on the Crew tab and the Lead will plan the pages first.</div>}
      {view && view.pages.length > 0 && (
        <ul className="crew-spend">
          {view.pages.map((page) => {
            const linked = forPage(page.name, page.id);
            return (
              <li key={page.id}>
                <span><Palette size={13} /> {page.name}{linked.length === 0 && run && <small className="crew-empty"> · no task yet</small>}</span>
                <span className="crew-design-tasks">{linked.map((task) => <Pill key={task.id} tone={TASK_STATUS[task.status].tone}>{task.title}: {TASK_STATUS[task.status].label}</Pill>)}</span>
              </li>
            );
          })}
        </ul>
      )}
      {undrawn.length > 0 && (
        <>
          <h3 className="crew-subheading">Planned but not drawn yet</h3>
          <ul className="crew-list">{undrawn.map((name) => <li key={name}>{name}</li>)}</ul>
        </>
      )}
    </section>
  );
}

function CrewTab({ directApi, config, readOnly, capabilityOf, agentCapabilities, onRole, onAdd, onSaveDefault, onResetDefault, onRemove, onLimits }: {
  directApi: AppSettings['directApi'];
  config: CrewConfig;
  readOnly: boolean;
  capabilityOf: (agent: AgentId) => AgentCapability | undefined;
  agentCapabilities: AgentCapability[];
  onRole: (id: string, patch: Partial<CrewRole>) => void;
  onAdd: (kind: CrewRole['kind']) => void;
  onSaveDefault: () => void;
  onResetDefault: () => void;
  onRemove: (id: string) => void;
  onLimits: (patch: Partial<CrewConfig['limits']>) => void;
}): ReactNode {
  // Which providers have a key saved. Read when the tab opens and when the window regains focus, so a key added in Settings shows up.
  const [credentialIds, setCredentialIds] = useState<readonly string[]>([]);
  useEffect(() => {
    let alive = true;
    const load = (): void => {
      void window.kaiDesktop.credentialStatus().then(unwrap).then((status) => { if (alive) setCredentialIds(status.ids); }).catch(() => undefined);
    };
    load();
    window.addEventListener('focus', load);
    return () => { alive = false; window.removeEventListener('focus', load); };
  }, []);
  return (
    <section className="ops-panel">
      <p className="tasks-tab-help">{readOnly ? 'The crew is working, so its team is locked. Pause it to change a role’s agent or model; the change applies from its next task.' : 'Every role picks its own agent and where it runs. Reviewers and the Lead can only read; builders can change files.'}</p>
      <div className="crew-roles">
        {config.roles.map((role) => {
          const Icon = ROLE_ICON[role.kind];
          const capability = capabilityOf(role.agent);
          const access = roleAccess(role);
          const does = role.kind === 'custom' ? 'A role you defined. Choose whether it can change files.' : CREW_ROLE_INFO[role.kind].does;
          const proxyOk = Boolean(capability?.supportsRoutes.includes('proxy'));
          const choice = runsOn(role);
          // A role set to API but never given a provider uses the one chosen in Settings.
          const apiTarget: RoleTarget = { execution: 'api', api: role.api ?? { provider: directApi.provider } };
          const apiOptions = apiChoices(credentialIds, [apiTarget]);
          const apiTargetValue = targetValue(apiTarget);
          return (
            <article key={role.id} className={`crew-role ${role.kind === 'lead' ? 'lead' : ''}`}>
              <header>
                <span className="crew-role-icon" aria-hidden="true"><Icon size={16} /></span>
                {role.kind === 'custom' && !readOnly
                  ? <UiTextInput aria-label="Role name" value={role.label} onChange={(event) => onRole(role.id, { label: event.target.value })} />
                  : <h3>{role.label}</h3>}
                <Pill tone={access === 'edit' ? 'warning' : 'neutral'}>{access === 'edit' ? <Pencil size={11} /> : <Lock size={11} />}{access === 'edit' ? 'Can edit files' : 'Read only'}</Pill>
                {role.kind !== 'lead' && !readOnly && <UiButton type="button" className="icon-button" aria-label={`Remove ${role.label}`} onClick={() => onRemove(role.id)}><Trash2 size={14} /></UiButton>}
              </header>
              <p className="crew-role-does">{does}</p>
              {role.kind === 'designer' && <p className="crew-role-does">Draws with the design provider chosen under Settings, Design tools, so the agent and Runs on below are not used for drawing.</p>}
              <div className="crew-role-fields">
                {choice === 'api' ? (
                  <label className="workflow-field"><span>Provider</span>
                    <Select aria-label={`${role.label} provider`} disabled={readOnly} value={apiTargetValue} onChange={(event) => {
                      const next = targetFromValue(event.target.value, apiTarget);
                      if (next?.api) onRole(role.id, { api: next.api, route: 'direct', model: undefined });
                    }}>
                      {apiOptions.map((item) => <option key={`${item.provider}:${item.credentialId}`} value={`api:${item.provider}:${item.credentialId}`}>{item.label}{item.local ? ' (on this computer)' : item.keySaved ? '' : ' (no key saved)'}</option>)}
                    </Select>
                  </label>
                ) : (
                  <label className="workflow-field"><span>Agent</span>
                    <Select aria-label={`${role.label} agent`} disabled={readOnly} value={role.agent} onChange={(event) => onRole(role.id, { agent: event.target.value as AgentId, route: 'direct', model: undefined })}>
                      {agentCapabilities.map((item) => <option key={item.id} value={item.id} disabled={!item.available}>{item.displayName}{item.available ? '' : ` (${item.unavailableReason ?? 'not set up'})`}</option>)}
                    </Select>
                  </label>
                )}
                <label className="workflow-field"><span>Runs on</span>
                  <Select aria-label={`${role.label} runs on`} disabled={readOnly} value={choice} onChange={(event) => {
                    const next = event.target.value as RunsOn;
                    onRole(role.id, {
                      execution: next === 'api' ? 'api' : 'cli', route: next === 'cli-proxy' ? 'proxy' : 'direct', model: undefined,
                      ...(next === 'api' && !role.api ? { api: apiTarget.api } : {}),
                    });
                  }}>
                    <option value="cli">Subscription (CLI)</option>
                    <option value="api">API (direct)</option>
                    {(proxyOk || choice === 'cli-proxy') && <option value="cli-proxy">Proxy (CLI)</option>}
                  </Select>
                </label>
                <ModelField labelClassName="workflow-field crew-field-wide" label="Model" disabled={readOnly} value={role.model ?? ''} models={choice === 'api' ? directProviderPreset(apiTarget.api!.provider).models : CLI_MODEL_SUGGESTIONS[role.agent]} emptyLabel={choice === 'api' ? 'Default for this provider' : 'Default for this agent'} onChange={(value) => onRole(role.id, { model: value.trim() || undefined })} />
              </div>
              <div className="crew-subagents">
                <span><strong>Sub-agents</strong><small>{role.subAgents.max === 0 ? 'Works alone' : `Up to ${role.subAgents.max} helpers on a task`}</small></span>
                <span className="crew-stepper">
                  <UiButton type="button" className="icon-button" aria-label={`Fewer sub-agents for ${role.label}`} disabled={readOnly || role.subAgents.max <= 0} onClick={() => onRole(role.id, { subAgents: { ...role.subAgents, max: role.subAgents.max - 1 } })}><Minus size={14} /></UiButton>
                  <output aria-live="polite">{role.subAgents.max}</output>
                  <UiButton type="button" className="icon-button" aria-label={`More sub-agents for ${role.label}`} disabled={readOnly || role.subAgents.max >= MAX_SUB_AGENTS_PER_ROLE} onClick={() => onRole(role.id, { subAgents: { ...role.subAgents, max: role.subAgents.max + 1 } })}><Plus size={14} /></UiButton>
                </span>
              </div>
            </article>
          );
        })}
        {!readOnly && config.roles.length < MAX_CREW_ROLES && (
          <div className="crew-add-role">
            <Plus size={16} aria-hidden="true" />
            <strong>Add a role</strong>
            <Select aria-label="Add a role" value="" onChange={(event) => { if (event.target.value) onAdd(event.target.value as CrewRole['kind']); }}>
              <option value="">Choose a role…</option>
              {CREW_ROLE_KINDS.filter((kind) => kind !== 'lead' && (kind === 'custom' || kind === 'builder' || kind === 'reviewer' || !config.roles.some((role) => role.kind === kind))).map((kind) => <option key={kind} value={kind}>{kind === 'custom' ? 'Your own role' : CREW_ROLE_INFO[kind].label}</option>)}
            </Select>
          </div>
        )}
      </div>
      <div className="crew-limits-row">
        <label className="workflow-field"><span>Sub-agents at once, whole crew</span>
          <UiTextInput type="number" min={0} max={24} disabled={readOnly} value={config.limits.maxSubAgents} onChange={(event) => onLimits({ maxSubAgents: clampInt(event.target.value, 0, 24) })} />
        </label>
      </div>
      {!readOnly && (
        <div className="ops-actions">
          <UiButton type="button" className="secondary-button" onClick={onSaveDefault}><Save size={14} /><span>Save as my default</span></UiButton>
          <UiButton type="button" className="secondary-button" onClick={onResetDefault}><RotateCcw size={14} /><span>Back to built-in</span></UiButton>
          <small>Saved roles, agents, limits and cost settings are used for every new crew in this project.</small>
        </div>
      )}
    </section>
  );
}

function CostTab({ config, readOnly, run, onLimits, onSavings }: {
  config: CrewConfig;
  readOnly: boolean;
  run: CrewRun | null;
  onLimits: (patch: Partial<CrewConfig['limits']>) => void;
  onSavings: (patch: Partial<CrewConfig['savings']>) => void;
}): ReactNode {
  const spendByRole = useMemo(() => {
    const totals = new Map<string, number>();
    for (const task of run?.tasks ?? []) totals.set(task.role, (totals.get(task.role) ?? 0) + task.costUsd);
    return [...totals.entries()].sort((a, b) => b[1] - a[1]);
  }, [run]);
  const savings: ReadonlyArray<{ key: keyof CrewConfig['savings']; title: string; detail: string }> = [
    { key: 'workFromBoard', title: 'Work from the board, not the chat history', detail: 'Each agent gets its task, the criteria and a board summary.' },
    { key: 'lightModelForRoutine', title: 'Lighter model for routine tasks', detail: 'Planning and review stay on your chosen models; simple builds can use less.' },
    { key: 'skipUnchangedReview', title: 'Skip re-review of unchanged work', detail: 'An accepted task is not checked again unless its files change.' },
    { key: 'stopOnRepeatedFailure', title: 'Stop on a repeated failure', detail: 'Ask you once the same task fails for the same reason twice.' },
  ];
  return (
    <section className="ops-panel">
      <p className="tasks-tab-help">Limits are checked between tasks. Ask mode offers Continue or Finish; Finish mode stops with accepted work. No task is cut off halfway. Zero means no limit.</p>
      <div className="crew-limits">
        <label className="workflow-field"><span>Spend limit (USD)</span><UiTextInput type="number" min={0} step={1} disabled={readOnly} value={config.limits.maxUsd} onChange={(event) => onLimits({ maxUsd: Math.max(0, Number(event.target.value) || 0) })} /></label>
        <label className="workflow-field"><span>Time limit (minutes)</span><UiTextInput type="number" min={0} disabled={readOnly} value={config.limits.maxMinutes} onChange={(event) => onLimits({ maxMinutes: clampInt(event.target.value, 0, 1440) })} /></label>
        <label className="workflow-field"><span>Send-backs per task</span><UiTextInput type="number" min={1} max={10} disabled={readOnly} value={config.limits.maxSendBacks} onChange={(event) => onLimits({ maxSendBacks: clampInt(event.target.value, 1, 10) })} /></label>
        <label className="workflow-field"><span>When a limit is reached</span>
          <Select aria-label="When a limit is reached" disabled={readOnly} value={config.limits.onLimit} onChange={(event) => onLimits({ onLimit: event.target.value as 'ask' | 'finish' })}>
            <option value="ask">Ask me: Continue or Finish</option>
            <option value="finish">Finish with what is accepted</option>
          </Select>
        </label>
      </div>
      <h3 className="crew-subheading">Ways the crew saves money</h3>
      {savings.map((item) => (
        <label key={item.key} className="toggle-row"><span><strong>{item.title}</strong><small>{item.detail}</small></span>
          <Switch checked={config.savings[item.key]} disabled={readOnly} onChange={(event) => onSavings({ [item.key]: event.target.checked })} />
        </label>
      ))}
      {run && (
        <>
          <h3 className="crew-subheading">Where the money went</h3>
          {spendByRole.length === 0 ? <small className="crew-empty">Nothing spent yet.</small> : (
            <ul className="crew-spend">{spendByRole.map(([role, cost]) => <li key={role}><span>{run.config.roles.find((item) => item.id === role)?.label ?? role}</span><strong>{money(cost)}</strong></li>)}</ul>
          )}
        </>
      )}
    </section>
  );
}

function ReportTab({ run }: { run: CrewRun | null }): ReactNode {
  if (!run) return <div className="empty-list">The report appears here once a crew has run.</div>;
  const report = buildReport(run);
  return (
    <section className="ops-panel crew-report">
      <h2>{report.headline}</h2>
      <p className="tasks-tab-help">{run.status === 'completed' ? 'Finished' : 'So far'} · {report.totals.accepted} of {report.totals.tasks} tasks accepted · {report.totals.files} files changed · {money(report.totals.costUsd)} · {report.totals.minutes} min</p>
      <ReportList title="What was built" items={report.built} empty="Nothing accepted yet." />
      <ReportList title="What was verified" items={report.verified} empty="Nothing checked yet." />
      {report.verdicts.length > 0 && (
        <>
          <h3 className="crew-subheading">Reviewer verdicts</h3>
          <ul className="crew-spend">{report.verdicts.map((verdict, index) => <li key={`${verdict.role}-${index}`}><span>{verdict.role}: {verdict.note}</span><Pill tone={verdict.verdict === 'ship' ? 'success' : 'error'}>{verdict.verdict === 'ship' ? 'Ship' : 'No ship'}</Pill></li>)}</ul>
        </>
      )}
      <ReportList title="Open risks" items={report.openRisks} empty="None recorded." />
    </section>
  );
}

function ReportList({ title, items, empty }: { title: string; items: string[]; empty: string }): ReactNode {
  return (
    <>
      <h3 className="crew-subheading">{title}</h3>
      {items.length === 0 ? <small className="crew-empty">{empty}</small> : <ul className="crew-list">{items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>}
    </>
  );
}

function clampInt(raw: string, min: number, max: number): number {
  const value = Math.round(Number(raw));
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
