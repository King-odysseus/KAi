import { useEffect, useState, type ReactNode } from 'react';
import { Check, Cpu, ShieldCheck, Sparkles, Users, X } from 'lucide-react';
import { directProviderPreset } from '@kai/contracts';
import type { GuidedBuild, RoleTarget } from '@kai/contracts';
import { UiButton } from './UiButton';
import { Pill } from './Pill';
import { Dialog } from './ui/Dialog';
import { Select } from './ui/Select';
import { unwrap } from '../types';
import { describeModelCheck } from './guided-build-engine';
import { hasModelTeam, readModelTeam, writeModelTeam } from '../model-team';

/**
 * Plan and team: one place to see who plans, who builds and who checks, how hands-on to be, and what the plan has used.
 *
 * It holds no model logic. The role pickers are the host's own (Workspace and Learn & Code each keep their own list of
 * agents and models), passed in so the same panel can sit on both. The numbers under "So far" are counts of requests that
 * were really sent; the panel never estimates a cost it cannot know.
 */

export interface GuidedBuildTeamPanelProps {
  state: GuidedBuild;
  disabled: boolean;
  projectId: string | null;
  coachLabel: string;
  builderLabel: string;
  builderIsLocal: boolean;
  /** The Builder's target, so its model can be checked against the server that runs it. Null or a CLI agent has nothing to check. */
  builderTarget: RoleTarget | null;
  /** The Coach's target as the host resolved it (a CLI agent when none was chosen), so it can be saved with the team. */
  coachTarget: RoleTarget | null;
  usage: { coachAsks: number; builderRuns: number; strongerRuns: number };
  /** The host's own pickers for the Coach and the Builder (agent and model). */
  rolePickers: ReactNode;
  onChange: (state: GuidedBuild) => void;
  onClose: () => void;
}

const DIAL: ReadonlyArray<{ value: GuidedBuild['handsOn']; title: string; detail: string }> = [
  { value: 'auto', title: 'Do it for me', detail: 'The Builder does each step and KAI checks it. You step in when something is stuck.' },
  { value: 'guided', title: 'Walk me through it', detail: 'The Coach explains each step. You choose who edits it.' },
  { value: 'manual', title: "I'll type, you check", detail: 'You write the code. The Coach and KAI check it.' },
];

export function GuidedBuildTeamPanel(props: GuidedBuildTeamPanelProps): ReactNode {
  const { state, disabled, projectId, coachLabel, builderLabel, builderIsLocal, builderTarget, coachTarget, usage, rolePickers, onChange, onClose } = props;
  const [checkCommand, setCheckCommand] = useState<string | null | undefined>(undefined);
  const [savedTeam, setSavedTeam] = useState(() => readModelTeam());
  const [modelCheck, setModelCheck] = useState<{ tone: 'success' | 'warning' | 'error'; text: string } | 'checking' | null>(null);

  /** Asks the Builder's own server what it has, so a model that is not loaded or has a tiny window is found before a step runs. */
  async function checkBuilderModel(): Promise<void> {
    const api = builderTarget?.execution === 'api' ? builderTarget.api : undefined;
    if (!api) return;
    setModelCheck('checking');
    try {
      const preset = directProviderPreset(api.provider);
      const catalog = unwrap(await window.kaiDesktop.listProviderModels({ provider: api.provider, baseUrl: api.baseUrl ?? preset.defaultBaseUrl, credentialId: api.credentialId ?? preset.credentialId }));
      setModelCheck(describeModelCheck(catalog, api.model ?? ''));
    } catch (error) {
      setModelCheck({ tone: 'error', text: `The check could not run: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  useEffect(() => {
    if (!projectId) { setCheckCommand(null); return undefined; }
    let alive = true;
    void window.kaiDesktop.verificationOverview(projectId).then(unwrap).then((overview) => { if (alive) setCheckCommand(overview.suggestedCommand); }).catch(() => { if (alive) setCheckCommand(null); });
    return () => { alive = false; };
  }, [projectId]);

  const done = state.steps.filter((step) => step.status === 'complete').length;
  const soFar = usage.coachAsks === 0 && usage.builderRuns === 0
    ? 'Nothing has been sent yet.'
    : `The Coach was asked ${usage.coachAsks} ${usage.coachAsks === 1 ? 'time' : 'times'}. The Builder built ${usage.builderRuns} ${usage.builderRuns === 1 ? 'step' : 'steps'}${usage.strongerRuns > 0 ? `, ${usage.strongerRuns} of them on a stronger model you chose` : ''}.`;

  return (
    <Dialog size="3xl" dismissible onClose={onClose} titleId="guided-build-team-title">
      <section className="flex max-h-[80vh] flex-col gap-5 overflow-y-auto p-5" aria-label="Plan and team">
        <header className="flex items-start gap-3">
          <Users size={18} className="mt-1 text-[var(--accent)]" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 id="guided-build-team-title" className="m-0 text-base font-semibold">Plan and team</h2>
            <p className="m-0 text-xs text-[var(--text-dim)]">Who plans, who builds and who checks, and how much of it you want to do yourself. Changes apply to this plan.</p>
          </div>
          <UiButton type="button" className="icon-button" aria-label="Close Plan and team" onClick={onClose}><X size={17} /></UiButton>
        </header>

        <div>
          <h3 className="m-0 mb-2 text-sm font-semibold">How hands-on?</h3>
          <div className="grid gap-2 sm:grid-cols-3" role="group" aria-label="How hands-on">
            {DIAL.map((option) => (
              <button key={option.value} type="button" disabled={disabled} aria-pressed={state.handsOn === option.value}
                className={`rounded-lg border p-3 text-left text-sm ${state.handsOn === option.value ? 'border-[color:var(--accent)] bg-[var(--bg-raised)]' : 'border-[color:var(--border-soft)] bg-[var(--bg-panel)] hover:bg-[var(--bg-raised)]'}`}
                onClick={() => onChange({ ...state, handsOn: option.value })}>
                <span className="flex items-center gap-2 font-semibold">{state.handsOn === option.value && <Check size={14} aria-hidden="true" />}{option.title}</span>
                <span className="mt-1 block text-xs text-[var(--text-dim)]">{option.detail}</span>
              </button>
            ))}
          </div>
          <p className="m-0 mt-2 text-xs text-[var(--text-dim)]">You can still choose differently on any single step with the buttons under the Coach's message.</p>
        </div>

        <div className="grid gap-3 rounded-lg border border-[color:var(--border-soft)] bg-[var(--bg-panel)] p-3">
          <div className="flex items-start gap-3">
            <Sparkles size={16} className="mt-0.5 text-[var(--accent)]" aria-hidden="true" />
            <div className="min-w-0 flex-1"><strong className="text-sm">Coach</strong><p className="m-0 text-xs text-[var(--text-dim)]">Makes the plan, explains, and checks each step. Never edits.</p></div>
            <Pill tone="info">{coachLabel}</Pill>
          </div>
          <div className="flex items-start gap-3">
            <Cpu size={16} className="mt-0.5 text-[var(--accent)]" aria-hidden="true" />
            <div className="min-w-0 flex-1"><strong className="text-sm">Builder</strong><p className="m-0 text-xs text-[var(--text-dim)]">Makes one small edit at a time. {builderIsLocal ? 'Runs on your own models, so it does not use your subscription.' : 'Runs on a paid or subscription model.'}</p></div>
            <Pill tone={builderIsLocal ? 'success' : 'neutral'}>{builderLabel}</Pill>
          </div>
          {builderTarget?.execution === 'api' && builderTarget.api && (
            <div className="flex flex-wrap items-center gap-2 pl-7 text-xs">
              <UiButton type="button" className="secondary-button" disabled={disabled || modelCheck === 'checking'} onClick={() => void checkBuilderModel()}>{modelCheck === 'checking' ? 'Checking…' : 'Check the Builder model'}</UiButton>
              {modelCheck && modelCheck !== 'checking' && <span className="min-w-0 flex-1" role="status"><Pill tone={modelCheck.tone === 'error' ? 'error' : modelCheck.tone === 'warning' ? 'warning' : 'success'}>{modelCheck.tone === 'success' ? 'Ready' : modelCheck.tone === 'warning' ? 'Check this' : 'Problem'}</Pill> <span className="text-[var(--text-dim)]">{modelCheck.text}</span></span>}
            </div>
          )}
          <label className="flex flex-wrap items-center gap-2 pl-7 text-xs text-[var(--text-muted)]">If the Builder is stuck
            <Select aria-label="If the Builder is stuck" value={state.builderLock} disabled={disabled} onChange={(event) => onChange({ ...state, builderLock: event.target.value as GuidedBuild['builderLock'] })}>
              <option value="escalate">Offer a stronger model for that step</option>
              <option value="pinned">Always use this model</option>
            </Select>
          </label>
          <div className="flex items-start gap-3">
            <ShieldCheck size={16} className="mt-0.5 text-[var(--accent)]" aria-hidden="true" />
            <div className="min-w-0 flex-1"><strong className="text-sm">Checks</strong>
              <p className="m-0 text-xs text-[var(--text-dim)]">{checkCommand === undefined ? 'Looking for the project’s test command…' : checkCommand ? <>KAI asks before running <code>{checkCommand}</code> to check a step. The Coach cannot pass a step while it fails.</> : 'No test command was found, so the Coach reviews the diff and says plainly that no check ran.'}</p></div>
          </div>
        </div>

        <div>
          <h3 className="m-0 mb-2 text-sm font-semibold">Change the team</h3>
          <div className="rounded-lg border border-[color:var(--border-soft)] p-3">{rolePickers}</div>
        </div>

        <div className="rounded-lg border border-[color:var(--border-soft)] p-3">
          <h3 className="m-0 mb-1 text-sm font-semibold">My Model team</h3>
          <p className="m-0 text-xs text-[var(--text-dim)]">Save this Coach and Builder as the starting point for new Guided Build plans, new Architect and Implementer runs, and new crews. Anything already set up keeps what it has, and each can still be changed.</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <UiButton type="button" className="secondary-button" disabled={disabled || !coachTarget} onClick={() => setSavedTeam(writeModelTeam({ coach: coachTarget, builder: builderTarget }) ? { coach: coachTarget, builder: builderTarget } : savedTeam)}>Use this team for new work</UiButton>
            {hasModelTeam(savedTeam) && <UiButton type="button" className="secondary-button" onClick={() => { writeModelTeam({ coach: null, builder: null }); setSavedTeam({ coach: null, builder: null }); }}>Forget my saved team</UiButton>}
            <span className="text-xs text-[var(--text-dim)]" role="status">{hasModelTeam(savedTeam) ? 'A team is saved.' : 'No team saved yet. New work starts with a local Builder when one is set up.'}</span>
          </div>
        </div>

        <div>
          <h3 className="m-0 mb-1 text-sm font-semibold">So far</h3>
          <p className="m-0 text-sm text-[var(--text)]">{soFar}</p>
          {state.steps.length > 0 && <p className="m-0 mt-1 text-xs text-[var(--text-dim)]">{done} of {state.steps.length} steps done.</p>}
        </div>

        {state.steps.length > 0 && (
          <div>
            <h3 className="m-0 mb-2 text-sm font-semibold">Plan</h3>
            <ol className="m-0 grid list-none gap-1 p-0">
              {state.steps.map((step, index) => (
                <li key={step.id}>
                  <button type="button" disabled={disabled} aria-current={index === state.currentStep ? 'step' : undefined}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-[var(--bg-raised)] ${index === state.currentStep ? 'bg-[var(--bg-raised)] font-semibold' : ''}`}
                    onClick={() => { onChange({ ...state, currentStep: index, review: null }); onClose(); }}>
                    <span className="w-5 text-xs text-[var(--text-dim)]">{index + 1}</span>
                    <span className="min-w-0 flex-1">{step.title}</span>
                    {step.status === 'complete' && <Check size={14} aria-label="Done" />}
                    {step.needsApproval && <Pill tone="warning">Needs your OK</Pill>}
                  </button>
                </li>
              ))}
            </ol>
          </div>
        )}

        <footer className="flex justify-end"><UiButton type="button" className="primary-button" onClick={onClose}>Done</UiButton></footer>
      </section>
    </Dialog>
  );
}
