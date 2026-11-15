import { Textarea } from 'flowbite-react';
import { ExternalLink, Loader2, Send } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CrewChatEntry, CrewFeedEntry, CrewRun } from '@kai/contracts';
import { collapseFeed } from '../crew-feed';
import { Switch } from './ui/Switch';
import { UiButton } from './UiButton';

type Kind = 'ask' | 'steer' | 'work';

const KINDS: ReadonlyArray<{ id: Kind; label: string; help: string; placeholder: string }> = [
  { id: 'ask', label: 'Ask', help: 'A question about what is done, what is blocking it, or what it cost. Changes nothing.', placeholder: 'For example: what is finished, and what is stopping Phase 1?' },
  { id: 'steer', label: 'Steer', help: 'Change what the crew does from its next task on.', placeholder: 'For example: use the existing login, and skip the settings screen.' },
  { id: 'work', label: 'Add work', help: 'Plan more onto the board once the crew has finished.', placeholder: 'For example: start the next phase, or install it and run the tests.' },
];

type Item =
  | { at: string; type: 'chat'; entry: CrewChatEntry }
  | { at: string; type: 'log'; entry: CrewFeedEntry; count: number };

const FIRST_PAGE = 40;

/**
 * The crew's own conversation: what the person said, what the Lead answered, and a running log of what the crew did,
 * with a box underneath to ask, steer or add work. The board shows state; this is where it is talked to.
 */
export function CrewChat({ run, activity, onSend, onKeepGoing, onOpenConversation }: {
  run: CrewRun;
  /** The live "what is each role doing now" strip, shown while the crew works. */
  activity: ReactNode;
  onSend: (kind: Kind, text: string) => Promise<void>;
  onKeepGoing: (on: boolean) => Promise<void>;
  onOpenConversation?: (conversationId: string) => void;
}): ReactNode {
  const finished = run.status === 'completed' || run.status === 'stopped';
  const [kind, setKind] = useState<Kind>('ask');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
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

  // A kind that does not fit the crew's state (adding work to one that is still building) falls back to a question.
  const usable = (id: Kind): boolean => (id === 'work' ? finished : id === 'steer' ? !finished : true);
  const active = KINDS.find((item) => item.id === kind && usable(item.id)) ?? KINDS[0]!;

  async function send(): Promise<void> {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSend(active.id, value);
      setText('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSending(false);
    }
  }

  async function toggleKeepGoing(on: boolean): Promise<void> {
    setError(null);
    try {
      await onKeepGoing(on);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <section className="ops-panel crew-chat" aria-label="Crew chat">
      <div className="crew-chat-head">
        <label className="toggle-row">
          <span>
            <strong>Keep going through every phase</strong>
            <small>{run.keepGoing ? 'On: when a phase is accepted the crew plans the next one itself.' : 'Off: the crew stops and says what is left when its planned tasks are done.'}</small>
          </span>
          <Switch checked={run.keepGoing} onChange={(event) => void toggleKeepGoing(event.target.checked)} />
        </label>
        {run.conversationId && onOpenConversation && (
          <UiButton type="button" className="secondary-button" onClick={() => onOpenConversation(run.conversationId!)} title="Open everything the crew's agents did, tool by tool, in the Workspace">
            <ExternalLink size={14} /> Full transcript
          </UiButton>
        )}
      </div>

      {!finished && run.status !== 'paused' && activity}

      <div className="studio-thread crew-chat-thread" role="log" aria-live="polite">
        {items.length === 0 && <small className="crew-empty">Nothing has happened yet. Ask the Lead anything once the crew has started.</small>}
        {earlier > 0 && (
          <UiButton type="button" className="composer-text-button" onClick={() => setShown((current) => current + FIRST_PAGE)}>Show {Math.min(earlier, FIRST_PAGE)} earlier</UiButton>
        )}
        {visible.map((item) => item.type === 'chat'
          ? (
            <div key={item.entry.id} className={`studio-bubble ${item.entry.from === 'you' ? 'user' : 'ai'}`}>
              {item.entry.from === 'you' && <small className="crew-chat-tag">{item.entry.kind === 'ask' ? 'Question' : item.entry.kind === 'steer' ? 'Steer' : 'Add work'}</small>}
              <span className="crew-chat-text">{item.entry.text}</span>
            </div>
          )
          : (
            <div key={item.entry.id} className={`crew-chat-log crew-feed-${item.entry.kind}`}>
              <span>{item.entry.text}{item.count > 1 && <em className="crew-feed-count"> ×{item.count}</em>}</span>
              <small>{item.entry.who} · {new Date(item.entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>
            </div>
          ))}
        {sending && <div className="studio-bubble ai"><Loader2 className="spin" size={13} /> The Lead is working on it…</div>}
        <div ref={end} />
      </div>

      <div className="studio-reply crew-chat-reply">
        <div className="command-chip-row" role="group" aria-label="What kind of message">
          {KINDS.map((item) => (
            <UiButton key={item.id} type="button" className={active.id === item.id ? 'active' : undefined} aria-pressed={active.id === item.id} onClick={() => setKind(item.id)} disabled={!usable(item.id) || sending} title={usable(item.id) ? item.help : item.id === 'work' ? 'Available once the crew has finished or been stopped.' : 'Available while the crew is working.'}>{item.label}</UiButton>
          ))}
        </div>
        <small className="crew-empty">{active.help}</small>
        <Textarea
          rows={3}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void send(); } }}
          placeholder={active.placeholder}
          aria-label="Message to the Lead"
          maxLength={2000}
          disabled={sending}
        />
        <div className="studio-actions">
          <UiButton type="button" className="primary-button" onClick={() => void send()} disabled={sending || !text.trim()}>
            {sending ? <Loader2 className="spin" size={14} /> : <Send size={14} />} Send to the Lead
          </UiButton>
          <small className="crew-empty">Ctrl+Enter to send</small>
        </div>
        {error && <p className="studio-notice error" role="alert">{error}</p>}
      </div>
    </section>
  );
}
