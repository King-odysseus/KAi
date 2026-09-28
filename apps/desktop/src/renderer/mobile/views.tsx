import { useEffect, useState, type ReactNode } from 'react';
import type { UsageSummary, Workflow, WorkflowRun, WorkflowStep } from '@kai/contracts';
import { TopBar } from './chrome';
import {
  alerts,
  answerApproval,
  controls,
  getState,
  loadConversation,
  projectName,
  sendTurn,
  turnPlan,
  windowLabel,
  type Alert,
  type RemoteState,
} from './store';
import { useInstall } from './install';

/**
 * One write in flight. Every control on these screens is a single channel, so they all share the same
 * shape: disable while it runs, and put whatever the desktop said in front of the user when it refuses.
 */
function useAction(): { busy: boolean; problem: string | null; run: (work: () => Promise<void>) => void } {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const run = (work: () => Promise<void>): void => {
    setBusy(true);
    setProblem(null);
    void work()
      .catch((error: unknown) => setProblem(error instanceof Error ? error.message : 'That did not work.'))
      .finally(() => setBusy(false));
  };
  return { busy, problem, run };
}

/** A clock that ticks only while something is running, so elapsed times stay honest. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function elapsed(from: string, to: string | undefined, now: number): string {
  const start = Date.parse(from);
  if (Number.isNaN(start)) return '—';
  const end = to ? Date.parse(to) : now;
  const seconds = Math.max(0, Math.round((end - start) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * How long ago, in the words a list row has room for. Not ticked: the store re-reads every twenty
 * seconds, so a row that says "4m ago" is at most that stale, which is the same honesty as the elapsed
 * clock's with less machinery.
 */
export function ago(from: string): string {
  const at = Date.parse(from);
  if (Number.isNaN(at)) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1_000));
  if (seconds < 45) return 'just now';
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

type ChipTone = 'run' | 'wait' | 'done' | 'fail' | 'soft';

function Chip({ tone, children }: { tone: ChipTone; children: ReactNode }) {
  return <span className={`chip ${tone}`}>{children}</span>;
}

/** Status as the phone shows it: lavender running, amber waiting on you, mint done, red failed. */
function runTone(status: Workflow['status']): { tone: ChipTone; label: string } {
  switch (status) {
    case 'running': return { tone: 'run', label: 'Running' };
    case 'paused': return { tone: 'wait', label: 'Waiting on you' };
    case 'ready': return { tone: 'wait', label: 'Ready' };
    case 'completed': return { tone: 'done', label: 'Done' };
    case 'aborted': return { tone: 'fail', label: 'Stopped' };
  }
}

function stepTone(status: WorkflowStep['status']): string {
  if (status === 'completed') return 'done';
  if (status === 'running') return 'now';
  if (status === 'failed') return 'fail';
  return '';
}

/** One segment per step: done, the one running now, failed, or still to come. */
function Steps({ workflow }: { workflow: Workflow }) {
  return (
    <div className="steps">
      {workflow.steps.map((step) => (
        <i key={step.id} className={stepTone(step.status)} />
      ))}
    </div>
  );
}

function ProgressBar({ workflow }: { workflow: Workflow }) {
  if (workflow.status !== 'running' && workflow.status !== 'paused') return null;
  const total = workflow.steps.length;
  const finished = workflow.steps.filter((step) => step.status === 'completed' || step.status === 'failed').length;
  const percent = total === 0 ? 0 : Math.round((finished / total) * 100);
  return (
    <div className="bar">
      <i style={{ width: `${percent}%` }} />
    </div>
  );
}

function runMeta(run: WorkflowRun, state: RemoteState): string {
  const project = projectName(state, run.projectId) ?? 'No project';
  const stepIndex = Math.min(run.workflow.currentStepIndex + 1, run.workflow.steps.length);
  const agent = run.workflow.steps[run.workflow.currentStepIndex]?.agent ?? run.workflow.steps[0]?.agent ?? 'agent';
  const bits = [project, agent, `step ${stepIndex} of ${run.workflow.steps.length}`];
  if (run.workflow.model) bits.splice(2, 0, run.workflow.model);
  if (run.workflow.loopProgress) bits.push(`round ${run.workflow.loopProgress.round} of ${run.workflow.loopProgress.maxRounds}`);
  return bits.join(' · ');
}

function RunCard({ run, state, onOpen }: { run: WorkflowRun; state: RemoteState; onOpen: () => void }) {
  const { tone, label } = runTone(run.workflow.status);
  const live = run.workflow.status === 'running';
  const now = useNow(live);
  return (
    <button
      type="button"
      className={`card ${live ? 'live' : ''} ${run.workflow.status === 'paused' || run.workflow.status === 'ready' ? 'alert' : ''}`}
      onClick={onOpen}
    >
      <div className="row">
        <Chip tone={tone}>{label}</Chip>
        <span className="meta mono flush">{elapsed(run.workflow.createdAt, run.workflow.completedAt, now)}</span>
      </div>
      <div className="title">{run.workflow.title}</div>
      <div className="meta">{runMeta(run, state)}</div>
      <ProgressBar workflow={run.workflow} />
    </button>
  );
}

function alertTone(alert: Alert): ChipTone {
  if (alert.kind === 'approval') return 'wait';
  if (alert.kind === 'failure') return 'fail';
  if (alert.kind === 'done') return 'done';
  return 'soft';
}

function at(alert: Alert): string {
  return new Date(alert.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * An approval is the one alert that is answered rather than read, so it is not a button: it shows the
 * command itself, the risk, and the window and project it came from, and only then the two ways out.
 * Nothing here is inferred — the tool is the string the desktop is holding, not a summary of it.
 */
function ApprovalCard({ alert, state, onOpen }: { alert: Alert; state: RemoteState; onOpen: (alert: Alert) => void }) {
  const { busy, problem, run } = useAction();
  const [armed, setArmed] = useState(false);
  const high = alert.risk === 'high';
  const answerable = Boolean(alert.requestId);
  const answer = (approved: boolean): void => run(() => answerApproval(alert, approved));
  return (
    <div className="card alert">
      <div className="row">
        <Chip tone="wait">Approval</Chip>
        <span className="meta mono flush">{at(alert)}{alert.risk ? ` · ${alert.risk} risk` : ''}</span>
      </div>
      <div className="title">{alert.title}</div>
      {alert.tool && <pre className="cmd">{alert.tool}</pre>}
      {alert.detail && <div className="meta">{alert.detail}</div>}
      <div className="meta dim">From {windowLabel(state, alert.windowId)}</div>
      {!answerable && (
        <div className="meta dim">This request did not name what it is waiting for, so it can only be answered on the desktop.</div>
      )}
      {problem && <div className="meta danger">{problem}</div>}
      <div className="actions">
        <button type="button" className="act" disabled={busy || !answerable} onClick={() => answer(false)}>Deny</button>
        <button
          type="button"
          className={`act approve ${high ? 'high' : ''}`}
          disabled={busy || !answerable}
          // A high-risk command takes two taps: on a phone in another room, a mis-tap must not be enough.
          onClick={() => (high && !armed ? setArmed(true) : answer(true))}
        >
          {high && armed ? 'Tap again to approve' : 'Approve'}
        </button>
      </div>
      <button type="button" className="linky" onClick={() => onOpen(alert)}>Open the run</button>
    </div>
  );
}

function AlertCard({ alert, state, onOpen }: { alert: Alert; state: RemoteState; onOpen: (alert: Alert) => void }) {
  if (alert.kind === 'approval') return <ApprovalCard alert={alert} state={state} onOpen={onOpen} />;
  return (
    <button type="button" className="card" onClick={() => onOpen(alert)}>
      <div className="row">
        <Chip tone={alertTone(alert)}>{alert.chip}</Chip>
        <span className="meta mono flush">{new Date(alert.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <div className="title">{alert.title}</div>
      <div className="meta">{alert.detail || ' '}</div>
    </button>
  );
}

function BudgetCard({ usage }: { usage: UsageSummary }) {
  const limits = usage.limits.filter((limit) => limit.level !== 'ok');
  if (limits.length === 0 && !usage.blocked) return null;
  const worst = limits[0];
  const detail = worst
    ? `${worst.scope} spend: $${worst.spentUsd.toFixed(2)} of $${worst.limitUsd.toFixed(2)}`
    : 'Spend is approaching a configured limit.';
  return (
    <div className="card alert">
      <div className="row">
        <Chip tone="soft">Budget</Chip>
        <span className="meta mono flush">
          {usage.todayUsd.toFixed(2)} / {usage.budget.dailyUsd > 0 ? usage.budget.dailyUsd.toFixed(2) : '—'} today
        </span>
      </div>
      <div className="title">{usage.blocked ? 'Runs are blocked by the budget' : 'Spend is close to a limit'}</div>
      <div className="meta">{usage.blockedReason ?? detail}</div>
    </div>
  );
}

/** Offered once, and only while it is true: an installed console has no use for it. */
function InstallCard() {
  const { state, install } = useInstall();
  const [hidden, setHidden] = useState(false);
  if (state === 'installed' || hidden) return null;
  return (
    <div className="card">
      <div className="row">
        <Chip tone="soft">Install</Chip>
        <button type="button" className="meta dim flush" onClick={() => setHidden(true)}>Not now</button>
      </div>
      {state === 'ready' && (
        <>
          <div className="title">Keep KAI on your home screen</div>
          <div className="meta">It opens full screen and keeps its last read when the desktop is asleep.</div>
          <button type="button" className="act approve" onClick={install}>Add to home screen</button>
        </>
      )}
      {state === 'manual' && (
        <>
          <div className="title">Add KAI to your home screen</div>
          <div className="meta">Tap Share, then Add to Home Screen. iOS has no install button to offer.</div>
        </>
      )}
      {state === 'blocked' && (
        <>
          <div className="title">Install needs a secure address</div>
          <div className="meta">
            Over a plain http address a phone cannot install an app or keep it working offline. Put the desktop
            behind Tailscale and open the HTTPS address instead — the steps are in docs/desktop/MOBILE_REMOTE.md.
          </div>
        </>
      )}
    </div>
  );
}

export function NeedsYou({ state, onOpenRun }: { state: RemoteState; onOpenRun: (workflowId: string) => void }) {
  const waiting = state.runs.filter((run) => run.workflow.status === 'paused' || run.workflow.status === 'ready');
  const live = state.runs.filter((run) => run.workflow.status === 'running');
  const finished = state.runs.filter((run) => run.workflow.status === 'completed' || run.workflow.status === 'aborted').slice(0, 5);
  const openAlert = (alert: Alert) => {
    // An approval is only dismissed by answering it: tapping through to the run must not lose the question.
    if (alert.kind !== 'approval') alerts.dismiss(alert.id);
    const run = state.runs.find((candidate) => candidate.conversationId === alert.conversationId);
    if (run) onOpenRun(run.workflow.id);
  };
  return (
    <div className="scroll">
      {state.alerts.map((alert) => (
        <AlertCard key={alert.id} alert={alert} state={state} onOpen={openAlert} />
      ))}

      <InstallCard />

      {waiting.length > 0 && <div className="section-head">Waiting on you</div>}
      {waiting.map((run) => (
        <RunCard key={run.workflow.id} run={run} state={state} onOpen={() => onOpenRun(run.workflow.id)} />
      ))}

      {live.length > 0 && <div className="section-head">Running</div>}
      {live.map((run) => (
        <RunCard key={run.workflow.id} run={run} state={state} onOpen={() => onOpenRun(run.workflow.id)} />
      ))}

      {state.usage && <BudgetCard usage={state.usage} />}

      {finished.length > 0 && <div className="section-head">Earlier</div>}
      {finished.map((run) => (
        <RunCard key={run.workflow.id} run={run} state={state} onOpen={() => onOpenRun(run.workflow.id)} />
      ))}

      {state.alerts.length === 0 && waiting.length === 0 && live.length === 0 && finished.length === 0 && (
        <div className="card">
          <div className="title">Nothing needs you</div>
          <div className="meta">Start a run on the desktop and it will show up here.</div>
        </div>
      )}
    </div>
  );
}

export function Workflows({ state, onOpenRun }: { state: RemoteState; onOpenRun: (workflowId: string) => void }) {
  const [filter, setFilter] = useState<string | null>(null);
  const projects = [...new Set(state.runs.map((run) => run.projectId).filter((id): id is string => Boolean(id)))];
  const shown = filter ? state.runs.filter((run) => run.projectId === filter) : state.runs;
  const liveCount = state.runs.filter((run) => run.workflow.status === 'running').length;
  return (
    <>
      <TopBar title="Workflows">
        <span className={`dot ${state.connected ? '' : 'off'}`} />
        {liveCount > 0 ? `${liveCount} running` : `${state.runs.length} total`}
      </TopBar>
      <div className="scroll">
        <div className="filters">
          <button type="button" className={filter === null ? 'on' : ''} onClick={() => setFilter(null)}>All projects</button>
          {projects.map((id) => (
            <button type="button" key={id} className={filter === id ? 'on' : ''} onClick={() => setFilter(id)}>
              {projectName(state, id) ?? id}
            </button>
          ))}
        </div>
        {shown.length === 0 && (
          <div className="card">
            <div className="title">No runs yet</div>
            <div className="meta">Runs started on the desktop — from the Workbench or a Team plan — appear here.</div>
          </div>
        )}
        {shown.map((run) => (
          <RunCard key={run.workflow.id} run={run} state={state} onOpen={() => onOpenRun(run.workflow.id)} />
        ))}
      </div>
    </>
  );
}

function StepRow({ step, index, live }: { step: WorkflowStep; index: number; live: string }) {
  const label = step.label ?? `Step ${index + 1}`;
  const body = step.status === 'running' ? live : step.error || step.output || '';
  return (
    <div className="step-row">
      <div className="row">
        <span className={`step-dot ${step.status}`} />
        <span className="step-name">{label}</span>
        <span className="meta mono flush">{step.status}</span>
      </div>
      <div className="meta">{step.prompt.length > 140 ? `${step.prompt.slice(0, 140)}…` : step.prompt}</div>
      {step.note && <div className="meta note">{step.note}</div>}
      {body && <div className="log">{body.slice(-4_000)}</div>}
    </div>
  );
}

/** The verbs worth a tap rather than a sentence, in the words a user would use. Filled in, not sent. */
const QUICK_VERBS = ['Explain what failed', 'Retry the last step', 'Summarise where this is', 'Stop and report'];

/**
 * The two ways to keep the work moving without the desktop: end what is running, or send another turn
 * into the conversation. The turn goes out without being awaited — the run is watched on the live tail.
 * `workflow` is optional: a conversation opened from the Workspace has nothing running to stop, so the
 * same bar serves both, with the run controls appearing only where there is a run.
 */
export function Composer({ state, conversationId, model, workflow }: {
  state: RemoteState;
  conversationId: string;
  model?: string | null;
  workflow?: Workflow;
}): ReactNode {
  const [text, setText] = useState('');
  const { busy, problem, run: act } = useAction();
  const status = workflow?.status;
  const plan = turnPlan(state, conversationId);
  const send = (): void => {
    const prompt = text.trim();
    if (!prompt) return;
    setText('');
    sendTurn(conversationId, prompt, model);
  };
  return (
    <div className="composer">
      <div className="row">
        <span className="meta dim flush">
          Next turn: {plan.agent} · {plan.route} · {plan.autonomy}
        </span>
        {workflow && status === 'running' && (
          <button type="button" className="act" disabled={busy} onClick={() => act(() => controls.stopWorkflow(workflow.id))}>
            Stop run
          </button>
        )}
        {workflow && (status === 'paused' || status === 'aborted') && (
          <button type="button" className="act approve" disabled={busy} onClick={() => act(() => controls.resumeWorkflow(workflow.id))}>
            Resume run
          </button>
        )}
      </div>
      {problem && <div className="meta danger">{problem}</div>}
      <div className="verbs">
        {QUICK_VERBS.map((verb) => (
          <button type="button" key={verb} className="verb" onClick={() => setText(verb)}>{verb}</button>
        ))}
      </div>
      <div className="send">
        <input
          value={text}
          placeholder={`Ask ${plan.agent} to continue…`}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') send();
          }}
        />
        <button type="button" className="act approve" disabled={text.trim().length === 0} onClick={send}>Send</button>
      </div>
    </div>
  );
}

export function RunDetail({ state, workflowId, backLabel, onBack }: { state: RemoteState; workflowId: string; backLabel: string; onBack: () => void }) {
  const run = state.runs.find((candidate) => candidate.workflow.id === workflowId) ?? null;
  const live = state.tails[run?.conversationId ?? ''] ?? '';
  const active = run?.workflow.status === 'running';
  const now = useNow(Boolean(active));
  const speakingTo = run?.conversationId ?? null;
  useEffect(() => {
    // The conversation is where the next turn's agent, route and autonomy come from.
    if (speakingTo) void loadConversation(speakingTo);
  }, [speakingTo]);
  if (!run) {
    return (
      <div className="scroll">
        <button type="button" className="back" onClick={onBack}>‹ {backLabel}</button>
        <div className="card">
          <div className="title">That run is no longer on the desktop</div>
          <div className="meta">It may have been removed, or the window was closed.</div>
        </div>
      </div>
    );
  }
  const { tone, label } = runTone(run.workflow.status);
  const stepIndex = Math.min(run.workflow.currentStepIndex + 1, run.workflow.steps.length);
  return (
    <>
      <div className="detail-head">
        <button type="button" className="back" onClick={onBack}>‹ {backLabel}</button>
        <div className="row">
          <h2 className="detail-title">{run.workflow.title}</h2>
          <Chip tone={tone}>{label}</Chip>
        </div>
        <div className="kv">
          <div><span className="k">Project</span><span className="v">{projectName(state, run.projectId) ?? '—'}</span></div>
          <div><span className="k">Elapsed</span><span className="v mono">{elapsed(run.workflow.createdAt, run.workflow.completedAt, now)}</span></div>
          <div><span className="k">Step</span><span className="v">{stepIndex} / {run.workflow.steps.length}</span></div>
        </div>
        <Steps workflow={run.workflow} />
      </div>
      <div className="scroll">
        {(run.workflow.loopProgress || run.workflow.teamCheck) && <div className="section-head">Progress</div>}
        {run.workflow.loopProgress && (
          <div className="card">
            <div className="row">
              <span className="meta flush">Fix round</span>
              <span className="meta mono flush">
                {run.workflow.loopProgress.round} of {run.workflow.loopProgress.maxRounds}
              </span>
            </div>
            <div className="row">
              <span className="meta flush">Cost so far</span>
              <span className="meta mono flush">${run.workflow.loopProgress.costUsd.toFixed(2)}</span>
            </div>
            {run.workflow.loopProgress.lastCheckOutput && (
              <div className="log">{run.workflow.loopProgress.lastCheckOutput.slice(-2_000)}</div>
            )}
          </div>
        )}
        {run.workflow.teamCheck && (
          <div className="card">
            <div className="row">
              <span className="meta flush">Check</span>
              <span className={`chip ${run.workflow.teamCheck.lastPassed === false ? 'fail' : run.workflow.teamCheck.lastPassed ? 'done' : 'soft'}`}>
                {run.workflow.teamCheck.lastPassed === null ? 'not run yet' : run.workflow.teamCheck.lastPassed ? 'passing' : 'failing'}
              </span>
            </div>
            <div className="meta mono">{run.workflow.teamCheck.command}</div>
          </div>
        )}
        {(state.sent[run.conversationId] ?? []).length > 0 && (
          <>
            <div className="section-head">Sent from this phone</div>
            <div className="card">
              {(state.sent[run.conversationId] ?? []).map((turn) => (
                <div className="row" key={`${turn.at}:${turn.text}`}>
                  <span className="meta flush">{turn.text}</span>
                  <span className="meta mono flush">{new Date(turn.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              ))}
              <div className="meta dim">Waiting for the agent to answer. It clears on its first line of output.</div>
            </div>
          </>
        )}
        <div className="section-head">Steps</div>
        {run.workflow.steps.map((step, index) => (
          <StepRow key={step.id} step={step} index={index} live={live} />
        ))}
        {run.workflow.notice && (
          <div className="card">
            <div className="title">Note</div>
            <div className="meta">{run.workflow.notice}</div>
          </div>
        )}
      </div>
      <Composer state={state} conversationId={run.conversationId} model={run.workflow.model} workflow={run.workflow} />
    </>
  );
}
