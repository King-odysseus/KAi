import { CircleHelp, ExternalLink, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CrewChatEntry, CrewFeedEntry, CrewRun } from '@kai/contracts';
import { collapseFeed } from '../crew-feed';
import { ROUTE_LABEL, routeMessage, type CrewRoute } from '../crew-routing';
import { CrewApprovals } from './CrewApprovals';
import { Switch } from './ui/Switch';
import { Select } from './ui/Select';
import { Composer, ComposerInput, ComposerPause, ComposerSend, ComposerStop, ComposerToolbar } from './ui/Composer';
import { UiButton } from './UiButton';

/** What the person picked: let the Lead work it out, or force one kind of message. */
type Mode = 'auto' | CrewRoute;

type Item =
  | { at: string; type: 'chat'; entry: CrewChatEntry }
  | { at: string; type: 'log'; entry: CrewFeedEntry; count: number };

const FIRST_PAGE = 40;
const MAX_PHASE_BUTTONS = 8;

const TAG: Record<CrewChatEntry['kind'], string> = { ask: 'Question', steer: 'Steer', work: 'Add work', note: 'Decision', answer: '' };

/**
 * The crew's own conversation: what the person said, what the Lead answered, and a running log of what the crew did.
 * Underneath is the same message box as the Workspace. The person never has to say whether a message is a question, a
 * change of direction or more work: the box works it out and says which it chose, and a small picker overrides it.
 */
export function CrewChat({ run, activity, working, onSend, onKeepGoing, onExplainSimply, onFindPhases, onDecide, onPause, onResume, onStop, onOpenConversation }: {
  run: CrewRun;
  /** The live "what is each role doing now" strip, shown while the crew works. */
  activity: ReactNode;
  /** Whether a run control is already being applied, so it is not pressed twice. */
  working: boolean;
  onSend: (kind: CrewRoute, text: string) => Promise<void>;
  onKeepGoing: (on: boolean) => Promise<void>;
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

  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [run.chat.length, run.feed.length, run.status]);

  // "Add work" only means something once the board has finished; a forced choice that does not fit falls back to Auto.
  const forced: CrewRoute | null = mode === 'auto' || (mode === 'work' && !finished) ? null : mode;
  const route: CrewRoute = forced ?? routeMessage(text, finished);

  async function guarded(action: () => Promise<void>): Promise<void> {
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function send(kind: CrewRoute, body: string): Promise<void> {
    const value = body.trim();
    if (!value || sending) return;
    setSending(true);
    await guarded(async () => {
      await onSend(kind, value);
      setText('');
    });
    setSending(false);
  }

  async function findPhases(): Promise<void> {
    setFinding(true);
    await guarded(onFindPhases);
    setFinding(false);
  }

  const phaseRoute: CrewRoute = finished ? 'work' : 'steer';
  const phases = run.remaining.slice(0, MAX_PHASE_BUTTONS);

  return (
    <section className="ops-panel crew-chat" aria-label="Crew chat">
      <div className="crew-chat-head">
        <label className="toggle-row">
          <span>
            <strong>Keep going through every phase</strong>
            <small>{run.keepGoing ? 'On: when a phase is accepted the crew plans the next one itself.' : 'Off: the crew stops and says what is left when its planned tasks are done.'}</small>
          </span>
          <Switch checked={run.keepGoing} onChange={(event) => void guarded(() => onKeepGoing(event.target.checked))} />
        </label>
        <label className="toggle-row">
          <span>
            <strong>Explain things simply</strong>
            <small>{run.explainSimply ? 'On: the Lead avoids jargon and says what each term means.' : 'Off: the Lead writes as it would for an experienced developer.'}</small>
          </span>
          <Switch checked={run.explainSimply} onChange={(event) => void guarded(() => onExplainSimply(event.target.checked))} />
        </label>
        {run.conversationId && onOpenConversation && (
          <UiButton type="button" className="secondary-button" onClick={() => onOpenConversation(run.conversationId!)} title="Read everything the crew's agents did, tool by tool. It opens read-only.">
            <ExternalLink size={14} /> Full transcript
          </UiButton>
        )}
      </div>

      <CrewApprovals run={run} working={working} onDecide={onDecide} />

      {!finished && run.status !== 'paused' && activity}

      <div className="crew-phases" role="group" aria-label="The plan's phases">
        {phases.length > 0 ? (
          <>
            <small className="crew-empty">Still to do in the plan. Press one to start it; <CircleHelp size={11} className="inline" /> explains it in plain words.</small>
            <div className="command-chip-row">
              {phases.map((phase) => (
                <span key={phase} className="crew-phase">
                  <UiButton type="button" className="secondary-button" disabled={sending || run.approvals.some((item) => item.status === 'pending')} onClick={() => void send(phaseRoute, `Continue the plan with: ${phase}.`)} title={`Start: ${phase}`}>
                    {phase}
                  </UiButton>
                  <UiButton type="button" className="composer-text-button" disabled={sending} aria-label={`What does "${phase}" mean?`} title="Explain this in plain words" onClick={() => void send('ask', `Explain in plain words what "${phase}" involves, what it will change, and whether I need to decide anything before it starts.`)}>
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
              <span className="crew-chat-text">{item.entry.text}</span>
            </div>
          )
          : (
            <div key={item.entry.id} className={`crew-chat-log crew-feed-${item.entry.kind}`}>
              <span>{item.entry.text}{item.count > 1 && <em className="crew-feed-count"> ×{item.count}</em>}</span>
              <small>{item.entry.who} · {new Date(item.entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>
            </div>
          ))}
        {sending && <div className="studio-bubble ai">The Lead is working on it…</div>}
        <div ref={end} />
      </div>

      <Composer
        status={text.trim() ? <span>Sent as {ROUTE_LABEL[route]}{forced ? '' : '. Change it with the picker if that is not what you meant.'}</span> : undefined}
      >
        <ComposerInput
          value={text}
          rows={2}
          maxLength={2000}
          disabled={sending}
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
              {!finished && <ComposerStop onClick={onStop} label="Stop the crew" />}
              <ComposerSend label="Send to the Lead" onClick={() => void send(route, text)} disabled={sending || working || !text.trim()} sending={sending} />
            </>
          )}
        />
      </Composer>
      <small className="crew-empty crew-chat-hint">Enter to send · Shift+Enter for a new line</small>
      {error && <p className="studio-notice error" role="alert">{error}</p>}
    </section>
  );
}
