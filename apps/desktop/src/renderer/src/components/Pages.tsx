import {
  Activity,
  AlertTriangle,
  AppWindow,
  Archive,
  ArchiveRestore,
  Brain,
  Code2,
  Clock3,
  Copy,
  FolderKanban,
  FolderOpen,
  GitBranch,
  GitFork,
  KeyRound,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Route,
  Save,
  Search,
  Settings,
  ShieldAlert,
  Square,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  AgentCapability,
  AgentId,
  AppSettings,
  AutonomyMode,
  ConversationRecord,
  ExecutionMode,
  ProjectRecord,
  RouteMode,
  ServiceState,
  TeamPlanDraft,
  WorkflowRun,
  WorkflowStep,
  WorkflowTemplate,
} from '@kai/contracts';
import { relativeTime, statusLabel, unwrap } from '../types';
import { confirmDialog, promptDialog } from './AppDialog';
import { TeamPanel } from './TeamPanel';
import { Pill } from './Pill';

import { Select } from './ui/Select';
import { UiButton } from './UiButton';
import { Checkbox, Textarea } from 'flowbite-react';
import { UiTextInput } from './UiTextInput';
export function ProjectsView({
  projects,
  activeProjectId,
  onChoose,
  onOpen,
  onOpenInNewWindow,
  onRemove,
}: {
  projects: ProjectRecord[];
  activeProjectId: string | null;
  onChoose: () => void;
  onOpen: (id: string, destination: 'workspace' | 'code') => void;
  onOpenInNewWindow: (id: string) => void;
  onRemove: (id: string) => void;
}): ReactNode {
  return (
    <div className="page-view">
      <PageHeader
        title="Projects"
        detail={`${projects.length} local ${projects.length === 1 ? 'project' : 'projects'}`}
      >
        <UiButton type="button" className="primary-button" onClick={onChoose}>
          <Plus size={16} />
          <span>Open project</span>
        </UiButton>
      </PageHeader>
      <div className="project-grid">
        {projects.map((project) => (
          <article key={project.id} className={`project-card ${project.id === activeProjectId ? 'active' : ''}`}>
            <div className="project-card-icon">{project.name.slice(0, 1).toUpperCase()}</div>
            <div className="project-card-copy">
              <div className="project-card-title">
                <strong>{project.name}</strong>
                {project.id === activeProjectId && <Pill tone="info">Active</Pill>}
              </div>
              <span className="mono truncate">{project.path}</span>
              <small>Last opened {relativeTime(project.lastOpenedAt)}</small>
            </div>
            <div className="project-card-actions">
              <UiButton type="button" className="secondary-button" onClick={() => onOpen(project.id, 'workspace')} title={`Open ${project.name} in the composer`}>
                <MessageSquare size={14} />
                <span>Composer</span>
              </UiButton>
              <UiButton type="button" className="secondary-button" onClick={() => onOpen(project.id, 'code')} title={`Open ${project.name} in the editor`}>
                <Code2 size={14} />
                <span>Editor</span>
              </UiButton>
              <UiButton
                type="button"
                className="icon-button"
                onClick={() => onOpenInNewWindow(project.id)}
                title={`Open ${project.name} in a new window`}
                aria-label={`Open ${project.name} in a new window`}
              >
                <AppWindow size={15} />
              </UiButton>
              <UiButton
                type="button"
                className="icon-button"
                onClick={() => onRemove(project.id)}
                title="Remove project"
                aria-label="Remove project"
              >
                <Trash2 size={15} />
              </UiButton>
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
        <UiButton type="button" className="secondary-button" onClick={onConfigure}>
          <Settings size={15} />
          <span>Configure</span>
        </UiButton>
        {running ? (
          <UiButton type="button" className="secondary-button" disabled={busy} onClick={onStop}>
            <Square size={13} />
            <span>Stop</span>
          </UiButton>
        ) : (
          <UiButton type="button" className="primary-button" disabled={busy} onClick={onStart}>
            <Play size={14} />
            <span>Start</span>
          </UiButton>
        )}
        <UiButton type="button" className="secondary-button" disabled={busy || !running} onClick={onRestart}>
          <RotateCcw size={14} />
          <span>Restart</span>
        </UiButton>
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
        <UiButton
          type="button"
          className="secondary-button"
          disabled={busy || !service.tokenStored}
          onClick={onCopyToken}
        >
          <Copy size={14} />
          <span>Copy access token</span>
        </UiButton>
        <UiButton type="button" className="secondary-button" disabled={busy} onClick={onRotateToken}>
          <RefreshCw size={14} />
          <span>Rotate access token</span>
        </UiButton>
      </div>
      {children}
    </div>
  );
}

interface WorkflowDraftStep {
  id: string;
  agent: AgentId;
  prompt: string;
  label: string;
  // Left out, the step follows the workflow's execution and route.
  execution?: ExecutionMode;
  route?: RouteMode;
  status: WorkflowStep['status'];
  output?: string;
  error?: string;
  role?: WorkflowStep['role'];
  verdict?: WorkflowStep['verdict'];
  isolated?: boolean;
  note?: string;
}

type WorkflowStyle = 'fast' | 'safe' | 'security' | 'learning';

function usesDeepSeekApi(settings: AppSettings): boolean {
  return settings.directApi.enabled && settings.directApi.provider === 'deepseek';
}

function preferredArchitect(agents: readonly AgentCapability[], fallback: AgentId): AgentId {
  return (['claude', 'codex'] as const).map((id) => agents.find((agent) => agent.id === id && agent.available)?.id).find(Boolean) ?? fallback;
}

function preferredImplementer(agents: readonly AgentCapability[], settings: AppSettings): AgentId {
  if (usesDeepSeekApi(settings)) return settings.defaultAgent;
  return agents.find((agent) => agent.id === 'kimi' && agent.available)?.id ?? settings.defaultAgent;
}

const WORKFLOW_STYLES: ReadonlyArray<{ id: WorkflowStyle; label: string; detail: string }> = [
  { id: 'fast', label: 'Fast', detail: 'One builder, then a focused review' },
  { id: 'safe', label: 'Safe', detail: 'Plan, build, then review' },
  { id: 'security', label: 'Security', detail: 'Architecture, build, security review, checks' },
  { id: 'learning', label: 'Learning-first', detail: 'Plan in small steps and explain decisions' },
];

export function WorkflowsView({
  activeProject,
  agentCapabilities,
  settings,
  busy,
  incomingPlan,
  onIncomingPlanUsed,
}: {
  activeProject: ProjectRecord | null;
  agentCapabilities: AgentCapability[];
  settings: AppSettings;
  busy: boolean;
  incomingPlan?: TeamPlanDraft | null;
  onIncomingPlanUsed?: () => void;
}): ReactNode {
  const [title, setTitle] = useState('Untitled workflow');
  const [steps, setSteps] = useState<WorkflowDraftStep[]>([
    { id: 'step_0', agent: preferredArchitect(agentCapabilities, settings.defaultAgent), prompt: '', label: 'Step 1', status: 'pending' },
  ]);
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [execution, setExecution] = useState<ExecutionMode>('cli');
  const [route, setRoute] = useState<RouteMode>('direct');
  const [autonomy, setAutonomy] = useState<AutonomyMode>(settings.defaultAutonomy);
  const [model, setModel] = useState('');
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [loopRounds, setLoopRounds] = useState(3);
  const [loopCost, setLoopCost] = useState(0);
  const [loopMinutes, setLoopMinutes] = useState(30);
  const [loopCheck, setLoopCheck] = useState('');
  const [error, setError] = useState<string | null>(null);
  const activeRun = runs.find((run) => run.workflow.id === activeRunId) ?? null;
  const running = activeRun?.workflow.status === 'running';
  // A blocked security review waits for the user's decision instead of offering a plain Resume.
  const blockedStep = activeRun?.workflow.status === 'paused'
    ? activeRun.workflow.steps.find((step) => step.verdict?.result === 'block' && !step.verdict.acknowledged)
    : undefined;
  const decisionRef = useRef<HTMLElement | null>(null);
  const blockedStepId = blockedStep?.id;
  // The decision sits at the top of the page; bring it into view so a job that stopped is never missed.
  useEffect(() => {
    if (blockedStepId) decisionRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [blockedStepId]);
  // A team whose check ran out of fix rounds has no unfinished step, but can still be given one more round.
  const checkExhausted = activeRun?.workflow.teamCheck?.stopReason === 'max_rounds' && activeRun.workflow.status === 'paused';
  const resumable = !blockedStep && Boolean(activeRun && activeRun.workflow.status !== 'completed' && activeRun.workflow.status !== 'running'
    && (checkExhausted
      || Boolean(activeRun.workflow.notice)
      || activeRun.workflow.steps.some((step) => step.status !== 'completed')
      || (activeRun.workflow.loop.enabled && (activeRun.workflow.loopProgress?.round ?? 0) < activeRun.workflow.loop.maxRounds)));

  function reconcileRun(run: WorkflowRun): void {
    setRuns((current) => [run, ...current.filter((item) => item.workflow.id !== run.workflow.id)]
      .sort((left, right) => right.workflow.createdAt.localeCompare(left.workflow.createdAt)));
  }

  useEffect(() => {
    void window.kaiDesktop.listWorkflowTemplates(activeProject?.id).then(unwrap).then(setTemplates).catch(() => undefined);
    void window.kaiDesktop.listWorkflowRuns(activeProject?.id).then(unwrap).then((loaded) => {
      setRuns(loaded);
      setActiveRunId((current) => current && loaded.some((run) => run.workflow.id === current)
        ? current
        : loaded.find((run) => run.workflow.status === 'running' || run.workflow.status === 'paused' || run.workflow.status === 'aborted')?.workflow.id
          ?? loaded[0]?.workflow.id
          ?? null);
    }).catch((caught) => setError(messageOf(caught)));
  }, [activeProject?.id]);

  useEffect(() => window.kaiDesktop.onWorkflowChanged((run) => {
    if ((run.projectId ?? null) !== (activeProject?.id ?? null)) return;
    reconcileRun(run);
    setActiveRunId((current) => current ?? run.workflow.id);
  }), [activeProject?.id]);

  useEffect(() => {
    if (!activeRun) return;
    setTitle(activeRun.workflow.title);
    setExecution(activeRun.workflow.execution);
    setRoute(activeRun.workflow.route);
    setAutonomy(activeRun.workflow.autonomy);
    setModel(activeRun.workflow.model ?? '');
    setLoopEnabled(activeRun.workflow.loop.enabled);
    setLoopRounds(activeRun.workflow.loop.maxRounds);
    setLoopCost(activeRun.workflow.loop.maxCostUsd);
    setLoopMinutes(activeRun.workflow.loop.maxDurationMinutes);
    setLoopCheck(activeRun.workflow.loop.checkCommand);
    setSteps(activeRun.workflow.steps.map((step) => ({
      id: step.id,
      agent: step.agent,
      prompt: step.prompt,
      label: step.label ?? 'Step',
      ...(step.execution ? { execution: step.execution } : {}),
      ...(step.route ? { route: step.route } : {}),
      status: step.status,
      ...(step.output ? { output: step.output } : {}),
      ...(step.error ? { error: step.error } : {}),
      ...(step.role ? { role: step.role } : {}),
      ...(step.verdict ? { verdict: step.verdict } : {}),
      ...(step.isolated ? { isolated: true } : {}),
      ...(step.note ? { note: step.note } : {}),
    })));
  }, [activeRun]);

  // API steps can always use the proxy; a CLI step only when that CLI supports it.
  function proxyCapable(agent: AgentId, stepExecution: ExecutionMode): boolean {
    return stepExecution === 'api' || Boolean(agentCapabilities.find((item) => item.id === agent)?.supportsRoutes.includes('proxy'));
  }

  function executionOf(step: WorkflowDraftStep): ExecutionMode {
    return step.execution ?? execution;
  }

  /** The route a step runs on: its own choice, else the workflow's, and Direct when its agent cannot use the proxy. */
  function routeOf(step: WorkflowDraftStep): RouteMode {
    return proxyCapable(step.agent, executionOf(step)) ? step.route ?? route : 'direct';
  }

  function addStep(): void {
    setSteps((current) => [...current, {
      id: `step_${crypto.randomUUID()}`,
      agent: preferredImplementer(agentCapabilities, settings),
      prompt: '',
      label: `Step ${current.length + 1}`,
      ...(usesDeepSeekApi(settings) ? { execution: 'api' as const, route: 'direct' as const } : {}),
      status: 'pending',
    }]);
  }

  function applyWorkflowStyle(style: WorkflowStyle): void {
    const available = agentCapabilities.filter((agent) => agent.available).map((agent) => agent.id);
    const architect = preferredArchitect(agentCapabilities, settings.defaultAgent);
    const implementer = preferredImplementer(agentCapabilities, settings);
    const reviewer = agentCapabilities.find((agent) => agent.id === architect && agent.available)?.id ?? available[0] ?? settings.defaultAgent;
    const makeStep = (agent: AgentId, label: string, prompt: string, execution?: 'api' | 'cli'): WorkflowDraftStep => ({
      id: `step_${crypto.randomUUID()}`, agent, label, prompt, status: 'pending',
      ...(execution ? { execution, route: 'direct' as const } : {}),
    });
    const styles: Record<WorkflowStyle, { title: string; autonomy: AutonomyMode; steps: WorkflowDraftStep[] }> = {
      fast: {
        title: 'Fast build and review', autonomy: 'autoEdit', steps: [
          makeStep(implementer, 'Builder', 'Implement the requested change. Keep the change focused, explain important decisions, and run the most relevant checks.', usesDeepSeekApi(settings) ? 'api' : 'cli'),
          makeStep(reviewer, 'Reviewer', 'Review the preceding work. Check correctness, changed files, edge cases, and verification results. Report issues clearly; do not edit unless needed to fix a confirmed problem.'),
        ],
      },
      safe: {
        title: 'Plan, build, review', autonomy: 'ask', steps: [
          makeStep(architect, 'Planner', 'Inspect the project and produce a concrete implementation plan. Identify files, risks, architecture impact, and verification steps. Do not edit files.'),
          makeStep(implementer, 'Builder', 'Use the approved plan from the preceding step. Implement the smallest correct change and run the relevant checks.', usesDeepSeekApi(settings) ? 'api' : 'cli'),
          makeStep(reviewer, 'Reviewer', 'Review the completed change against the plan. Check the diff, regressions, tests, and any remaining risks. Give a clear ship/no-ship recommendation.'),
        ],
      },
      security: {
        title: 'Security-sensitive change', autonomy: 'ask', steps: [
          makeStep(architect, 'Architecture reviewer', 'Inspect the requested change. Identify trust boundaries, data flows, permissions, secrets, and abuse cases. Produce a plan; do not edit files.'),
          makeStep(implementer, 'Builder', 'Implement the approved plan with least-privilege access, validation, safe error handling, and relevant tests.', usesDeepSeekApi(settings) ? 'api' : 'cli'),
          makeStep(reviewer, 'Security reviewer', 'Review the change for authentication, authorization, input validation, secret handling, data exposure, dependency risk, and unsafe defaults. Do not edit files.'),
          makeStep(reviewer, 'Verifier', 'Run the relevant checks and inspect the final diff. State what was verified, what remains uncertain, and whether it is safe to ship.'),
        ],
      },
      learning: {
        title: 'Learning-first build', autonomy: 'ask', steps: [
          makeStep(architect, 'Teacher and planner', 'Explain the relevant architecture and security concepts in simple terms. Propose a small, staged plan and one question the learner can answer before building. Do not edit files.'),
          makeStep(implementer, 'Pair builder', 'Implement only the next small stage. Explain what changed, why, and how it fits the architecture. Stop after that stage and leave a clear next step.', usesDeepSeekApi(settings) ? 'api' : 'cli'),
          makeStep(reviewer, 'Teacher reviewer', 'Review the change with the learner in mind. Explain the architecture, security implications, trade-offs, and a small way to verify understanding.'),
        ],
      },
    };
    const selection = styles[style];
    setTitle(selection.title);
    setSteps(selection.steps);
    setAutonomy(selection.autonomy);
    setLoopEnabled(false);
    setError(null);
  }

  async function saveTemplate(): Promise<void> {
    if (!steps.some((step) => step.prompt.trim())) return;
    const now = new Date().toISOString();
    try {
      const template = await window.kaiDesktop.saveWorkflowTemplate({
        id: `workflow_${crypto.randomUUID()}`,
        name: title.trim() || 'Untitled workflow',
        description: '',
        steps: steps.filter((step) => step.prompt.trim()).map((step) => ({ agent: step.agent, prompt: step.prompt.trim(), label: step.label, ...(step.execution ? { execution: step.execution } : {}), ...(step.route ? { route: step.route } : {}) })),
        execution,
        route,
        model: model.trim() || undefined,
        autonomy,
        loop: { enabled: loopEnabled, maxRounds: loopRounds, maxCostUsd: loopCost, maxDurationMinutes: loopMinutes, checkCommand: loopCheck.trim() },
        createdAt: now,
      }).then(unwrap);
      setTemplates((current) => [...current.filter((item) => item.id !== template.id), template].sort((left, right) => left.name.localeCompare(right.name)));
      setError(null);
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  async function removeTemplate(id: string): Promise<void> {
    try {
      await window.kaiDesktop.deleteWorkflowTemplate(id).then(unwrap);
      setTemplates((current) => current.filter((template) => template.id !== id));
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  async function startWorkflow(): Promise<void> {
    if (!activeProject || running) return;
    const executable = steps.filter((step) => step.prompt.trim());
    if (executable.length === 0) return;
    setError(null);
    try {
      const run = await window.kaiDesktop.startWorkflow({
        projectId: activeProject.id,
        title: title.trim() || 'Untitled workflow',
        execution,
        route,
        autonomy,
        loop: { enabled: loopEnabled, maxRounds: loopRounds, maxCostUsd: loopCost, maxDurationMinutes: loopMinutes, checkCommand: loopCheck.trim() },
        ...(model.trim() ? { model: model.trim() } : {}),
        steps: executable.map((step) => ({
          id: step.id,
          agent: step.agent,
          prompt: step.prompt.trim(),
          label: step.label,
          execution: executionOf(step),
          route: routeOf(step),
        })),
      }).then(unwrap);
      reconcileRun(run);
      setActiveRunId(run.workflow.id);
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  async function stopWorkflow(): Promise<void> {
    if (!activeRun) return;
    try {
      reconcileRun(await window.kaiDesktop.stopWorkflow(activeRun.workflow.id).then(unwrap));
      setError(null);
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  async function resumeWorkflow(): Promise<void> {
    if (!activeRun) return;
    try {
      reconcileRun(await window.kaiDesktop.resumeWorkflow(activeRun.workflow.id).then(unwrap));
      setError(null);
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  return (
    <div className="page-view">
      <PageHeader title="Workflows" detail="Build, save, and run sequential multi-agent work">
        <UiButton type="button" className="secondary-button" disabled={busy || running || !steps.some((step) => step.prompt.trim())} onClick={() => void saveTemplate()}><Save size={15} /><span>Save template</span></UiButton>
        {running ? (
          <UiButton type="button" className="secondary-button" disabled={busy} onClick={() => void stopWorkflow()}><Square size={13} /><span>Stop</span></UiButton>
        ) : resumable ? (
          <UiButton type="button" className="secondary-button" disabled={busy} onClick={() => void resumeWorkflow()}><RotateCcw size={14} /><span>Resume</span></UiButton>
        ) : null}
        <UiButton type="button" className="primary-button" disabled={busy || running || !activeProject || !steps.some((step) => step.prompt.trim())} onClick={() => void startWorkflow()}><Play size={15} /><span>{running ? 'Running' : 'Run workflow'}</span></UiButton>
      </PageHeader>
      {error && <div className="rules-error"><span>{error}</span></div>}
      {blockedStep?.verdict && (
        <section className="team-decision" role="alert" aria-label="Security review decision" ref={decisionRef}>
          <ShieldAlert size={20} />
          <div className="team-decision-copy">
            <strong>The security review stopped this job</strong>
            <span>{blockedStep.verdict.reason || 'The reviewer found a serious problem.'}</span>
            <small>{blockedStep.label ?? 'Security review'} was done by {blockedStep.agent}. Nothing after it has run.</small>
            {blockedStep.output && <details><summary>Read the full review</summary><pre>{blockedStep.output}</pre></details>}
          </div>
          <div className="team-decision-actions">
            <UiButton type="button" className="secondary-button" disabled={busy} onClick={() => void stopWorkflow()}><Square size={13} /><span>Stop the job</span></UiButton>
            <UiButton type="button" className="primary-button" disabled={busy} onClick={() => void resumeWorkflow()}><Play size={14} /><span>Continue anyway</span></UiButton>
          </div>
        </section>
      )}
      {activeRun?.workflow.notice && (
        <div className="workflow-notice" role="status">
          <AlertTriangle size={16} />
          <span>{activeRun.workflow.notice}</span>
        </div>
      )}
      <TeamPanel
        activeProject={activeProject}
        agentCapabilities={agentCapabilities}
        settings={settings}
        busy={busy}
        running={running}
        incomingPlan={incomingPlan}
        onIncomingPlanUsed={onIncomingPlanUsed}
        onStarted={(run) => {
          reconcileRun(run);
          setActiveRunId(run.workflow.id);
        }}
      />
      {runs.length > 0 && (
        <div className="workflow-run-list" aria-label="Workflow runs">
          {runs.slice(0, 8).map((run) => (
            <UiButton key={run.workflow.id} type="button" className={run.workflow.id === activeRunId ? 'active' : ''} onClick={() => setActiveRunId(run.workflow.id)}>
              <span className="truncate">{run.workflow.title}</span>
              <small className={`workflow-status ${run.workflow.status}`}>{run.workflow.status}</small>
            </UiButton>
          ))}
        </div>
      )}
      <div className="workflow-builder">
        <section className="workflow-styles" aria-label="Multi-agent work styles">
          <div><strong>Choose a work style</strong><small>KAI assigns clear roles; you can edit every step before running.</small></div>
          <div className="workflow-style-options">
            {WORKFLOW_STYLES.map((style) => <UiButton key={style.id} type="button" disabled={running} onClick={() => applyWorkflowStyle(style.id)}><strong>{style.label}</strong><small>{style.detail}</small></UiButton>)}
          </div>
        </section>
        <div className="workflow-builder-head">
          <label className="workflow-field" htmlFor="workflow-title">
            <span>Workflow name</span>
            <UiTextInput id="workflow-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Untitled workflow" />
          </label>
          <label className="workflow-field" htmlFor="workflow-template">
            <span>Saved template</span>
            <Select
              id="workflow-template"
              defaultValue=""
              disabled={templates.length === 0}
              onChange={(event) => {
                const template = templates.find((item) => item.id === event.target.value);
                if (!template) return;
                setTitle(template.name);
                setSteps(template.steps.map((step, index) => ({ id: `step_${crypto.randomUUID()}`, agent: step.agent, prompt: step.prompt, label: step.label ?? `Step ${index + 1}`, ...(step.execution ? { execution: step.execution } : {}), ...(step.route ? { route: step.route } : {}), status: 'pending' })));
                setExecution(template.execution);
                setRoute(template.route);
                setAutonomy(template.autonomy);
                setModel(template.model ?? '');
                setLoopEnabled(template.loop.enabled);
                setLoopRounds(template.loop.maxRounds);
                setLoopCost(template.loop.maxCostUsd);
                setLoopMinutes(template.loop.maxDurationMinutes);
                setLoopCheck(template.loop.checkCommand);
                event.target.value = '';
              }}
            >
              <option value="">{templates.length > 0 ? 'Load a template' : 'No saved templates'}</option>
              {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
            </Select>
          </label>
        </div>
        <div className="workflow-builder-head workflow-run-options">
          <label className="workflow-field" htmlFor="workflow-execution"><span>Default execution</span><Select id="workflow-execution" value={execution} onChange={(event) => setExecution(event.target.value as ExecutionMode)}><option value="cli">CLI</option><option value="api">Direct API / Proxy</option></Select></label>
          <label className="workflow-field" htmlFor="workflow-route"><span>Default route</span><Select id="workflow-route" value={route} disabled={execution !== 'api'} onChange={(event) => setRoute(event.target.value as RouteMode)}><option value="direct">Direct</option><option value="proxy">Universal Proxy</option></Select></label>
          <label className="workflow-field" htmlFor="workflow-autonomy"><span>Autonomy</span><Select id="workflow-autonomy" value={autonomy} onChange={(event) => setAutonomy(event.target.value as AutonomyMode)}><option value="plan">Plan</option><option value="ask">Ask</option><option value="autoEdit">Auto-edit</option><option value="full">Full control</option><option value="custom">Custom</option></Select></label>
          <label className="workflow-field" htmlFor="workflow-model"><span>Model override</span><UiTextInput id="workflow-model" value={model} onChange={(event) => setModel(event.target.value)} placeholder="Provider or CLI model" /></label>
        </div>
        <div className="workflow-loop-panel">
          <label className="toggle-row workflow-loop-toggle">
            <span><strong>Loop until the check passes</strong><small>Repeat the workflow, run a check, then stop at the round, cost, or time limit.</small></span>
            <Checkbox checked={loopEnabled} disabled={running} onChange={(event) => setLoopEnabled(event.target.checked)} />
          </label>
          {loopEnabled && (
            <div className="workflow-loop-fields">
              <label className="workflow-field"><span>Maximum rounds</span><UiTextInput type="number" min={1} max={20} value={loopRounds} onChange={(event) => setLoopRounds(clampNumber(event.target.value, 1, 20, 3))} /></label>
              <label className="workflow-field"><span>Maximum cost (USD, 0 = off)</span><UiTextInput type="number" min={0} max={10000} step="0.01" value={loopCost} onChange={(event) => setLoopCost(clampNumber(event.target.value, 0, 10_000, 0))} /></label>
              <label className="workflow-field"><span>Maximum minutes</span><UiTextInput type="number" min={1} max={1440} value={loopMinutes} onChange={(event) => setLoopMinutes(clampNumber(event.target.value, 1, 1440, 30))} /></label>
              <label className="workflow-field workflow-loop-check"><span>Check command</span><UiTextInput value={loopCheck} onChange={(event) => setLoopCheck(event.target.value)} placeholder="npm test" /></label>
            </div>
          )}
          {activeRun?.workflow.teamCheck && (
            <div className={`workflow-loop-progress team-check-progress ${activeRun.workflow.teamCheck.lastPassed === false ? 'failed' : ''}`} role="status">
              <span>Check <code>{activeRun.workflow.teamCheck.command}</code></span>
              {' · '}{activeRun.workflow.teamCheck.lastPassed === null ? 'not run yet' : activeRun.workflow.teamCheck.lastPassed ? 'passed' : 'failed'}
              {' · '}fix round {activeRun.workflow.teamCheck.round} of {activeRun.workflow.teamCheck.maxRounds}
              {activeRun.workflow.teamCheck.stopReason === 'max_rounds' ? ' · out of rounds. Resume allows one more.' : ''}
              {activeRun.workflow.teamCheck.lastPassed === false && activeRun.workflow.teamCheck.lastOutput && <pre>{activeRun.workflow.teamCheck.lastOutput}</pre>}
            </div>
          )}
          {activeRun?.workflow.loopProgress && (
            <div className="workflow-loop-progress" role="status">
              Round {activeRun.workflow.loopProgress.round} of {activeRun.workflow.loop.maxRounds}
              {' · '}${activeRun.workflow.loopProgress.costUsd.toFixed(4)}
              {' · '}{Math.round(activeRun.workflow.loopProgress.elapsedMs / 1000)}s
              {activeRun.workflow.loopProgress.lastCheckPassed === null ? '' : activeRun.workflow.loopProgress.lastCheckPassed ? ' · check passed' : ' · check failed'}
              {activeRun.workflow.loopProgress.lastCheckOutput && <pre>{activeRun.workflow.loopProgress.lastCheckOutput}</pre>}
            </div>
          )}
        </div>
        <div className="workflow-step-list">
          {steps.map((step, index) => {
            const runsOn = `${executionOf(step)}:${routeOf(step)}`;
            const cliProxy = proxyCapable(step.agent, 'cli');
            return (
            <div className="workflow-step" key={step.id}>
              <span className={`workflow-index ${step.status}`}>{index + 1}</span>
              <div className="workflow-agent-field">
                <label className="workflow-field">
                  <span>Agent</span>
                  <Select aria-label={`Step ${index + 1} agent`} value={step.agent} onChange={(event) => setSteps((current) => current.map((item) => item.id === step.id ? { ...item, agent: event.target.value as AgentId } : item))}>
                    {agentCapabilities.map((agent) => <option key={agent.id} value={agent.id} disabled={!agent.available}>{agent.displayName}{agent.available ? '' : ' (unavailable)'}</option>)}
                  </Select>
                </label>
                <label className="workflow-field">
                  <span>Runs on</span>
                  <Select
                    aria-label={`Step ${index + 1} runs on`}
                    value={runsOn}
                    disabled={running}
                    onChange={(event) => {
                      const [stepExecution, stepRoute] = event.target.value.split(':') as [ExecutionMode, RouteMode];
                      setSteps((current) => current.map((item) => item.id === step.id ? { ...item, execution: stepExecution, route: stepRoute } : item));
                    }}
                  >
                    <option value="cli:direct">Subscription (CLI)</option>
                    <option value="cli:proxy" disabled={!cliProxy}>CLI via Universal Proxy{cliProxy ? '' : ' (not supported)'}</option>
                    <option value="api:direct">API (direct)</option>
                    <option value="api:proxy">API via Universal Proxy</option>
                  </Select>
                </label>
              </div>
              <label className="workflow-field workflow-prompt-field">
                <span>Prompt</span>
                <Textarea aria-label={`Step ${index + 1} prompt`} value={step.prompt} onChange={(event) => setSteps((current) => current.map((item) => item.id === step.id ? { ...item, prompt: event.target.value } : item))} placeholder={`What should ${step.agent} do?`} rows={3} />
              </label>
              <div className="workflow-step-state">
                <span className={`workflow-status ${step.status}`}>{step.status}</span>
                {step.isolated && <small className="workflow-isolated" title="This part ran in its own copy of the project at the same time as others, and its changes were merged back.">Ran side by side</small>}
                {step.note && <small className="workflow-step-note" title={step.note}>{step.note}</small>}
                {step.verdict && <small className={`workflow-verdict ${step.verdict.result}`}>{step.verdict.result === 'pass' ? 'Security: passed' : step.verdict.acknowledged ? 'Security: blocked, continued by you' : 'Security: blocked'}</small>}
                {step.error && <small className="workflow-step-error" title={step.error}>{step.error}</small>}
                {step.output && <small className="workflow-step-output" title={step.output}>{step.output.slice(0, 180)}</small>}
              </div>
              <UiButton type="button" className="icon-button compact workflow-remove" aria-label={`Remove step ${index + 1}`} title="Remove step" disabled={running || steps.length === 1} onClick={() => setSteps((current) => current.filter((item) => item.id !== step.id))}><Trash2 size={15} /></UiButton>
            </div>
            );
          })}
        </div>
        <div className="workflow-builder-footer">
          <span>{steps.length} {steps.length === 1 ? 'step' : 'steps'} in this workflow</span>
          <UiButton type="button" className="secondary-button" disabled={running} onClick={addStep}><Plus size={14} /><span>Add step</span></UiButton>
        </div>
      </div>
    </div>
  );
}

export function HistoryView({
  conversations,
  activeId,
  projects,
  onOpen,
  onRename,
  onArchive,
  onFork,
  onDelete,
}: {
  conversations: ConversationRecord[];
  activeId: string | null;
  projects: ProjectRecord[];
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onArchive: (id: string, archived: boolean) => void;
  onFork: (id: string) => void;
  onDelete: (id: string) => void;
}): ReactNode {
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const normalized = query.trim().toLowerCase();
  const visible = conversations.filter((conversation) => {
    if (!showArchived && conversation.archived) return false;
    if (!normalized) return true;
    return `${conversation.title} ${conversation.activeAgent ?? ''}`.toLowerCase().includes(normalized);
  });
  return (
    <div className="page-view">
      <PageHeader title="History" detail={`${conversations.length} conversations stored on this machine`}>
        <label className="toggle-row history-archive-filter"><span><strong>Show archived</strong><small>Include archived conversations</small></span><Checkbox checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /></label>
      </PageHeader>
      <label className="input-with-icon history-search"><Search size={15} /><UiTextInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search conversations" /></label>
      <div className="history-table">
        <div className="history-head">
          <span>Thread</span>
          <span>Project</span>
          <span>Updated</span>
          <span />
        </div>
        {visible.map((conversation) => (
          <div
            key={conversation.id}
            className={`history-row ${conversation.id === activeId ? 'active' : ''}`}
          >
            <UiButton type="button" className="history-open" onClick={() => onOpen(conversation.id)}><span className="truncate">{conversation.title}</span></UiButton>
            <span className="truncate">{projects.find((project) => project.id === conversation.projectId)?.name ?? 'Unassigned'}</span>
            <span>{relativeTime(conversation.updatedAt)}</span>
            <span className="history-actions">
              <UiButton type="button" title="Rename" onClick={() => { void promptDialog({ title: 'Rename conversation', label: 'Conversation title', initialValue: conversation.title, confirmLabel: 'Rename' }).then((next) => { if (next?.trim()) onRename(conversation.id, next.trim()); }); }}><Pencil size={13} /></UiButton>
              <UiButton type="button" title={conversation.archived ? 'Restore' : 'Archive'} onClick={() => onArchive(conversation.id, !conversation.archived)}>{conversation.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}</UiButton>
              <UiButton type="button" title="Copy conversation text" onClick={() => void (async () => {
                const record = '__summary' in conversation
                  ? await window.kaiDesktop.getConversation(conversation.id).then((response) => response.ok ? response.data : null)
                  : conversation;
                if (record) await navigator.clipboard?.writeText(record.turns.map((turn) => `${turn.role === 'user' ? 'You' : 'KAI'}:\n${turn.text}`).join('\n\n'));
              })()}><Copy size={13} /></UiButton>
              <UiButton type="button" title="Branch conversation" onClick={() => onFork(conversation.id)}><GitFork size={13} /></UiButton>
              <UiButton type="button" title="Delete" onClick={() => { void confirmDialog({ title: 'Delete conversation?', detail: `Delete "${conversation.title}"?`, confirmLabel: 'Delete', destructive: true }).then((confirmed) => { if (confirmed) onDelete(conversation.id); }); }}><Trash2 size={13} /></UiButton>
            </span>
          </div>
        ))}
        {visible.length === 0 && <div className="empty-list">No matching conversations</div>}
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'KAI encountered an unexpected error.';
}

function clampNumber(value: string, minimum: number, maximum: number, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}
