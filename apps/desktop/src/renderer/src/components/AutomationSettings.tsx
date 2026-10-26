import { MAX_AUTO_FIX_ROUNDS, type AgentScorecard, type EvalOverview, type EvalResult, type PermissionRule, type ProjectAutomation, type Schedule, type ScheduleInput } from '@kai/contracts';
import { Check, Play, Plus, Trash2, Wand2 } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { unwrap } from '../types';
import { confirmDialog } from './AppDialog';
import { Select } from './ui/Select';

type Agent = ScheduleInput['agent'];

const AGENT_OPTIONS: Array<{ value: Agent; label: string }> = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'qwen', label: 'Qwen Code' },
  { value: 'gemini', label: 'Gemini CLI' },
  { value: 'kimi', label: 'Kimi Code' },
];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandsToLines(hooks: ReadonlyArray<{ command: string }> | undefined): string {
  return (hooks ?? []).map((hook) => hook.command).join('\n');
}

function linesToHooks(text: string): Array<{ command: string }> {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 5).map((command) => ({ command: command.slice(0, 2_000) }));
}

/** Tool hooks accept `tool-glob :: command` so one list can target different tools. */
function toolHooksToLines(hooks: ReadonlyArray<{ command: string; tool?: string }> | undefined): string {
  return (hooks ?? []).map((hook) => (hook.tool ? `${hook.tool} :: ${hook.command}` : hook.command)).join('\n');
}

function linesToToolHooks(text: string): Array<{ command: string; tool?: string }> {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 20).map((line) => {
    const separator = line.indexOf('::');
    if (separator > 0) {
      const tool = line.slice(0, separator).trim();
      const command = line.slice(separator + 2).trim();
      return command ? { command: command.slice(0, 2_000), ...(tool ? { tool: tool.slice(0, 200) } : {}) } : null;
    }
    return { command: line.slice(0, 2_000) };
  }).filter((hook): hook is { command: string; tool?: string } => Boolean(hook));
}

type RuleKind = 'tool' | 'command' | 'path';
interface RuleDraft {
  id: string;
  effect: PermissionRule['effect'];
  kind: RuleKind;
  pattern: string;
  note: string;
}

function rulesToDrafts(rules: readonly PermissionRule[] | undefined): RuleDraft[] {
  return (rules ?? []).map((rule) => {
    const kind: RuleKind = rule.tools.length ? 'tool' : rule.commands.length ? 'command' : 'path';
    const pattern = kind === 'tool' ? rule.tools[0] : kind === 'command' ? rule.commands[0] : rule.paths[0];
    return { id: rule.id, effect: rule.effect, kind, pattern: pattern ?? '', note: rule.note ?? '' };
  });
}

function draftsToRules(drafts: readonly RuleDraft[]): PermissionRule[] {
  return drafts.filter((draft) => draft.pattern.trim()).map((draft) => ({
    id: draft.id,
    effect: draft.effect,
    tools: draft.kind === 'tool' ? [draft.pattern.trim()] : [],
    commands: draft.kind === 'command' ? [draft.pattern.trim()] : [],
    paths: draft.kind === 'path' ? [draft.pattern.trim()] : [],
    ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
  }));
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1_000);
  return seconds < 90 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}

function formatWhen(iso: string | undefined): string {
  if (!iso) return 'never';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'never' : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

/** Checks, hooks, review, schedules, evals and scorecards for the open project. */
export function ProjectAutomation({
  project,
  automation,
  onSaveAutomation,
  busy,
}: {
  project: { id: string; name: string } | null;
  automation: ProjectAutomation | null;
  onSaveAutomation: (automation: ProjectAutomation | null) => Promise<boolean>;
  busy: boolean;
}): ReactNode {
  if (!project) {
    return <p className="settings-note">Open a project to set up its checks, hooks, schedules and evals.</p>;
  }
  return (
    <div className="automation-stack">
      <RunAutomationCard key={project.id} project={project} automation={automation} onSave={onSaveAutomation} busy={busy} />
      <SchedulesCard key={`s-${project.id}`} projectId={project.id} />
      <EvalsCard key={`e-${project.id}`} projectId={project.id} />
      <ScorecardsCard />
    </div>
  );
}

function RunAutomationCard({ project, automation, onSave, busy }: {
  project: { id: string; name: string };
  automation: ProjectAutomation | null;
  onSave: (automation: ProjectAutomation | null) => Promise<boolean>;
  busy: boolean;
}): ReactNode {
  const [checkEnabled, setCheckEnabled] = useState(automation?.autoCheck?.enabled ?? false);
  const [command, setCommand] = useState(automation?.autoCheck?.command ?? '');
  const [rounds, setRounds] = useState(automation?.autoCheck?.maxRounds ?? 2);
  const [review, setReview] = useState(automation?.review?.enabled ?? false);
  const [beforeRun, setBeforeRun] = useState(commandsToLines(automation?.hooks?.beforeRun));
  const [afterEdit, setAfterEdit] = useState(commandsToLines(automation?.hooks?.afterEdit));
  const [afterRun, setAfterRun] = useState(commandsToLines(automation?.hooks?.afterRun));
  const [preTool, setPreTool] = useState(toolHooksToLines(automation?.hooks?.preTool));
  const [postTool, setPostTool] = useState(toolHooksToLines(automation?.hooks?.postTool));
  const [rules, setRules] = useState<RuleDraft[]>(rulesToDrafts(automation?.permissionRules));
  const [saved, setSaved] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestNote, setSuggestNote] = useState<string | null>(null);

  async function suggestRules(): Promise<void> {
    setSuggesting(true);
    setSuggestNote(null);
    try {
      const suggested = unwrap(await window.kaiDesktop.suggestPermissionRules(project.id));
      const already = new Set(rules.filter((rule) => rule.kind === 'command').map((rule) => rule.pattern.trim()));
      const additions = suggested
        .filter((rule) => !already.has(rule.commands[0] ?? ''))
        .map((rule): RuleDraft => ({ id: rule.id, effect: rule.effect, kind: 'command', pattern: rule.commands[0] ?? '', note: rule.note ?? '' }));
      if (additions.length === 0) {
        setSuggestNote(suggested.length === 0
          ? 'KAI could not find a test, lint or build command to suggest rules from in this project.'
          : 'Every rule KAI could suggest from this project is already in the list below.');
        return;
      }
      setRules((current) => [...current, ...additions]);
      setSaved(null);
      setSuggestNote(`Added ${additions.length} suggested rule${additions.length === 1 ? '' : 's'} from this project's own scripts. Review them below, then save.`);
    } catch (error) {
      setSuggestNote(errorText(error));
    } finally {
      setSuggesting(false);
    }
  }

  async function save(): Promise<void> {
    const hooks = {
      ...(linesToHooks(beforeRun).length ? { beforeRun: linesToHooks(beforeRun) } : {}),
      ...(linesToHooks(afterEdit).length ? { afterEdit: linesToHooks(afterEdit) } : {}),
      ...(linesToHooks(afterRun).length ? { afterRun: linesToHooks(afterRun) } : {}),
      ...(linesToToolHooks(preTool).length ? { preTool: linesToToolHooks(preTool) } : {}),
      ...(linesToToolHooks(postTool).length ? { postTool: linesToToolHooks(postTool) } : {}),
    };
    const permissionRules = draftsToRules(rules);
    const next: ProjectAutomation = {
      ...(checkEnabled || command.trim() ? { autoCheck: { enabled: checkEnabled, ...(command.trim() ? { command: command.trim() } : {}), maxRounds: Math.min(Math.max(Math.round(rounds) || 1, 1), MAX_AUTO_FIX_ROUNDS) } } : {}),
      ...(Object.keys(hooks).length ? { hooks } : {}),
      ...(permissionRules.length ? { permissionRules } : {}),
      ...(review ? { review: { enabled: true } } : {}),
    };
    const ok = await onSave(Object.keys(next).length ? next : null);
    setSaved(ok ? 'Saved.' : null);
  }

  return (
    <div className="automation-card">
      <div className="settings-subsection-title"><span>Around every run in {project.name}</span></div>
      <p className="settings-note">
        These are kept with your KAI settings, not in the repository, so a project you clone cannot make KAI run commands you did not choose.
      </p>
      <label className="toggle-row">
        <span><strong>Check my changes and fix failures</strong><small>After a run that edits files, run the check below and send any failure back to the agent</small></span>
        <input type="checkbox" checked={checkEnabled} onChange={(event) => { setCheckEnabled(event.target.checked); setSaved(null); }} />
      </label>
      <div className="field-grid">
        <label className="field">
          <span>Check command</span>
          <input value={command} placeholder="Blank uses what KAI detects, such as npm test" onChange={(event) => { setCommand(event.target.value); setSaved(null); }} />
        </label>
        <label className="field">
          <span>Automatic fix attempts</span>
          <input type="number" min={1} max={MAX_AUTO_FIX_ROUNDS} value={rounds} onChange={(event) => { setRounds(Number(event.target.value)); setSaved(null); }} />
        </label>
      </div>
      <label className="toggle-row">
        <span><strong>Review the change before calling it done</strong><small>A second model reads the diff against your request. Uses the Prompt Guide or Direct API connection</small></span>
        <input type="checkbox" checked={review} onChange={(event) => { setReview(event.target.checked); setSaved(null); }} />
      </label>
      <div className="settings-subsection-title"><span>Hooks</span></div>
      <p className="settings-note">One command per line, run in the project folder. A failing beforeRun hook stops the run; what it prints is given to the agent. The others only report problems.</p>
      <label className="field"><span>Before a run</span><textarea rows={2} value={beforeRun} onChange={(event) => { setBeforeRun(event.target.value); setSaved(null); }} /></label>
      <label className="field"><span>After a run that edited files, for example a formatter</span><textarea rows={2} value={afterEdit} onChange={(event) => { setAfterEdit(event.target.value); setSaved(null); }} /></label>
      <label className="field"><span>After every run</span><textarea rows={2} value={afterRun} onChange={(event) => { setAfterRun(event.target.value); setSaved(null); }} /></label>
      <div className="settings-subsection-title"><span>Around each tool call</span></div>
      <p className="settings-note">
        One command per line, optionally written as <code>tool-glob :: command</code>. A failing preTool hook blocks the call; a postTool hook's output is added to the result. These apply in full to KAI's own API runs. Claude Code receives whole-tool denials where its flags can express them; the other CLIs keep their own tool handling.
      </p>
      <label className="field"><span>Before a tool call</span><textarea rows={2} value={preTool} placeholder="run_command :: npm run lint" onChange={(event) => { setPreTool(event.target.value); setSaved(null); }} /></label>
      <label className="field"><span>After a tool call</span><textarea rows={2} value={postTool} placeholder="write_file :: npm run format" onChange={(event) => { setPostTool(event.target.value); setSaved(null); }} /></label>
      <div className="settings-subsection-title"><span>Permission rules</span></div>
      <p className="settings-note">
        Rules sit on top of the access mode. A base refusal is never undone; otherwise Deny beats Ask, and Ask beats Allow. Tool and path patterns accept <code>*</code> and <code>**</code>; command patterns match the beginning of a command. They are enforced in full on KAI's API runs; Claude Code receives whole-tool denials where its flags can express them, and the other CLIs keep their own tool handling.
      </p>
      {rules.length === 0 ? <p className="settings-note">No rules for this project.</p> : (
        <div className="automation-stack">
          {rules.map((rule, index) => (
            <div className="field-grid" key={rule.id}>
              <label className="field"><span>Effect</span><select value={rule.effect} onChange={(event) => { const effect = event.target.value as PermissionRule['effect']; setRules((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, effect } : item)); setSaved(null); }}><option value="deny">Deny</option><option value="ask">Ask</option><option value="allow">Allow</option></select></label>
              <label className="field"><span>Matches</span><select value={rule.kind} onChange={(event) => { const kind = event.target.value as RuleKind; setRules((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, kind } : item)); setSaved(null); }}><option value="tool">Tool name</option><option value="command">Command starts with</option><option value="path">Project path</option></select></label>
              <label className="field"><span>Pattern</span><input value={rule.pattern} placeholder={rule.kind === 'tool' ? 'mcp_*' : rule.kind === 'command' ? 'git push' : 'src/**'} onChange={(event) => { const pattern = event.target.value; setRules((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, pattern } : item)); setSaved(null); }} /></label>
              <label className="field"><span>Reason shown when it applies</span><input value={rule.note} placeholder="Ask before publishing" onChange={(event) => { const note = event.target.value; setRules((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, note } : item)); setSaved(null); }} /></label>
              <div className="button-row align-start">
                <button type="button" className="icon-button danger-button" aria-label="Remove rule" onClick={() => { setRules((current) => current.filter((_item, itemIndex) => itemIndex !== index)); setSaved(null); }}><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="button-row align-start">
        <button type="button" className="secondary-button" onClick={() => { setRules((current) => [...current, { id: crypto.randomUUID(), effect: 'ask', kind: 'command', pattern: '', note: '' }]); setSaved(null); }}><Plus size={15} /><span>Add rule</span></button>
        <button type="button" className="secondary-button" disabled={suggesting} title="Reads this project's own test, lint and build scripts and proposes an allow rule for each" onClick={() => void suggestRules()}><Wand2 size={15} /><span>{suggesting ? 'Looking at the project…' : 'Suggest rules from this project'}</span></button>
        {suggestNote && <span className="settings-feedback" role="status">{suggestNote}</span>}
      </div>
      <div className="button-row align-start">
        <button type="button" className="primary-button" disabled={busy} onClick={() => void save()}><Check size={16} /><span>Save automation</span></button>
        {saved && <span className="settings-feedback success" role="status">{saved}</span>}
      </div>
    </div>
  );
}

function SchedulesCard({ projectId }: { projectId: string }): ReactNode {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [agent, setAgent] = useState<Agent>('claude');
  const [direct, setDirect] = useState(true);
  const [useApi, setUseApi] = useState(false);
  const [autonomy, setAutonomy] = useState<'plan' | 'full'>('plan');
  const [kind, setKind] = useState<'interval' | 'daily'>('daily');
  const [minutes, setMinutes] = useState(60);
  const [time, setTime] = useState('07:30');

  const reload = useCallback(async () => {
    try {
      setSchedules(unwrap(await window.kaiDesktop.listSchedules(projectId)));
      setError(null);
    } catch (caught) {
      setError(errorText(caught));
    }
  }, [projectId]);
  useEffect(() => { void reload(); }, [reload]);

  async function add(): Promise<void> {
    setWorking('add');
    try {
      unwrap(await window.kaiDesktop.saveSchedule({
        projectId, name, prompt, agent, execution: useApi ? 'api' : 'cli', route: direct ? 'direct' : 'proxy', autonomy, enabled: true,
        frequency: kind === 'daily' ? { kind: 'daily', at: time } : { kind: 'interval', everyMinutes: Math.round(minutes) },
      }));
      setName('');
      setPrompt('');
      await reload();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setWorking(null);
    }
  }

  async function toggle(schedule: Schedule): Promise<void> {
    const { createdAt: _createdAt, lastRunAt: _lastRunAt, lastStatus: _lastStatus, lastSummary: _lastSummary, lastConversationId: _lastConversationId, ...input } = schedule;
    try {
      unwrap(await window.kaiDesktop.saveSchedule({ ...input, enabled: !schedule.enabled }));
      await reload();
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  async function runNow(schedule: Schedule): Promise<void> {
    setWorking(schedule.id);
    try {
      unwrap(await window.kaiDesktop.runScheduleNow(schedule.id));
      await reload();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setWorking(null);
    }
  }

  async function remove(schedule: Schedule): Promise<void> {
    if (!(await confirmDialog({ title: 'Delete schedule?', detail: `Stop and remove "${schedule.name}"? Conversations it already created stay.`, confirmLabel: 'Delete schedule', destructive: true }))) return;
    try {
      unwrap(await window.kaiDesktop.deleteSchedule(schedule.id));
      await reload();
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  const ready = name.trim() && prompt.trim() && (kind === 'daily' ? /^\d\d:\d\d$/.test(time) : minutes >= 15);
  return (
    <div className="automation-card">
      <div className="settings-subsection-title"><span>Scheduled goals</span></div>
      <p className="settings-note">
        Runs while KAI is open, one at a time, each in its own conversation. If a run came due while KAI was closed it runs once when KAI next starts.
        A scheduled run cannot answer questions, so it either only reads (Plan) or acts without asking (Full access).
      </p>
      {error && <p className="settings-feedback error" role="alert">{error}</p>}
      {schedules.length === 0 ? <p className="settings-note">No schedules for this project yet.</p> : (
        <ul className="automation-list">
          {schedules.map((schedule) => (
            <li key={schedule.id} className="automation-row">
              <div className="automation-row-main">
                <strong>{schedule.name}</strong>
                <small>
                  {schedule.frequency.kind === 'daily' ? `Daily at ${schedule.frequency.at}` : `Every ${schedule.frequency.everyMinutes} min`}
                  {' · '}{schedule.autonomy === 'full' ? 'Full access' : 'Plan (read only)'}
                  {' · '}Last run {formatWhen(schedule.lastRunAt)}{schedule.lastStatus ? `, ${schedule.lastStatus}` : ''}
                </small>
                {schedule.lastSummary && <small className={schedule.lastStatus === 'failed' ? 'field-error' : ''}>{schedule.lastSummary}</small>}
              </div>
              <div className="automation-row-actions">
                <label className="toggle-inline"><input type="checkbox" checked={schedule.enabled} onChange={() => void toggle(schedule)} /><span>On</span></label>
                <button type="button" className="secondary-button compact" disabled={working !== null} onClick={() => void runNow(schedule)}><Play size={14} /><span>{working === schedule.id ? 'Running' : 'Run now'}</span></button>
                <button type="button" className="icon-button danger-button" aria-label={`Delete ${schedule.name}`} onClick={() => void remove(schedule)}><Trash2 size={14} /></button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="field-grid">
        <label className="field"><span>Name</span><input value={name} placeholder="Nightly test run" onChange={(event) => setName(event.target.value)} /></label>
        <label className="field"><span>Agent</span><Select value={agent} onChange={(event) => setAgent(event.target.value as Agent)}>{AGENT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></label>
        <label className="field"><span>When</span><Select value={kind} onChange={(event) => setKind(event.target.value as 'interval' | 'daily')}><option value="daily">Every day</option><option value="interval">Every N minutes</option></Select></label>
        {kind === 'daily'
          ? <label className="field"><span>Time</span><input type="time" value={time} onChange={(event) => setTime(event.target.value)} /></label>
          : <label className="field"><span>Minutes (15 or more)</span><input type="number" min={15} max={10080} value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} /></label>}
        <label className="field"><span>Access</span><Select value={autonomy} onChange={(event) => setAutonomy(event.target.value as 'plan' | 'full')}><option value="plan">Plan (read only)</option><option value="full">Full access</option></Select></label>
      </div>
      <label className="field"><span>What should the agent do?</span><textarea rows={3} value={prompt} placeholder="Run the test suite and summarise anything failing" onChange={(event) => setPrompt(event.target.value)} /></label>
      <label className="toggle-row"><span><strong>Use the direct API instead of the agent CLI</strong><small>Runs on the model chosen under Settings, Direct API</small></span><input type="checkbox" checked={useApi} onChange={(event) => setUseApi(event.target.checked)} /></label>
      <label className="toggle-row"><span><strong>Sign in directly</strong><small>Off sends the run through the Universal Proxy</small></span><input type="checkbox" checked={direct} onChange={(event) => setDirect(event.target.checked)} /></label>
      {autonomy === 'full' && <p className="settings-note">Full access lets this schedule edit files and run commands with nobody watching. Spend is still capped per run.</p>}
      <div className="button-row align-start">
        <button type="button" className="primary-button" disabled={!ready || working !== null} onClick={() => void add()}><Plus size={16} /><span>Add schedule</span></button>
      </div>
    </div>
  );
}

function EvalsCard({ projectId }: { projectId: string }): ReactNode {
  const [overview, setOverview] = useState<EvalOverview>({ cases: [], results: [] });
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [check, setCheck] = useState('');
  const [agents, setAgents] = useState<Record<string, Agent>>({});
  const [comparisonAgents, setComparisonAgents] = useState<Record<string, Agent>>({});
  const [comparison, setComparison] = useState<{ caseId: string; left: EvalResult; right: EvalResult } | null>(null);

  const reload = useCallback(async () => {
    try {
      setOverview(unwrap(await window.kaiDesktop.listEvals(projectId)));
      setError(null);
    } catch (caught) {
      setError(errorText(caught));
    }
  }, [projectId]);
  useEffect(() => { void reload(); }, [reload]);

  async function save(): Promise<void> {
    try {
      unwrap(await window.kaiDesktop.saveEvalCase({ projectId, name, prompt, check }));
      setName('');
      setPrompt('');
      setCheck('');
      await reload();
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  async function run(caseId: string): Promise<void> {
    setRunning(caseId);
    setError(null);
    setComparison(null);
    try {
      unwrap(await window.kaiDesktop.runEval({ caseId, projectId, agent: agents[caseId] ?? 'claude', execution: 'cli', route: 'direct' }));
      await reload();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setRunning(null);
    }
  }

  async function compare(caseId: string): Promise<void> {
    const leftAgent = agents[caseId] ?? 'claude';
    const rightAgent = comparisonAgents[caseId] ?? (leftAgent === 'claude' ? 'codex' : 'claude');
    if (leftAgent === rightAgent) {
      setError('Choose two different agents to compare.');
      return;
    }
    setRunning(caseId);
    setError(null);
    setComparison(null);
    try {
      const runAgent = async (agent: Agent): Promise<EvalResult> => unwrap(await window.kaiDesktop.runEval({
        caseId, projectId, agent, execution: 'cli', route: 'direct',
      }));
      // Each replay uses the eval's same pinned commit and a fresh disposable worktree.
      const left = await runAgent(leftAgent);
      const right = await runAgent(rightAgent);
      setComparison({ caseId, left, right });
      await reload();
    } catch (caught) {
      await reload();
      setError(errorText(caught));
    } finally {
      setRunning(null);
    }
  }

  async function remove(caseId: string, caseName: string): Promise<void> {
    if (!(await confirmDialog({ title: 'Delete eval?', detail: `Remove "${caseName}" and its results?`, confirmLabel: 'Delete eval', destructive: true }))) return;
    try {
      unwrap(await window.kaiDesktop.deleteEvalCase(projectId, caseId));
      await reload();
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  const names = new Map(overview.cases.map((item) => [item.id, item.name]));
  return (
    <div className="automation-card">
      <div className="settings-subsection-title"><span>Evals</span></div>
      <p className="settings-note">
        Save a task once, then replay it on any agent. Each run starts from the same commit in a disposable copy of the project, acts without asking, and passes when your check command exits 0. Your own files are never touched.
      </p>
      {error && <p className="settings-feedback error" role="alert">{error}</p>}
      {overview.cases.length === 0 ? <p className="settings-note">No evals for this project yet.</p> : (
        <ul className="automation-list">
          {overview.cases.map((item) => (
            <li key={item.id} className="automation-row">
              <div className="automation-row-main">
                <strong>{item.name}</strong>
                <small>Check: {item.check} · from {item.baseRef.slice(0, 8)}</small>
              </div>
              <div className="automation-row-actions">
                <Select value={agents[item.id] ?? 'claude'} onChange={(event) => setAgents({ ...agents, [item.id]: event.target.value as Agent })}>
                  {AGENT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </Select>
                <Select aria-label={`Second agent to compare on ${item.name}`} value={comparisonAgents[item.id] ?? ((agents[item.id] ?? 'claude') === 'claude' ? 'codex' : 'claude')} onChange={(event) => setComparisonAgents({ ...comparisonAgents, [item.id]: event.target.value as Agent })}>
                  {AGENT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </Select>
                <button type="button" className="secondary-button compact" disabled={running !== null} onClick={() => void run(item.id)}><Play size={14} /><span>{running === item.id ? 'Running' : 'Run'}</span></button>
                <button type="button" className="secondary-button compact" disabled={running !== null} onClick={() => void compare(item.id)}><span>{running === item.id ? 'Comparing' : 'Compare both'}</span></button>
                <button type="button" className="icon-button danger-button" aria-label={`Delete ${item.name}`} onClick={() => void remove(item.id, item.name)}><Trash2 size={14} /></button>
              </div>
              {comparison?.caseId === item.id && (
                <div className="eval-comparison" aria-label={`Comparison for ${item.name}`}>
                  {[comparison.left, comparison.right].map((result) => (
                    <div className="eval-comparison-result" key={result.id}>
                      <strong>{result.agent}</strong>
                      <span className={result.passed ? 'pass' : 'fail'}>{result.passed ? 'Passed' : result.agentCompleted ? 'Failed' : 'Errored'}</span>
                      <small>{formatDuration(result.durationMs)} · {result.filesChanged} files · {result.costUsd === undefined ? 'cost unavailable' : `$${result.costUsd.toFixed(2)}`}</small>
                    </div>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {overview.results.length > 0 && (
        <table className="automation-table">
          <thead><tr><th>Eval</th><th>Agent</th><th>Result</th><th>Time</th><th>Files</th><th>Cost</th></tr></thead>
          <tbody>
            {overview.results.slice(0, 12).map((result) => (
              <tr key={result.id} title={result.error ?? result.outputTail}>
                <td>{names.get(result.caseId) ?? 'Deleted eval'}</td>
                <td>{result.agent}{result.model ? ` · ${result.model}` : ''}</td>
                <td className={result.passed ? 'pass' : 'fail'}>{result.passed ? 'Passed' : result.agentCompleted ? 'Failed' : 'Errored'}</td>
                <td>{formatDuration(result.durationMs)}</td>
                <td>{result.filesChanged}</td>
                <td>{result.costUsd === undefined ? '-' : `$${result.costUsd.toFixed(2)}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="field-grid">
        <label className="field"><span>Name</span><input value={name} placeholder="Fix the date parser" onChange={(event) => setName(event.target.value)} /></label>
        <label className="field"><span>Check command (exit 0 passes)</span><input value={check} placeholder="npm test" onChange={(event) => setCheck(event.target.value)} /></label>
      </div>
      <label className="field"><span>The task</span><textarea rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
      <div className="button-row align-start">
        <button type="button" className="primary-button" disabled={!name.trim() || !prompt.trim() || !check.trim()} onClick={() => void save()}><Plus size={16} /><span>Save from the current commit</span></button>
      </div>
    </div>
  );
}

function ScorecardsCard(): ReactNode {
  const [cards, setCards] = useState<AgentScorecard[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.kaiDesktop.scorecards().then(unwrap).then((value) => { if (!cancelled) setCards(value); }).catch(() => { if (!cancelled) setCards([]); });
    return () => { cancelled = true; };
  }, []);
  return (
    <div className="automation-card">
      <div className="settings-subsection-title"><span>Agent scorecards</span></div>
      <p className="settings-note">
        How each agent does on the work you give it. A run is clean when it finishes with no failing check and no fix round. When an agent is clean in fewer than half of its last runs at a level, Auto model sends that kind of work one level up.
      </p>
      {cards === null ? null : cards.length === 0 ? <p className="settings-note">Nothing recorded yet. Scores appear as you run agents.</p> : (
        <table className="automation-table">
          <thead><tr><th>Agent</th><th>Work</th><th>Runs</th><th>Clean</th><th>Median time</th><th>Cost</th><th /></tr></thead>
          <tbody>
            {cards.map((card) => (
              <tr key={`${card.agent}-${card.execution}-${card.level}`}>
                <td>{card.agent}{card.execution === 'api' ? ' (API)' : ''}</td>
                <td>{card.level}</td>
                <td>{card.runs}</td>
                <td>{Math.round(card.cleanRate * 100)}%</td>
                <td>{formatDuration(card.medianDurationMs)}</td>
                <td>{card.totalCostUsd > 0 ? `$${card.totalCostUsd.toFixed(2)}` : '-'}</td>
                <td>{card.escalated ? <span className="fail">Sent up a level</span> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
