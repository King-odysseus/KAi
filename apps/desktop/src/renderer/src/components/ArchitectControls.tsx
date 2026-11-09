import { Compass, Hammer, LifeBuoy, Loader2, Square, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  directProviderPreset,
  roleTargetKey,
  type AgentCapability,
  type ArchitectReadiness,
  type ArchitectRole,
  type ArchitectSplit,
  type ArchitectStatus,
  type RoleTarget,
} from '@kai/contracts';
import { unwrap } from '../types';
import { promptDialog } from './AppDialog';
import {
  CUSTOM_ROLE_MODEL,
  adoptSplit,
  modelOf,
  readLastSplit,
  readStoredSplit,
  roleModelOptions,
  splitFor,
  splitProblem,
  tabKeyFor,
  targetFromValue,
  targetOptions,
  targetValue,
  withModel,
  withRole,
  writeStoredSplit,
  NEW_TAB,
} from './architect-settings';
import { UiButton } from './UiButton';
import { OptionMenu } from './ui/OptionMenu';
import { Switch } from './ui/Switch';

/**
 * The Architect / Implementer split, as the composer shows it.
 *
 * `useArchitectSplit` owns the state and the remembering; `ArchitectToggle` is the switch on the toolbar and
 * `ArchitectRow` the three pickers that appear under it once it is on. They are split so the switch can sit with the
 * toolbar's other controls while the longer row sits below it.
 */

export interface ArchitectSplitState {
  split: ArchitectSplit;
  setEnabled(enabled: boolean): void;
  setRole(role: ArchitectRole, target: RoleTarget | null): void;
  /** Why a run cannot start yet, or null. */
  problem: string | null;
  readiness: ReadonlyMap<string, ArchitectReadiness>;
  credentialIds: readonly string[];
  liveModels: ReadonlyMap<string, readonly string[]>;
  capabilities: readonly AgentCapability[];
}

const ROLES: ReadonlyArray<{ role: ArchitectRole; label: string; short: string; hint: string }> = [
  { role: 'architect', label: 'Architect', short: 'Plans and reviews', hint: 'Plans the work, reviews it, and sends it back until it is right. Never writes the code.' },
  { role: 'implementer', label: 'Implementer', short: 'Builds', hint: 'Builds what the Architect planned.' },
  { role: 'fallback', label: 'Fallback', short: 'If the Architect is down', hint: 'Takes the Architect\'s place if the Architect is not available. Left empty, the Implementer does.' },
];

function modelCacheKey(target: RoleTarget): string {
  const api = target.api!;
  return `${api.provider}:${api.credentialId ?? directProviderPreset(api.provider).credentialId}`;
}

export function useArchitectSplit(input: {
  conversationId: string | null | undefined;
  recorded: ArchitectSplit | undefined;
  windowId: number | undefined;
  capabilities: readonly AgentCapability[];
  onChange?: (split: ArchitectSplit) => void;
}): ArchitectSplitState {
  const { conversationId, recorded, windowId, capabilities } = input;
  const tab = tabKeyFor(conversationId);
  const [split, setSplit] = useState<ArchitectSplit>(() =>
    splitFor({ stored: readStoredSplit(tab, windowId), recorded, last: readLastSplit(windowId) }));
  const previousTab = useRef(tab);
  const [credentialIds, setCredentialIds] = useState<readonly string[]>([]);
  const [readiness, setReadiness] = useState<ReadonlyMap<string, ArchitectReadiness>>(new Map());
  const [liveModels, setLiveModels] = useState<ReadonlyMap<string, readonly string[]>>(new Map());
  const onChange = useRef(input.onChange);
  onChange.current = input.onChange;

  // A different tab shows that tab's own choice. A new tab that just became a conversation keeps what it had.
  useEffect(() => {
    if (previousTab.current === tab) return;
    if (previousTab.current === NEW_TAB) adoptSplit(NEW_TAB, tab, windowId);
    previousTab.current = tab;
    setSplit(splitFor({ stored: readStoredSplit(tab, windowId), recorded, last: readLastSplit(windowId) }));
  }, [tab, recorded, windowId]);

  // A reopened conversation whose record arrives after the tab is shown.
  useEffect(() => {
    if (readStoredSplit(tab, windowId)) return;
    if (recorded) setSplit(recorded);
  }, [recorded, tab, windowId]);

  useEffect(() => { onChange.current?.(split); }, [split]);

  const update = useCallback((next: ArchitectSplit) => {
    setSplit(next);
    writeStoredSplit(tab, next, windowId);
  }, [tab, windowId]);

  const setEnabled = useCallback((enabled: boolean) => update({ ...split, enabled }), [split, update]);
  const setRole = useCallback((role: ArchitectRole, target: RoleTarget | null) => update(withRole(split, role, target)), [split, update]);

  // Which APIs have a key saved. Read when the composer appears and again whenever the window regains focus, so a key
  // added in Settings shows up without a restart.
  useEffect(() => {
    let alive = true;
    const load = (): void => {
      void window.kaiDesktop.credentialStatus().then(unwrap).then((status) => { if (alive) setCredentialIds(status.ids); }).catch(() => undefined);
    };
    load();
    window.addEventListener('focus', load);
    return () => { alive = false; window.removeEventListener('focus', load); };
  }, []);

  // The models each chosen API reports, asked for once per connection. A failure leaves the shipped list in place.
  const wanted = useMemo(() => [split.architect, split.implementer, split.fallback].filter((target): target is RoleTarget => target?.execution === 'api' && Boolean(target.api)), [split]);
  useEffect(() => {
    for (const target of wanted) {
      const key = modelCacheKey(target);
      if (liveModels.has(key)) continue;
      const api = target.api!;
      const preset = directProviderPreset(api.provider);
      void window.kaiDesktop.listProviderModels({
        provider: api.provider,
        baseUrl: api.baseUrl ?? preset.defaultBaseUrl,
        credentialId: api.credentialId ?? preset.credentialId,
      }).then(unwrap).then((catalog) => {
        setLiveModels((current) => new Map(current).set(key, catalog.source === 'live' ? catalog.models : []));
      }).catch(() => setLiveModels((current) => new Map(current).set(key, [])));
    }
  }, [wanted, liveModels]);

  // Whether each chosen role can run right now, so one that cannot is marked before the person sends.
  useEffect(() => {
    if (!split.enabled) return;
    let alive = true;
    const targets = [split.architect, split.implementer, split.fallback].filter((target): target is RoleTarget => target !== null);
    void Promise.all(targets.map(async (target) => {
      const result = await window.kaiDesktop.architectReady(target).then(unwrap).catch((): ArchitectReadiness => ({ ready: true, label: '' }));
      return [roleTargetKey(target), result] as const;
    })).then((entries) => { if (alive) setReadiness(new Map(entries)); });
    return () => { alive = false; };
  }, [split, credentialIds]);

  return { split, setEnabled, setRole, problem: splitProblem(split), readiness, credentialIds, liveModels, capabilities };
}

/** The switch, as a row that says what it does. It lives in the run options panel, under its own heading. */
export function ArchitectToggle({ state, disabled }: { state: ArchitectSplitState; disabled?: boolean }): ReactNode {
  return (
    <label className="flex w-full cursor-pointer items-center gap-2.5 text-xs text-[var(--text)]" title="Let one agent plan and review while another builds">
      <Switch checked={state.split.enabled} disabled={disabled} aria-label="Plan and review with an Architect, build with an Implementer" onChange={(event) => state.setEnabled(event.target.checked)} />
      <span className="flex min-w-0 flex-col">
        <span>Use an Architect and an Implementer</span>
        <small className="text-[11px] leading-snug text-[var(--text-dim)]">One agent plans and reviews, another builds. Applies to normal sends and to Auto.</small>
      </span>
    </label>
  );
}

/**
 * The small chip on the toolbar while the split is on: "A&I" for Architect and Implementer. The controls live in the
 * run options panel, so this is what says the split is active when that panel is closed. It names who is who on
 * hover, turns amber when something needs attention, and opens the panel when clicked.
 */
export function ArchitectChip({ state, onOpen }: { state: ArchitectSplitState; onOpen: () => void }): ReactNode {
  if (!state.split.enabled) return null;
  const names = Object.fromEntries(state.capabilities.map((capability) => [capability.id, capability.displayName]));
  const notReady = [state.split.architect, state.split.implementer, state.split.fallback].flatMap((target) => {
    const result = target ? state.readiness.get(roleTargetKey(target)) : undefined;
    return result && !result.ready ? [`${result.label || 'A role'} is not ready${result.reason ? `: ${result.reason}` : ''}`] : [];
  });
  const trouble = state.problem ?? notReady[0] ?? null;
  const title = [splitSummary(state.split, names), trouble ? `Needs attention: ${trouble}` : null, 'Click to change'].filter(Boolean).join('. ');
  return (
    <UiButton
      type="button"
      variant="secondary"
      className={`!min-h-6 !gap-1 !rounded-full !px-2 !text-[11px] ${trouble ? '!border-[color:var(--waiting)] !text-[var(--waiting)]' : ''}`}
      aria-label="Architect and Implementer are on. Open run options to change them"
      title={title}
      onClick={onOpen}
    >
      <Compass size={13} aria-hidden="true" />
      <span>A&amp;I</span>
    </UiButton>
  );
}

/** The three pickers: who plans and reviews, who builds, and who stands in for the Architect. */
export function ArchitectRow({ state, disabled }: { state: ArchitectSplitState; disabled?: boolean }): ReactNode {
  if (!state.split.enabled) return null;
  const current = [state.split.architect, state.split.implementer, state.split.fallback];
  return (
    <div className="flex w-full flex-col gap-2.5">
      {ROLES.map(({ role, label, short, hint }) => {
        const target = state.split[role];
        const ready = target ? state.readiness.get(roleTargetKey(target)) : undefined;
        const live = target?.execution === 'api' && target.api ? state.liveModels.get(modelCacheKey(target)) : undefined;
        const targets = targetOptions(role, { capabilities: state.capabilities, credentialIds: state.credentialIds, current });
        const options = role === 'fallback'
          ? [{ value: '', label: 'Same as Implementer' }, ...targets]
          : [{ value: '', label: 'Choose…' }, ...targets];
        const icon = role === 'architect' ? <Compass size={13} /> : role === 'implementer' ? <Hammer size={13} /> : <LifeBuoy size={13} />;
        return (
          <div key={role} className="flex flex-wrap items-center gap-1.5" role="group" aria-label={label}>
            <span className="flex w-[8.5rem] shrink-0 flex-col" title={hint}>
              <span className="text-xs font-medium text-[var(--text)]">{label}</span>
              <small className="text-[11px] leading-snug text-[var(--text-dim)]">{short}</small>
            </span>
            <OptionMenu
              ariaLabel={label}
              disabled={disabled}
              icon={icon}
              tone={ready && !ready.ready ? 'unavailable' : undefined}
              onChange={(value) => state.setRole(role, targetFromValue(value, target))}
              options={options}
              title={ready && !ready.ready ? `${hint} Not ready: ${ready.reason ?? 'unavailable'}` : hint}
              value={targetValue(target)}
            />
            {target && (
              <OptionMenu
                ariaLabel={`${label} model`}
                disabled={disabled}
                onChange={(value) => {
                  if (value !== CUSTOM_ROLE_MODEL) { state.setRole(role, withModel(target, value)); return; }
                  void promptDialog({ title: `Model for the ${label}`, label: 'Model name', initialValue: modelOf(target), placeholder: 'provider/model-name', confirmLabel: 'Use model' })
                    .then((typed) => { if (typed) state.setRole(role, withModel(target, typed.trim())); });
                }}
                options={roleModelOptions(role, target, live)}
                title={`Which model the ${label.toLowerCase()} uses`}
                value={modelOf(target)}
              />
            )}
          </div>
        );
      })}
      {state.problem && <span className="text-xs text-[var(--waiting)]" role="note">{state.problem}</span>}
    </div>
  );
}

/** Kept for callers that want only a one-line summary of the split, for a tooltip or status line. */
export function splitSummary(split: ArchitectSplit, names: Readonly<Record<string, string>> = {}): string {
  const name = (target: RoleTarget | null): string => {
    if (!target) return 'not chosen';
    if (target.execution === 'cli') return `${names[target.agent ?? ''] ?? target.agent}${target.model ? ` · ${target.model}` : ''}`;
    const preset = directProviderPreset(target.api!.provider);
    return `${preset.displayName}${target.api!.model ? ` · ${target.api!.model}` : ''}`;
  };
  return `Architect ${name(split.architect)} · Implementer ${name(split.implementer)}`;
}

/** Phases where the split run is still going or is parked on the person. */
export const ARCHITECT_ACTIVE: ReadonlySet<ArchitectStatus['phase']> = new Set([
  'preparing', 'planning', 'implementing', 'reviewing', 'correcting', 'replanning', 'waiting-for-you',
]);

/** The live status of the split run in one conversation, or null when it has never run there. */
export function useArchitectStatus(conversationId: string | null | undefined): ArchitectStatus | null {
  const [status, setStatus] = useState<ArchitectStatus | null>(null);
  useEffect(() => {
    setStatus(null);
    if (!conversationId) return undefined;
    let cancelled = false;
    void window.kaiDesktop.architectStatus({ conversationId }).then((result) => {
      if (!cancelled) setStatus(unwrap(result));
    }).catch(() => undefined);
    const off = window.kaiDesktop.onArchitectChanged((next) => {
      if (next.conversationId === conversationId) setStatus(next);
    });
    return () => { cancelled = true; off(); };
  }, [conversationId]);
  return status;
}

const PHASE_WORDS: Record<ArchitectStatus['phase'], string> = {
  preparing: 'checking that both agents are ready',
  planning: 'planning',
  implementing: 'building from the brief',
  reviewing: 'reviewing the work',
  correcting: 'fixing what was sent back',
  replanning: 'stepping in with a new plan',
  'waiting-for-you': 'waiting for you',
  finished: 'finished',
  stopped: 'stopped',
  failed: 'could not finish',
};

/**
 * One line that says who is working and what they are doing, with the Continue or Finish question when the Architect
 * has not approved after a long time. Shown for a live run, and for a settled one until it is dismissed, so a failure
 * is never missed for having arrived while the person looked elsewhere.
 */
export function ArchitectStatusLine({ status }: { status: ArchitectStatus | null }): ReactNode {
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!status) return null;
  const active = ARCHITECT_ACTIVE.has(status.phase);
  if (!active && dismissed === status.updatedAt) return null;
  const who = status.role === 'architect' ? `Architect · ${status.architectLabel}` : status.role === 'implementer' ? `Implementer · ${status.implementerLabel}` : 'Architect and Implementer';
  const waiting = status.phase === 'waiting-for-you';
  const bad = status.phase === 'failed';
  return (
    <div className={`flex flex-wrap items-center gap-2 pt-1.5 text-xs ${bad ? 'text-[var(--failed)]' : waiting ? 'text-[var(--waiting)]' : 'text-[var(--text-muted)]'}`} role="status" aria-live="polite">
      {active && !waiting && <Loader2 size={12} className="spin" aria-hidden="true" />}
      <strong>{who}</strong>
      <span>{status.message || PHASE_WORDS[status.phase]}{status.round > 0 && active ? ` · round ${status.round}` : ''}</span>
      {status.fallbackUsed && <span title="The Architect was not available, so its stand-in worked instead">· stand-in working</span>}
      {waiting && (
        <>
          <UiButton type="button" className="secondary-button" onClick={() => void window.kaiDesktop.answerArchitect({ conversationId: status.conversationId, carryOn: true })}>Continue</UiButton>
          <UiButton type="button" className="secondary-button" onClick={() => void window.kaiDesktop.answerArchitect({ conversationId: status.conversationId, carryOn: false })}>Finish here</UiButton>
        </>
      )}
      {active && !waiting && (
        <UiButton type="button" className="secondary-button" aria-label="Stop the Architect and Implementer" onClick={() => void window.kaiDesktop.stopArchitect({ conversationId: status.conversationId })}><Square size={11} /> Stop</UiButton>
      )}
      {!active && <UiButton type="button" className="secondary-button" aria-label="Dismiss" onClick={() => setDismissed(status.updatedAt)}><X size={11} /></UiButton>}
    </div>
  );
}
