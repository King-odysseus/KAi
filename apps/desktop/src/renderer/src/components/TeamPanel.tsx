import { AlertTriangle, Loader2, Play, Trash2, Users, Wallet } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import {
  isLocalProvider,
  planWaves,
  resolveRole,
  type AgentTeam,
  type AgentCapability,
  type AppSettings,
  type AutonomyMode,
  type ProjectRecord,
  type RouteMode,
  type TeamAssignment,
  type TeamBilling,
  type TeamPart,
  type TeamPlanDraft,
  type TeamResolvedAssignee,
  type WorkflowRun,
} from '@kai/contracts';
import { unwrap } from '../types';
import { conflictDetail, teamPaths } from '../team-paths';
import { confirmDialog } from './AppDialog';

const AUTONOMY_OPTIONS: Array<{ value: AutonomyMode; label: string }> = [
  { value: 'autoEdit', label: 'Auto-edit' },
  { value: 'ask', label: 'Ask first' },
  { value: 'full', label: 'Full control' },
];

const BILLING_LABEL: Record<TeamBilling, string> = {
  subscription: 'Your CLI account',
  proxy: 'Proxy - per-token charges',
  api: 'KAI API - per-token charges',
  local: 'Local model - no charge',
};

/** A goal in, a plan you can edit, then the team runs it part by part. Nothing runs until you press Run. */
export function TeamPanel({
  activeProject,
  agentCapabilities,
  settings,
  busy,
  running,
  onStarted,
}: {
  activeProject: ProjectRecord | null;
  agentCapabilities: AgentCapability[];
  settings: AppSettings;
  busy: boolean;
  running: boolean;
  onStarted: (run: WorkflowRun) => void;
}): ReactNode {
  const [goal, setGoal] = useState('');
  const [draft, setDraft] = useState<TeamPlanDraft | null>(null);
  const [planning, setPlanning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [autonomy, setAutonomy] = useState<AutonomyMode>('autoEdit');
  const [checkCommand, setCheckCommand] = useState('');
  const [fixRounds, setFixRounds] = useState(2);
  const [sideBySide, setSideBySide] = useState(false);
  const [maxConcurrent, setMaxConcurrent] = useState(3);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A project can have its own team; the plan card and the orchestrator line follow whichever applies.
  const [projectTeam, setProjectTeam] = useState<AgentTeam | null>(null);
  const team = projectTeam ?? settings.agentTeam;
  const orchestrator = team.roles.orchestrator;
  const localApi = isLocalProvider(settings.directApi.provider);

  // Each project remembers the check it last used, since it is usually the same command every time.
  const projectId = activeProject?.id;
  useEffect(() => {
    let cancelled = false;
    setProjectTeam(null);
    if (projectId) {
      void window.kaiDesktop.getPreferences(projectId).then(unwrap).then((preferences) => {
        if (!cancelled) setProjectTeam(preferences?.agentTeam ?? null);
      }).catch(() => undefined);
    }
    const saved = readCheck(projectId);
    setCheckCommand(saved.command);
    setFixRounds(saved.rounds);
    return () => { cancelled = true; };
  }, [projectId]);

  async function plan(): Promise<void> {
    if (!activeProject || !goal.trim()) return;
    setPlanning(true);
    setError(null);
    setNotice(null);
    setDraft(null);
    try {
      setDraft(unwrap(await window.kaiDesktop.planTeam({ projectId: activeProject.id, goal: goal.trim() })));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'KAI could not plan this job.');
    } finally {
      setPlanning(false);
    }
  }

  async function start(): Promise<void> {
    if (!draft) return;
    setStarting(true);
    setError(null);
    try {
      // Warn, never block, when another agent has claimed a file the team is about to change.
      const paths = teamPaths(draft.parts);
      if (paths.length > 0) {
        const check = await window.kaiDesktop.coordinationPreflight(draft.projectId, paths).then(unwrap).catch(() => null);
        if (check && check.conflicts.length > 0 && !(await confirmDialog({
          title: 'Files are already claimed',
          detail: `Another agent is working on files this team will change:\n\n${conflictDetail(check.conflicts)}\n\nRun the team anyway?`,
          confirmLabel: 'Run anyway',
        }))) {
          return;
        }
      }
      const run = unwrap(await window.kaiDesktop.startTeam({
        projectId: draft.projectId,
        goal: draft.goal,
        parts: draft.parts,
        assignments: draft.assignments,
        autonomy,
        checkCommand: checkCommand.trim(),
        maxRounds: fixRounds,
        parallel: sideBySide,
        maxConcurrent,
      }));
      writeCheck(draft.projectId, { command: checkCommand.trim(), rounds: fixRounds });
      setDraft(null);
      setGoal('');
      setNotice('The team is working. Follow it in the run list above.');
      onStarted(run);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'KAI could not start the team.');
    } finally {
      setStarting(false);
    }
  }

  function changePart(id: string, patch: Partial<TeamPart>): void {
    setDraft((current) => (current ? { ...current, parts: current.parts.map((part) => (part.id === id ? { ...part, ...patch } : part)) } : current));
  }

  function changeAssignment(id: string, patch: Partial<TeamAssignment>): void {
    setDraft((current) => (current ? { ...current, assignments: current.assignments.map((item) => (item.partId === id ? { ...item, ...patch } : item)) } : current));
  }

  function chooseAgent(id: string, assignee: TeamResolvedAssignee): void {
    const proxyCapable = assignee === 'api' || agentCapabilities.find((agent) => agent.id === assignee)?.supportsRoutes.includes('proxy');
    const current = draft?.assignments.find((item) => item.partId === id);
    const route: RouteMode = current?.route === 'proxy' && proxyCapable ? 'proxy' : 'direct';
    changeAssignment(id, { assignee, route, billing: billingFor(assignee, route, localApi), reason: `You chose ${nameOf(assignee, agentCapabilities)} for this part.` });
  }

  function chooseRoute(id: string, route: RouteMode): void {
    const current = draft?.assignments.find((item) => item.partId === id);
    if (!current) return;
    changeAssignment(id, { route, billing: billingFor(current.assignee, route, localApi) });
  }

  function removePart(id: string): void {
    setDraft((current) => (current && current.parts.length > 1
      ? {
          ...current,
          parts: current.parts.filter((part) => part.id !== id).map((part) => ({ ...part, dependsOn: part.dependsOn.filter((dependency) => dependency !== id) })),
          assignments: current.assignments.filter((item) => item.partId !== id),
        }
      : current));
  }

  const perTokenParts = draft?.assignments.filter((item) => item.billing === 'proxy' || item.billing === 'api').length ?? 0;
  const disabled = busy || running || planning || starting;

  return (
    <section className="team-panel" aria-label="Auto team">
      <div className="team-panel-head">
        <span className="team-panel-icon"><Users size={17} /></span>
        <div>
          <strong>Auto team</strong>
          <small>
            Give KAI a goal. {orchestrator?.assignee === 'auto' ? 'KAI picks who plans it' : `${nameOf(orchestrator?.assignee ?? 'api', agentCapabilities)} plans it`}, splits it into parts, and assigns each one to the best-fit agent from your team settings. You approve the plan before anything runs.
          </small>
        </div>
      </div>
      <label className="workflow-field" htmlFor="team-goal">
        <span>Goal</span>
        <textarea id="team-goal" rows={3} maxLength={4000} value={goal} disabled={planning || starting} onChange={(event) => setGoal(event.target.value)} placeholder="For example: add a login page with a matching API endpoint and tests" />
      </label>
      <div className="team-panel-actions">
        <button type="button" className="primary-button" disabled={disabled || !activeProject || !goal.trim()} onClick={() => void plan()}>
          {planning ? <Loader2 size={15} className="spin" /> : <Users size={15} />}
          <span>{planning ? 'Planning' : draft ? 'Plan again' : 'Plan the job'}</span>
        </button>
        {!activeProject && <small>Open a project first.</small>}
        {planning && <small>The orchestrator is reading the project. This only reads; nothing is changed.</small>}
      </div>
      {error && <div className="rules-error" role="alert"><span>{error}</span></div>}
      {notice && <div className="team-notice" role="status">{notice}</div>}

      {draft && (
        <div className="team-plan" aria-label="Team plan">
          <div className="team-plan-summary">
            <strong>{draft.summary || 'Plan'}</strong>
            <small>Planned by {nameOf(draft.orchestrator.assignee, agentCapabilities)}. {draft.orchestrator.reason} Using {draft.teamScope === 'project' ? "this project's own team" : 'the team from Settings'}.</small>
          </div>
          {draft.warnings.length > 0 && (
            <ul className="team-warnings" aria-label="Plan notes">
              {draft.warnings.map((warning) => <li key={warning}><AlertTriangle size={13} /><span>{warning}</span></li>)}
            </ul>
          )}
          <ol className="team-parts">
            {draft.parts.map((part, index) => {
              const assignment = draft.assignments.find((item) => item.partId === part.id);
              const info = resolveRole(team, part.role);
              if (!assignment) return null;
              const proxyCapable = assignment.assignee === 'api' || agentCapabilities.find((agent) => agent.id === assignment.assignee)?.supportsRoutes.includes('proxy');
              return (
                <li className="team-part" key={part.id}>
                  <div className="team-part-head">
                    <span className="workflow-index pending">{index + 1}</span>
                    <div className="team-part-title">
                      <strong>{part.title}</strong>
                      <small>{info.label}{info.access === 'read' ? ' - read-only' : ''}{part.dependsOn.length > 0 ? ` - after ${part.dependsOn.map((id) => draft.parts.find((item) => item.id === id)?.title ?? id).join(', ')}` : ''}</small>
                    </div>
                    <button type="button" className="icon-button compact" aria-label={`Remove ${part.title}`} title="Remove this part" disabled={disabled || draft.parts.length === 1} onClick={() => removePart(part.id)}><Trash2 size={15} /></button>
                  </div>
                  <div className="team-part-controls">
                    <label className="workflow-field">
                      <span>Agent</span>
                      <select aria-label={`${part.title} agent`} value={assignment.assignee} disabled={disabled} onChange={(event) => chooseAgent(part.id, event.target.value as TeamResolvedAssignee)}>
                        {(['claude', 'codex', 'qwen', 'gemini', 'kimi', 'api'] as const).map((id) => {
                          const capability = agentCapabilities.find((agent) => agent.id === id);
                          const ready = id === 'api' || Boolean(capability?.available);
                          return <option key={id} value={id}>{nameOf(id, agentCapabilities)}{ready ? '' : ' (not ready)'}</option>;
                        })}
                      </select>
                    </label>
                    <label className="workflow-field">
                      <span>Route</span>
                      <select aria-label={`${part.title} route`} value={assignment.route} disabled={disabled} onChange={(event) => chooseRoute(part.id, event.target.value as RouteMode)}>
                        <option value="direct">Direct</option>
                        <option value="proxy" disabled={!proxyCapable}>Proxy</option>
                      </select>
                    </label>
                    <span className={`team-billing ${assignment.billing}`} title="What this part is billed against"><Wallet size={12} />{BILLING_LABEL[assignment.billing]}</span>
                  </div>
                  <small className="team-reason">{assignment.reason}</small>
                  <details className="team-part-prompt">
                    <summary>Edit the instructions for this part</summary>
                    <textarea aria-label={`${part.title} instructions`} rows={4} maxLength={6000} value={part.prompt} disabled={disabled} onChange={(event) => changePart(part.id, { prompt: event.target.value })} />
                    {part.paths.length > 0 && <small>Stays within: {part.paths.join(', ')}</small>}
                  </details>
                </li>
              );
            })}
          </ol>
          <div className="team-plan-footer">
            <label className="workflow-field team-autonomy">
              <span>Editing agents may</span>
              <select aria-label="Team autonomy" value={autonomy} disabled={disabled} onChange={(event) => setAutonomy(event.target.value as AutonomyMode)}>
                {AUTONOMY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <div className="team-check">
              <label className="workflow-field team-check-command">
                <span>Check after the team finishes (optional)</span>
                <input aria-label="Check command" value={checkCommand} disabled={disabled} maxLength={1000} placeholder="npm test" onChange={(event) => setCheckCommand(event.target.value)} />
              </label>
              <label className="workflow-field team-rounds">
                <span>Fix rounds</span>
                <select aria-label="Fix rounds" value={fixRounds} disabled={disabled || !checkCommand.trim()} onChange={(event) => setFixRounds(Number(event.target.value))}>
                  {[1, 2, 3, 4, 5].map((count) => <option key={count} value={count}>{count}</option>)}
                </select>
              </label>
              <small>If the check fails, only the part that owns the files it names goes back to fix it.</small>
            </div>
            <div className="team-parallel">
              <label className="toggle-row team-parallel-toggle">
                <span>
                  <strong>Run independent parts at the same time</strong>
                  <small>Each part works in its own copy of the project; KAI merges the copies and runs a part again if its changes clash. Needs a git project with at least one commit.</small>
                </span>
                <input type="checkbox" aria-label="Run independent parts at the same time" checked={sideBySide} disabled={disabled} onChange={(event) => setSideBySide(event.target.checked)} />
              </label>
              {sideBySide && (
                <>
                  <label className="workflow-field team-rounds">
                    <span>At most</span>
                    <select aria-label="Parts at once" value={maxConcurrent} disabled={disabled} onChange={(event) => setMaxConcurrent(Number(event.target.value))}>
                      {[2, 3, 4].map((count) => <option key={count} value={count}>{count} at once</option>)}
                    </select>
                  </label>
                  <small className="team-waves" aria-label="Run order">{waveSummary(draft.parts)}</small>
                </>
              )}
            </div>
            <small>Reviewers always read only. A security review that finds a serious problem stops the job and asks you.{perTokenParts > 0 ? ` ${perTokenParts} ${perTokenParts === 1 ? 'part uses' : 'parts use'} per-token billing.` : ''}</small>
            <button type="button" className="primary-button" disabled={disabled || draft.parts.length === 0} onClick={() => void start()}>
              {starting ? <Loader2 size={15} className="spin" /> : <Play size={15} />}
              <span>{starting ? 'Starting' : `Run team (${draft.parts.length} ${draft.parts.length === 1 ? 'part' : 'parts'})`}</span>
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** "Login form + Auth endpoint, then Tests, then Security review + Code review". */
function waveSummary(parts: readonly TeamPart[]): string {
  const waves = planWaves(parts);
  if (waves.every((wave) => wave.length === 1)) return 'Every part here needs the one before it, so they will still run one at a time.';
  return `Runs in ${waves.length} ${waves.length === 1 ? 'step' : 'steps'}: ${waves.map((wave) => wave.map((part) => part.title).join(' + ')).join(', then ')}.`;
}

function checkKey(projectId: string | undefined): string {
  return `kai.teamCheck.${projectId ?? 'none'}`;
}

function readCheck(projectId: string | undefined): { command: string; rounds: number } {
  try {
    const value = JSON.parse(window.localStorage.getItem(checkKey(projectId)) ?? '{}') as { command?: unknown; rounds?: unknown };
    const rounds = Number(value.rounds);
    return {
      command: typeof value.command === 'string' ? value.command.slice(0, 1000) : '',
      rounds: Number.isInteger(rounds) && rounds >= 1 && rounds <= 5 ? rounds : 2,
    };
  } catch {
    return { command: '', rounds: 2 };
  }
}

function writeCheck(projectId: string, value: { command: string; rounds: number }): void {
  try {
    window.localStorage.setItem(checkKey(projectId), JSON.stringify(value));
  } catch {
    // Remembering the check is a convenience only.
  }
}

function billingFor(assignee: TeamResolvedAssignee, route: RouteMode, localApi: boolean): TeamBilling {
  if (assignee === 'api') return localApi && route === 'direct' ? 'local' : 'api';
  return route === 'proxy' ? 'proxy' : 'subscription';
}

function nameOf(assignee: string, capabilities: AgentCapability[]): string {
  if (assignee === 'api') return 'KAI API mode';
  if (assignee === 'auto') return 'Auto';
  return capabilities.find((agent) => agent.id === assignee)?.displayName ?? assignee;
}
