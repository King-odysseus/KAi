import { ChevronDown, ChevronRight, CircleHelp, ExternalLink, Play, Search, X } from 'lucide-react';
import { Markdown } from './Markdown';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_AWAY_POLICY } from '@kai/contracts';
import type { CrewAwayPolicy, CrewChatEntry, CrewFeedEntry, CrewRun } from '@kai/contracts';
import { collapseFeed } from '../crew-feed';
import { ROUTE_LABEL, routeMessage, type CrewRoute } from '../crew-routing';
import { CrewApprovals } from './CrewApprovals';
import { Switch } from './ui/Switch';
import { Select } from './ui/Select';
import { Toggle } from './ui/Toggle';
import { UiTextInput } from './UiTextInput';
import { Composer, ComposerInput, ComposerPause, ComposerSend, ComposerStop, ComposerToolbar } from './ui/Composer';
import { UiButton } from './UiButton';

/** What the person picked: let the Lead work it out, or force one kind of message. */
type Mode = 'auto' | CrewRoute;

type Item =
  | { at: string; type: 'chat'; entry: CrewChatEntry }
  | { at: string; type: 'log'; entry: CrewFeedEntry; count: number };

/** A question typed while the Lead is still answering another, waiting its turn. */
interface QueuedMessage {
  id: string;
  text: string;
}

const FIRST_PAGE = 40;
const MAX_PHASE_BUTTONS = 8;

const TAG: Record<CrewChatEntry['kind'], string> = { ask: 'Question', steer: 'Steer', work: 'Add work', note: 'Decision', answer: '' };

/**
 * The crew's own conversation: what the person said, what the Lead answered, and a running log of what the crew did.
 * Underneath is the same message box as the Workspace. The person never has to say whether a message is a question, a
 * change of direction or more work: the box works it out and says which it chose, and a small picker overrides it.
 */
export function CrewChat({ run, activity, working, onSend, onStopAsk, onKeepGoing, onAway, onExplainSimply, onFindPhases, onDecide, onPause, onResume, onStop, onOpenConversation }: {
  run: CrewRun;
  /** The live "what is each role doing now" strip, shown while the crew works. */
  activity: ReactNode;
  /** Whether a run control is already being applied, so it is not pressed twice. */
  working: boolean;
  onSend: (kind: CrewRoute, text: string) => Promise<void>;
  /** Stops the Lead answering, without touching the crew's own agents. */
  onStopAsk: () => Promise<void>;
  onKeepGoing: (on: boolean) => Promise<void>;
  onAway: (on: boolean, minutes: number, policy?: CrewAwayPolicy) => Promise<void>;
  onExplainSimply: (on: boolean) => Promise<void>;
  onFindPhases: () => Promise<void>;
  onDecide: (approvalId: string, approve: boolean) => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onOpenConversation?: (conversationId: string) => void;
}): ReactNode {
  const finished = run.status === 'completed' || run.status === 'stopped';
  const live = run.status === 'running' || run.status === 'planning';
  const [mode, setMode] = useState<Mode>('auto');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  // Refs as well as state, because a message is queued or sent from inside an async function that outlives a render.
  const askBusy = useRef(false);
  const queueRef = useRef<QueuedMessage[]>([]);
  const [finding, setFinding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(FIRST_PAGE);
  const end = useRef<HTMLDivElement>(null);

  const items = useMemo<Item[]>(() => {
    const log: Item[] = collapseFeed(run.feed).reverse().map((group) => ({ at: group.entry.at, type: 'log', entry: group.entry, count: group.count }));
    const chat: Item[] = run.chat.map((entry) => ({ at: entry.at, type: 'chat', entry }));
    return [...log, ...chat].sort((a, b) => a.at.localeCompare(b.at));
  }, [run.feed, run.chat]);
  const visible = items.slice(Math.max(0, items.length - shown));
  const earlier = items.length - visible.length;

  // Scrolls the thread only. scrollIntoView also scrolled the page, which pushed the composer out of view.
  useEffect(() => { const thread = end.current?.parentElement; if (thread) thread.scrollTop = thread.scrollHeight; }, [run.chat.length, run.feed.length, run.status]);

  // "Add work" only means something once the board has finished; a forced choice that does not fit falls back to Auto.
  const forced: CrewRoute | null = mode === 'auto' || (mode === 'work' && !finished) ? null : mode;
  // While the Lead is answering, a message that is not forced to something else is the next thing for it to take up.
  const route: CrewRoute = forced ?? (sending ? 'ask' : routeMessage(text, finished));

  function setQueued(next: QueuedMessage[]): void {
    queueRef.current = next;
    setQueue(next);
  }

  async function guarded(action: () => Promise<void>): Promise<void> {
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  // A setting is saved the moment it changes; this says so, briefly, once the save has gone through.
  const [saved, setSaved] = useState<'saving' | 'saved' | null>(null);
  const savedTimer = useRef<number | null>(null);
  async function saveSetting(action: () => Promise<void>): Promise<void> {
    setError(null);
    setSaved('saving');
    if (savedTimer.current) window.clearTimeout(savedTimer.current);
    try {
      await action();
      setSaved('saved');
      savedTimer.current = window.setTimeout(() => setSaved(null), 2_000);
    } catch (caught) {
      setSaved(null);
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }
  const policy = run.away.policy ?? DEFAULT_AWAY_POLICY;

  async function send(kind: CrewRoute, body: string): Promise<void> {
    const value = body.trim();
    if (!value) return;
    setText('');
    // A question asked while the Lead is still answering waits its turn and goes when that answer lands, the way a
    // message typed during a run in the Workspace does. Steers and added work do not need the Lead, so they go at once.
    if (kind === 'ask' && askBusy.current) {
      setQueued([...queueRef.current, { id: `queued-${Date.now()}-${queueRef.current.length}`, text: value }]);
      return;
    }
    if (kind === 'ask') {
      askBusy.current = true;
      setSending(true);
    }
    let failed = false;
    await guarded(async () => {
      try {
        await onSend(kind, value);
      } catch (caught) {
        failed = true;
        throw caught;
      }
    });
    // A message that did not go is put back in the box, not lost.
    if (failed) setText((current) => current || value);
    if (kind === 'ask') {
      askBusy.current = false;
      setSending(false);
      const [next, ...rest] = queueRef.current;
      setQueued(rest);
      if (next) void send('ask', next.text);
    }
  }

  async function findPhases(): Promise<void> {
    setFinding(true);
    await guarded(onFindPhases);
    setFinding(false);
  }

  const phaseRoute: CrewRoute = finished ? 'work' : 'steer';
  // Tasks still on the board when the crew has stopped: one button carries on with them.
  const unfinished = run.tasks.filter((task) => !task.proposed && task.status !== 'accepted' && task.status !== 'skipped').length;
  const phases = run.remaining.slice(0, MAX_PHASE_BUTTONS);

  return (
    <section className="ops-panel crew-chat" aria-label="Crew chat">
      <div className="crew-chat-head">
        <label className="toggle-row">
          <span>
            <strong>Keep going through every phase</strong>
            <small>{run.keepGoing ? 'On: when a phase is accepted the crew plans the next one itself.' : 'Off: the crew stops and says what is left when its planned tasks are done.'}</small>
          </span>
          <Switch checked={run.keepGoing} onChange={(event) => void saveSetting(() => onKeepGoing(event.target.checked))} />
        </label>
        <label className="toggle-row">
          <span>
            <strong>I am away</strong>
            <small>{run.away.enabled ? (run.away.minutes > 0 ? `On: a stuck task that waits ${run.away.minutes} minutes for you is settled by the Lead, using the safest of its own options.` : 'On: the Lead settles a stuck task at once, using the safest of its own options.') : 'Off: the crew waits for you on every question.'} It follows the rules below; plan approvals and run limits always wait for you.{run.away.picked.length > 0 ? ` ${run.away.picked.length} chosen so far, listed in the log.` : ''}</small>
          </span>
          <Switch checked={run.away.enabled} onChange={(event) => void saveSetting(() => onAway(event.target.checked, run.away.minutes))} />
        </label>
        {run.away.enabled && (
          <label className="toggle-row">
            <span><strong>Wait for me first</strong><small>How long a question waits before the Lead picks.</small></span>
            <Select aria-label="How long to wait before the Lead picks" value={String(run.away.minutes)} onChange={(event) => void saveSetting(() => onAway(true, Number(event.target.value)))}>
              {[0, 5, 15, 30, 60, 120].map((minutes) => <option key={minutes} value={minutes}>{minutes === 0 ? 'Not at all' : `${minutes} minutes`}</option>)}
            </Select>
          </label>
        )}
        <label className="toggle-row">
          <span>
            <strong>Explain things simply</strong>
            <small>{run.explainSimply ? 'On: the Lead avoids jargon and says what each term means.' : 'Off: the Lead writes as it would for an experienced developer.'}</small>
          </span>
          <Switch checked={run.explainSimply} onChange={(event) => void saveSetting(() => onExplainSimply(event.target.checked))} />
        </label>
        <label className="toggle-row">
          <span>
            <strong>Stop costly tasks</strong>
            <small>{policy.costCheck ? 'On: a task that costs more than three times a usual one waits for you.' : 'Off: tasks never stop for what they cost.'}</small>
          </span>
          <Switch checked={policy.costCheck} onChange={(event) => void saveSetting(() => onAway(run.away.enabled, run.away.minutes, { ...policy, costCheck: event.target.checked }))} />
        </label>
        {run.conversationId && onOpenConversation && (
          <UiButton type="button" className="secondary-button" onClick={() => onOpenConversation(run.conversationId!)} title="Read everything the crew's agents did, tool by tool. It opens read-only.">
            <ExternalLink size={14} /> Full transcript
          </UiButton>
        )}
      </div>

      {saved && <small className="crew-saved" role="status">{saved === 'saving' ? 'Saving…' : 'Saved'}</small>}
      {run.away.enabled && <AwayRules policy={policy} onChange={(next) => void saveSetting(() => onAway(true, run.away.minutes, next))} />}

      <CrewApprovals run={run} working={working} onDecide={onDecide} />

      {/* Only while agents are running: a crew waiting on you is not working, and the moving bar cost a redraw every frame. */}
      {(run.status === 'running' || run.status === 'planning') && activity}

      {finished && unfinished > 0 && (
        <div className="studio-actions">
          <UiButton type="button" className="primary-button" disabled={working} onClick={() => void send('work', 'continue')} title="Build the tasks that are already planned and waiting">
            <Play size={14} /> Carry on with the {unfinished} unfinished {unfinished === 1 ? 'task' : 'tasks'}
          </UiButton>
        </div>
      )}

      <div className="crew-phases" role="group" aria-label="The plan's phases">
        {phases.length > 0 ? (
          <>
            <small className="crew-empty">Still to do in the plan. Press one to start it; <CircleHelp size={11} className="inline" /> explains it in plain words.</small>
            <div className="command-chip-row">
              {phases.map((phase) => (
                <span key={phase} className="crew-phase">
                  <UiButton type="button" className="secondary-button" disabled={run.approvals.some((item) => item.status === 'pending')} onClick={() => void send(phaseRoute, `Continue the plan with: ${phase}.`)} title={`Start: ${phase}`}>
                    {phase}
                  </UiButton>
                  <UiButton type="button" className="composer-text-button" aria-label={`What does "${phase}" mean?`} title="Explain this in plain words" onClick={() => void send('ask', `Explain in plain words what "${phase}" involves, what it will change, and whether I need to decide anything before it starts.`)}>
                    <CircleHelp size={13} />
                  </UiButton>
                </span>
              ))}
            </div>
          </>
        ) : !live && (
          <UiButton type="button" className="secondary-button" disabled={finding} onClick={() => void findPhases()} title="Ask the Lead to read the plan and say what is not built yet">
            <Search size={14} /> {finding ? 'Reading the plan…' : 'What’s left in the plan?'}
          </UiButton>
        )}
      </div>

      <div className="studio-thread crew-chat-thread" role="log" aria-live="polite">
        {items.length === 0 && <small className="crew-empty">Nothing has happened yet. Ask the Lead anything once the crew has started.</small>}
        {earlier > 0 && (
          <UiButton type="button" className="composer-text-button" onClick={() => setShown((current) => current + FIRST_PAGE)}>Show {Math.min(earlier, FIRST_PAGE)} earlier</UiButton>
        )}
        {visible.map((item) => item.type === 'chat'
          ? (
            <div key={item.entry.id} className={`studio-bubble ${item.entry.from === 'you' ? 'user' : 'ai'}`}>
              {item.entry.from === 'you' && TAG[item.entry.kind] && <small className="crew-chat-tag">{TAG[item.entry.kind]}</small>}
              {/* The Lead writes in markdown (bold, lists, code); the person's own words are shown as typed. */}
              {item.entry.from === 'lead' ? <Markdown text={item.entry.text} /> : <span className="crew-chat-text">{item.entry.text}</span>}
              {/* A message that was taken as a question can be sent again as work, which is what the Lead points to. */}
              {item.entry.from === 'you' && item.entry.kind === 'ask' && (
                <UiButton type="button" className="composer-text-button crew-run-as-work" disabled={working} onClick={() => void send(phaseRoute, item.entry.text)} title="Send this same message again as work for the crew">
                  <Play size={12} /> Run this as work
                </UiButton>
              )}
            </div>
          )
          : (
            <div key={item.entry.id} className={`crew-chat-log crew-feed-${item.entry.kind}`}>
              <span>{item.entry.text}{item.count > 1 && <em className="crew-feed-count"> ×{item.count}</em>}</span>
              <small>{item.entry.who} · {new Date(item.entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>
            </div>
          ))}
        {queue.map((item) => (
          <div key={item.id} className="studio-bubble user crew-queued">
            <small className="crew-chat-tag">Queued: the Lead takes it up after the answer it is giving</small>
            <span className="crew-chat-text">{item.text}</span>
            <UiButton type="button" className="composer-text-button" aria-label="Remove this queued message" onClick={() => setQueued(queueRef.current.filter((queued) => queued.id !== item.id))}><X size={12} /> Remove</UiButton>
          </div>
        ))}
        {sending && <div className="studio-bubble ai">The Lead is working on it…</div>}
        <div ref={end} />
      </div>

      <Composer
        status={text.trim() ? <span>{sending && route === 'ask' ? 'Queued: the Lead takes this up after its current answer.' : `Sent as ${ROUTE_LABEL[route]}${forced ? '' : '. Change it with the picker if that is not what you meant.'}`}</span> : undefined}
      >
        <ComposerInput
          value={text}
          rows={2}
          maxLength={2000}
          aria-label="Message to the Lead"
          placeholder="Message the Lead: ask about progress, change direction, or give it more to do"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends and Shift+Enter adds a line, as in the Workspace; a key that confirms an input method does neither.
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send(route, text);
            }
          }}
        />
        <ComposerToolbar
          leading={(
            <Select aria-label="What kind of message" value={mode} onChange={(event) => setMode(event.target.value as Mode)} className="crew-mode-select">
              <option value="auto">Auto</option>
              <option value="ask">Ask</option>
              <option value="steer">Steer</option>
              <option value="work" disabled={!finished}>Add work</option>
            </Select>
          )}
          actions={(
            <>
              {live && <ComposerPause paused={false} onPause={onPause} onResume={onResume} />}
              {run.status === 'paused' && <ComposerPause paused onPause={onPause} onResume={onResume} />}
              {/* While the Lead is answering, the one control that matters is the one that stops it. */}
              {sending && <ComposerStop onClick={() => { setQueued([]); void guarded(onStopAsk); }} label="Stop answering" />}
              {!finished && <ComposerStop onClick={onStop} label="Stop the crew" />}
              <ComposerSend label="Send to the Lead" onClick={() => void send(route, text)} disabled={working || !text.trim()} sending={false} />
            </>
          )}
        />
      </Composer>
      <small className="crew-empty crew-chat-hint">Enter to send · Shift+Enter for a new line</small>
      {error && <p className="studio-notice error" role="alert">{error}</p>}
    </section>
  );
}

/** The rules away mode follows, one row per kind of blocker. Each is saved as soon as it is changed. */
const AWAY_RULES: Array<{ key: keyof Omit<CrewAwayPolicy, 'costlyMaxUsd' | 'other'>; label: string; hint: string }> = [
  { key: 'retry', label: 'Retry a failing task', hint: 'With a different instruction' },
  { key: 'skip', label: 'Skip a task', hint: 'When the goal does not need it' },
  { key: 'reversible', label: 'Make reversible code choices', hint: 'Keep or revert a small change, adjust a check' },
  { key: 'recheck', label: 'Go on past an unreadable check', hint: 'Listed for you to re-check' },
  { key: 'costly', label: 'Let a costly task carry on', hint: 'Up to the limit below' },
  { key: 'dependencies', label: 'Add a dependency', hint: 'A new package or library' },
  { key: 'paid', label: 'Spend money', hint: 'Paid services, plans, upgrades' },
  { key: 'security', label: 'Change security or permissions', hint: 'Auth, access, secrets handling' },
  { key: 'deleteWork', label: 'Delete or overwrite work', hint: 'Files, data or history' },
];

function AwayRules({ policy, onChange }: { policy: CrewAwayPolicy; onChange: (policy: CrewAwayPolicy) => void }): ReactNode {
  const [open, setOpen] = useState(false);
  const [other, setOther] = useState(policy.other);
  useEffect(() => setOther(policy.other), [policy.other]);
  const allowed = AWAY_RULES.filter((rule) => policy[rule.key]).length;
  return (
    <section className="crew-away-rules" aria-label="Away rules">
      <button type="button" className="crew-away-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <strong>While I am away, the Lead may decide</strong>
        <small>{allowed} of {AWAY_RULES.length} allowed{policy.costly ? (policy.costlyMaxUsd === 0 ? ' · costly tasks with no limit' : ` · costly tasks up to $${policy.costlyMaxUsd}`) : ''}{policy.other.trim() ? ' · plus your own rule' : ''}. Every decision is listed in the report.</small>
      </button>
      {open && (
        <div className="crew-away-body">
          <div className="crew-away-grid">
            {AWAY_RULES.map((rule) => (
              <div key={rule.key} className="crew-away-rule">
                <Toggle size="sm" checked={policy[rule.key]} ariaLabel={rule.label} onChange={(checked) => onChange({ ...policy, [rule.key]: checked })} />
                <span className="crew-away-text"><span>{rule.label}</span><small>{rule.hint}</small></span>
              </div>
            ))}
          </div>
          <div className="crew-away-fields">
            <label className="crew-away-field crew-away-limit">
              <span>Most a task may cost before it waits for you (USD, 0 = no limit)</span>
              <UiTextInput type="number" min={0} max={1000} step={1} value={policy.costlyMaxUsd} disabled={!policy.costly} onChange={(event) => onChange({ ...policy, costlyMaxUsd: Math.max(0, Math.min(1000, Number(event.target.value) || 0)) })} />
            </label>
            <label className="crew-away-field crew-away-other">
              <span>Your own rules, in your words</span>
              <UiTextInput maxLength={600} value={other} placeholder="For example: never change the database schema" onChange={(event) => setOther(event.target.value)} onBlur={() => { if (other !== policy.other) onChange({ ...policy, other }); }} />
            </label>
          </div>
        </div>
      )}
    </section>
  );
}
