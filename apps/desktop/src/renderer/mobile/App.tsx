import { useEffect, useState, useSyncExternalStore } from 'react';
import { getState, start, subscribe } from './store';
import { rememberToken, tokenFromEntry } from './api';
import { NeedsYou, RunDetail, Workflows } from './views';
import { TopBar } from './chrome';
import { Board } from './board';
import { ConversationDetail, Workspace } from './workspace';
import { Projects } from './projects';
import { Tasks } from './tasks';

/**
 * The console's sections, named after the desktop's own so the same word means the same thing on both
 * screens. Needs you is the phone's own: it has no desktop counterpart, because a phone in another room
 * is exactly the thing that makes "what is waiting on me" a screen rather than a corner of the sidebar.
 * Learn & Code is absent on purpose — reading a lesson needs channels that are not on the remote
 * allowlist, so rather than a dead tab there is no tab.
 */
type Tab = 'needs-you' | 'workspace' | 'studio' | 'workflows' | 'tasks' | 'projects';

const TABS: Array<{ id: Tab; glyph: string; label: string }> = [
  { id: 'needs-you', glyph: '◎', label: 'Needs you' },
  { id: 'workspace', glyph: '▤', label: 'Workspace' },
  { id: 'studio', glyph: '▦', label: 'Studio' },
  { id: 'workflows', glyph: '≡', label: 'Workflows' },
  { id: 'tasks', glyph: '✓', label: 'Tasks' },
  { id: 'projects', glyph: '▣', label: 'Projects' },
];

const LABELS: Record<Tab, string> = {
  'needs-you': 'Needs you',
  workspace: 'Workspace',
  studio: 'Studio',
  workflows: 'Workflows',
  tasks: 'Tasks',
  projects: 'Projects',
};

/**
 * The screen a device without a token sees. There is a paste field as well as an instruction, because an
 * app installed on a home screen opens at `/mobile/` with no address bar and no token, and its storage is
 * its own — so the link it was paired from in the browser is not something it can be opened *with*.
 */
function Unpaired({ message }: { message: string | null }) {
  const [entry, setEntry] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const attach = (): void => {
    const token = tokenFromEntry(entry);
    if (!token) {
      setProblem('That is not a pairing link or token. Copy the whole link from the desktop.');
      return;
    }
    rememberToken(token);
    // A reload is the whole reconnect: the page boots, finds the token, and opens the live stream.
    window.location.reload();
  };

  return (
    <div className="centred">
      <h1>Pair this phone</h1>
      <p>{message ?? 'KAI Remote needs the pairing token from the desktop before it can show anything.'}</p>
      <p className="dim">
        On the desktop, open Settings → KAI Remote, choose <em>Pair a device</em>, then open the pairing
        link it shows on this phone — or paste it below, which is the way in for an app already on the
        home screen.
      </p>
      <div className="pair-entry">
        <input
          value={entry}
          placeholder="Paste the pairing link or token"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => { setEntry(event.target.value); setProblem(null); }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') attach();
          }}
        />
        <button type="button" className="act approve" disabled={entry.trim().length === 0} onClick={attach}>Pair</button>
      </div>
      {problem && <p className="meta danger">{problem}</p>}
    </div>
  );
}

function Failed({ message }: { message: string | null }) {
  return (
    <div className="centred">
      <h1>KAI did not answer</h1>
      <p>{message ?? 'The desktop may have gone to sleep, or the remote gateway may be off.'}</p>
      <p className="dim">Everything reconnects by itself once the desktop is back.</p>
    </div>
  );
}

export function App() {
  const state = useSyncExternalStore(subscribe, getState);
  const [tab, setTab] = useState<Tab>('needs-you');
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [studioProjectId, setStudioProjectId] = useState<string | null>(null);

  useEffect(() => start(), []);

  // The Studio board is opened from two places — its own tab and a project's card — so the console owns
  // which project it shows. Until the desktop is read, it falls back the way the board itself would.
  useEffect(() => {
    if (studioProjectId !== null) return;
    const projects = state.bootstrap?.projects ?? [];
    setStudioProjectId(state.bootstrap?.activeProjectId ?? projects[0]?.id ?? null);
  }, [studioProjectId, state.bootstrap]);

  if (state.status === 'starting') {
    return (
      <div className="phone">
        <div className="centred"><p className="dim">Connecting to KAI…</p></div>
      </div>
    );
  }
  if (state.status === 'unpaired') {
    return <div className="phone"><Unpaired message={state.message} /></div>;
  }
  if (state.status === 'error' && !state.bootstrap) {
    return <div className="phone"><Failed message={state.message} /></div>;
  }

  const openRun = (id: string): void => {
    setWorkflowId(id);
    setConversationId(null);
  };
  const openConversation = (id: string): void => {
    setConversationId(id);
    setWorkflowId(null);
  };
  const openStudio = (projectId: string): void => {
    setStudioProjectId(projectId);
    setTab('studio');
  };
  const back = (): void => {
    setWorkflowId(null);
    setConversationId(null);
  };
  // Whichever section a detail was opened from is the one it goes back to, so the back label is read off
  // the tab rather than guessed at from the detail.
  const from = LABELS[tab];

  if (workflowId) {
    return (
      <div className="phone">
        <RunDetail state={state} workflowId={workflowId} backLabel={from} onBack={back} />
      </div>
    );
  }
  if (conversationId) {
    return (
      <div className="phone">
        <ConversationDetail
          state={state}
          conversationId={conversationId}
          backLabel={from}
          onBack={back}
          onOpenRun={openRun}
        />
      </div>
    );
  }

  return (
    <div className="phone">
      {tab === 'workspace' ? (
        <Workspace state={state} onOpen={openConversation} />
      ) : tab === 'studio' ? (
        <Board state={state} projectId={studioProjectId} onProjectChange={setStudioProjectId} />
      ) : tab === 'workflows' ? (
        <Workflows state={state} onOpenRun={openRun} />
      ) : tab === 'tasks' ? (
        <Tasks state={state} />
      ) : tab === 'projects' ? (
        <Projects state={state} onOpenStudio={openStudio} />
      ) : (
        <>
          <TopBar title="Needs you">
            <span className={`dot ${state.connected ? '' : 'off'}`} />
            {state.connected
              ? state.windows.length === 1
                ? 'Desktop'
                : `${state.windows.length} windows`
              : 'Reconnecting'}
          </TopBar>
          <NeedsYou state={state} onOpenRun={openRun} />
        </>
      )}

      <nav className="tabs">
        {TABS.map((entry) => (
          <button
            type="button"
            key={entry.id}
            className={`tab ${tab === entry.id ? 'on' : ''}`}
            onClick={() => setTab(entry.id)}
          >
            <span className="glyph">{entry.glyph}</span>
            {entry.label}
            {entry.id === 'needs-you' && state.alerts.length > 0 && <span className="badge">{state.alerts.length}</span>}
          </button>
        ))}
      </nav>
    </div>
  );
}
