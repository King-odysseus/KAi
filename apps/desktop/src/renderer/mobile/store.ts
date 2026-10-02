import type {
  AgentRunEvent,
  ArtifactEntry,
  BoardCard,
  BoardStatus,
  BoardTask,
  BootstrapPayload,
  ConversationRecord,
  PersistedEvent,
  RemoteWindowSummary,
  StudioArtifacts,
  StudioBoard,
  UsageSummary,
  WorkflowRun,
} from '@kai/contracts';
import { fetchStatus, fetchWindows, ipc, isUnpaired, openStream, RemoteError, resolveToken } from './api';
import type { StreamFrame } from './api';

/** How much live tail to hold per conversation. Enough to read what is happening; not a transcript. */
const TAIL_LIMIT = 4_000;
/** How many alerts to keep. The newest are the ones that matter. */
const ALERT_LIMIT = 40;

export type AlertKind = 'approval' | 'failure' | 'budget' | 'done' | 'info';

export interface Alert {
  id: string;
  kind: AlertKind;
  chip: string;
  title: string;
  detail: string;
  risk: string | null;
  tool: string | null;
  conversationId: string;
  /** The request an approval is waiting on. Absent on an event that carried none, which cannot be answered. */
  requestId: string | null;
  /** Set when the run is asking about itself, so the card offers these two answers instead of approve and deny. */
  runQuestion: { continueLabel: string; finishLabel: string } | null;
  /** The window the event came from. An approval may only be answered by the window that raised it. */
  windowId: number | null;
  at: number;
}

export interface RemoteState {
  status: 'starting' | 'ready' | 'unpaired' | 'error';
  message: string | null;
  connected: boolean;
  bootstrap: BootstrapPayload | null;
  windows: RemoteWindowSummary[];
  runs: WorkflowRun[];
  usage: UsageSummary | null;
  alerts: Alert[];
  tails: Record<string, string>;
  /** Turns sent from this phone that the agent has not answered yet. Cleared by its first output. */
  sent: Record<string, Array<{ text: string; at: number }>>;
  /** The open run's own record, read for its agent, route and autonomy before a turn is sent into it. */
  conversation: ConversationRecord | null;
  /** The project whose board and artifacts the phone is looking at, and what it read for it. */
  board: BoardView | null;
  /** The desktop's conversations, and the C1 brain's tasks. Null until their section is first opened. */
  conversations: ConversationRecord[] | null;
  tasks: BoardTask[] | null;
  refreshedAt: number | null;
}

/** One project's studio, read together: the cards, the spec catalog, and what exists under `.kai/spec`. */
export interface BoardView {
  projectId: string;
  cards: BoardCard[];
  artifacts: ArtifactEntry[];
  files: string[];
  at: number;
}

let state: RemoteState = {
  status: 'starting',
  message: null,
  connected: false,
  bootstrap: null,
  windows: [],
  runs: [],
  usage: null,
  alerts: [],
  tails: {},
  sent: {},
  conversation: null,
  board: null,
  conversations: null,
  tasks: null,
  refreshedAt: null,
};

const listeners = new Set<() => void>();

export function getState(): RemoteState {
  return state;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function set(patch: Partial<RemoteState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function projectName(state: RemoteState, projectId: string | null): string | null {
  if (!projectId) return null;
  return state.bootstrap?.projects.find((project) => project.id === projectId)?.name ?? null;
}

export function runById(state: RemoteState, workflowId: string | null): WorkflowRun | null {
  if (!workflowId) return null;
  return state.runs.find((run) => run.workflow.id === workflowId) ?? null;
}

function describe(error: unknown): string {
  if (error instanceof RemoteError) return error.message;
  return error instanceof Error ? error.message : 'Something went wrong talking to KAI.';
}

/** Reads the whole picture: what is open, what is running, what has been spent. */
export async function refresh(): Promise<void> {
  if (!resolveToken()) {
    set({ status: 'unpaired', message: null });
    return;
  }
  try {
    const [bootstrap, windows, runs] = await Promise.all([
      ipc<BootstrapPayload>('app:get-bootstrap'),
      fetchWindows(),
      ipc<WorkflowRun[]>('workflows:list-runs'),
    ]);
    // `workflows:list-runs` is already cross-project, so the Runs screen needs no per-window fan-out;
    // the windows are here so an approval can name the one it belongs to before it is answered.
    set({
      status: 'ready',
      message: null,
      bootstrap,
      windows,
      runs,
      refreshedAt: Date.now(),
    });
    await refreshUsage();
    // A push can be missed; the poll is what keeps an open board from quietly going stale.
    const open = state.board?.projectId;
    if (open) await loadBoard(open).catch(() => undefined);
    // A section read once stays current on the same schedule as the rest. Neither is fetched before its
    // section has been opened: the task list costs a call into the brain, and the conversations are the
    // one read here that carries a whole record per row.
    if (state.conversations) await loadConversations().catch(() => undefined);
    if (state.tasks) await loadTasks().catch(() => undefined);
  } catch (error) {
    if (isUnpaired(error)) set({ status: 'unpaired', message: describe(error) });
    else set({ status: 'error', message: describe(error) });
  }
}

/** Kept separate: a budget read that fails must not take the run list down with it. */
export async function refreshUsage(): Promise<void> {
  try {
    set({ usage: await ipc<UsageSummary>('usage:summary', {}) });
  } catch {
    // The screen shows what it has; the next refresh may fill this in.
  }
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

/** Pushes arrive in bursts; one read shortly after the burst is enough to keep the list current. */
function scheduleRefresh(delay = 700): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refresh();
  }, delay);
}

function pushAlert(alert: Alert): void {
  const existing = state.alerts.filter((entry) => entry.id !== alert.id);
  set({ alerts: [alert, ...existing].slice(0, ALERT_LIMIT) });
}

function dismissAlert(id: string): void {
  set({ alerts: state.alerts.filter((alert) => alert.id !== id) });
}

export const alerts = { dismiss: dismissAlert };

function appendTail(conversationId: string, text: string): void {
  const current = state.tails[conversationId] ?? '';
  const next = `${current}${text}`.slice(-TAIL_LIMIT);
  // Output arriving is the delivery receipt for anything sent from here, so the echo goes with it.
  const sent = { ...state.sent };
  if (sent[conversationId]?.length) delete sent[conversationId];
  set({ tails: { ...state.tails, [conversationId]: next }, sent });
}

function alertFor(event: PersistedEvent, payload: AgentRunEvent, windowId: number | null): Alert | null {
  const base = {
    id: `${event.id}:${event.type}`,
    conversationId: payload.conversationId,
    windowId,
    at: Date.parse(event.timestamp) || Date.now(),
    // Only an approval carries anything to act on, so everything else arrives without a way to answer it.
    risk: null as string | null,
    tool: null as string | null,
    requestId: null as string | null,
    runQuestion: null as Alert['runQuestion'],
  };
  switch (event.type) {
    case 'approval.request':
      return {
        ...base,
        kind: 'approval',
        // A question about the run is not a request to change the project, and the chip is the first thing read.
        chip: event.runQuestion ? 'Question' : 'Approval',
        title: event.title,
        detail: event.detail || `Risk: ${event.risk}`,
        // Kept apart from `detail` so the phone can show the command, the risk and the window on its own
        // terms: this is what the user reads before a command runs on their machine.
        risk: event.risk,
        tool: event.tool ?? null,
        requestId: event.requestId ?? null,
        runQuestion: event.runQuestion ?? null,
      };
    case 'error':
      return { ...base, kind: 'failure', chip: 'Failed', title: 'A run reported an error', detail: event.message };
    case 'agent.lifecycle':
      if (event.status !== 'failed' && event.status !== 'cancelled' && event.status !== 'interrupted') return null;
      return {
        ...base,
        kind: 'failure',
        chip: 'Failed',
        title: `Run ${event.status}`,
        detail: event.detail ?? '',
      };
    case 'turn.changes': {
      const files = event.files.length;
      return {
        ...base,
        kind: 'done',
        chip: 'Changed',
        title: `${files} file${files === 1 ? '' : 's'} changed`,
        detail: event.files.slice(0, 4).map((file) => file.path).join('\n'),
      };
    }
    case 'permission.escalation':
      return { ...base, kind: 'approval', chip: 'Permission', title: event.permission, detail: event.reason };
    default:
      return null;
  }
}

function onFrame(channel: string, frame: StreamFrame): void {
  if (channel === 'agents:event') {
    const payload = frame.payload as AgentRunEvent | null;
    const event = payload?.event;
    if (!event) return;
    if (event.type === 'text.delta' && event.channel !== 'raw') appendTail(payload.conversationId, event.text);
    // Lifecycle changes are the point of the feed; every delta would drown it.
    if (event.type !== 'text.delta') {
      const alert = alertFor(event, payload, frame.windowId);
      if (alert) pushAlert(alert);
      scheduleRefresh();
    }
    return;
  }
  if (channel === 'workflows:changed') {
    scheduleRefresh();
    return;
  }
  if (channel === 'studio:board-changed') {
    scheduleRefresh();
    scheduleBoardReload();
    return;
  }
  if (channel === 'app:shared-state') {
    scheduleRefresh();
  }
}

let stopStream: (() => void) | null = null;

/** Where an approval came from, in the words the phone uses for it: a project and a window. */
export function windowLabel(state: RemoteState, windowId: number | null): string {
  if (windowId === null) return 'the desktop';
  const window = state.windows.find((candidate) => candidate.id === windowId);
  if (!window) return `window ${windowId}`;
  const project = window.projectName ?? projectName(state, window.projectId) ?? 'No project';
  return `${project}, window ${window.id}`;
}

/** The window an alert belongs to, or the one the phone saw most recently if the push carried none. */
function windowFor(state: RemoteState, windowId: number | null): number | null {
  if (windowId !== null) return windowId;
  return state.windows.find((window) => window.focused)?.id ?? state.windows[0]?.id ?? null;
}

/**
 * Answers the approval the desktop is blocked on. The window matters: the main process refuses a
 * response that does not come from the window that raised the request, so the window the event carried
 * travels back with the answer. An approval with no `requestId` cannot be answered at all — the event
 * that raised it did not say what it was waiting for — and throws rather than silently doing nothing.
 */
export async function answerApproval(alert: Alert, approved: boolean): Promise<void> {
  if (!alert.requestId) throw new RemoteError('UNANSWERABLE', 'This request did not name what it is waiting for.');
  await ipc(
    'agents:approval-response',
    { conversationId: alert.conversationId, requestId: alert.requestId, approved },
    windowFor(state, alert.windowId),
  );
  dismissAlert(alert.id);
  scheduleRefresh(0);
}

/** Reads the open run's own record, which is where the composer's agent, route and autonomy come from. */
export async function loadConversation(conversationId: string): Promise<void> {
  if (state.conversation?.id === conversationId) return;
  try {
    const record = await ipc<ConversationRecord>('conversations:get', { id: conversationId });
    set({ conversation: record });
  } catch {
    // The composer falls back to the desktop's defaults; a missing record is not worth an error screen.
  }
}

/** What the next turn should run as: the conversation's own choices, then the desktop's. */
export function turnPlan(state: RemoteState, conversationId: string): {
  agent: string;
  route: string;
  autonomy: string;
  execution?: string;
} {
  const record = state.conversation?.id === conversationId ? state.conversation : null;
  const settings = state.bootstrap?.settings;
  return {
    agent: record?.activeAgent ?? settings?.defaultAgent ?? 'codex',
    route: record?.route ?? settings?.defaultRoute ?? 'direct',
    autonomy: record?.autonomy ?? settings?.defaultAutonomy ?? 'ask',
    ...(record?.execution ? { execution: record.execution } : {}),
  };
}

/**
 * Sends a turn into an existing conversation and returns at once. Running an agent is a long request —
 * waiting on it would freeze the composer for the length of a run — so the outcome is left to the live
 * stream, and only the failure to *start* comes back here.
 */
export function sendTurn(conversationId: string, prompt: string, model?: string | null): void {
  // Shown until the agent's first output arrives: sending into a run that is already talking otherwise
  // looks like nothing happened.
  const queued = [...(state.sent[conversationId] ?? []), { text: prompt, at: Date.now() }].slice(-4);
  set({ sent: { ...state.sent, [conversationId]: queued } });
  const input = {
    conversationId,
    prompt,
    ...turnPlan(state, conversationId),
    ...(model ? { model } : {}),
  };
  void ipc('agents:run', input).catch((error: unknown) => {
    // Nothing was sent, so the echo would be a lie.
    const sent = { ...state.sent };
    delete sent[conversationId];
    set({ sent });
    pushAlert({
      id: `send-failed:${Date.now()}`,
      kind: 'failure',
      chip: 'Failed',
      title: 'The turn did not start',
      detail: describe(error),
      risk: null,
      tool: null,
      requestId: null,
      runQuestion: null,
      conversationId,
      windowId: null,
      at: Date.now(),
    });
  });
}

/** Reads one project's studio. Three reads that belong together, so the screen never shows half of it. */
export async function loadBoard(projectId: string): Promise<void> {
  const [board, catalog, files] = await Promise.all([
    ipc<StudioBoard>('studio:board-read', { projectId }),
    ipc<StudioArtifacts>('studio:artifacts-read', { projectId }),
    ipc<string[]>('studio:artifacts-files', { projectId }),
  ]);
  set({ board: { projectId, cards: board.cards, artifacts: catalog.artifacts, files, at: Date.now() } });
}

/**
 * The conversations the desktop would show in its Workspace. One read, and the newest first: the phone
 * lists them the way the desktop's sidebar does, so the same thread is in the same place on both.
 */
export async function loadConversations(): Promise<void> {
  const conversations = await ipc<ConversationRecord[]>('conversations:list', {});
  set({ conversations: [...conversations].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)) });
}

/**
 * The C1 brain's task board. `remote:tasks` is the phone's own read: it fixes the brain operation
 * server-side, so this is the only question the phone can ask about tasks — there is no way from here to
 * claim or complete one.
 */
export async function loadTasks(): Promise<void> {
  set({ tasks: await ipc<BoardTask[]>('remote:tasks', {}) });
}

let boardTimer: ReturnType<typeof setTimeout> | null = null;

/** The desktop announces board changes; this keeps the open board current without polling it. */
function scheduleBoardReload(): void {
  if (!state.board || boardTimer) return;
  boardTimer = setTimeout(() => {
    boardTimer = null;
    const projectId = state.board?.projectId;
    if (!projectId) return;
    void loadBoard(projectId).catch(() => undefined);
  }, 700);
}

export function clearBoard(): void {
  set({ board: null });
}

/**
 * The board's own rules are the ones worth keeping: a move to `done` is still refused until a check has
 * passed, and a claim is refused while another holder has the card. Both refusals reach the user as the
 * main process wrote them, rather than being guessed at here.
 */
export const board = {
  move: async (cardId: string, status: BoardStatus, note = ''): Promise<void> => {
    const projectId = state.board?.projectId;
    if (!projectId) throw new RemoteError('NO_BOARD', 'No board is open.');
    await ipc('studio:board-move', { projectId, cardId, status, note });
    await loadBoard(projectId);
  },
  claim: async (cardId: string, agent: string): Promise<void> => {
    const projectId = state.board?.projectId;
    if (!projectId) throw new RemoteError('NO_BOARD', 'No board is open.');
    await ipc('studio:board-claim', { projectId, cardId, agent });
    await loadBoard(projectId);
  },
  reload: loadBoard,
};

/** The controls the phone offers over work already in flight. Every one of them is a single channel. */
export const controls = {
  stopWorkflow: async (workflowId: string): Promise<void> => {
    await ipc('workflows:stop', { workflowId });
    scheduleRefresh(0);
  },
  resumeWorkflow: async (workflowId: string): Promise<void> => {
    await ipc('workflows:resume', { workflowId });
    scheduleRefresh(0);
  },
  cancelTurn: async (conversationId: string): Promise<void> => {
    await ipc('agents:cancel', { conversationId });
    scheduleRefresh(0);
  },
  pauseTurn: async (conversationId: string): Promise<void> => {
    await ipc('agents:pause', { conversationId });
    scheduleRefresh(0);
  },
  resumeTurn: async (conversationId: string): Promise<void> => {
    await ipc('agents:resume', { conversationId });
    scheduleRefresh(0);
  },
};

export function start(): () => void {
  void refresh();
  if (resolveToken()) {
    stopStream = openStream({
      onFrame,
      onResync: () => {
        set({ tails: {}, sent: {} });
        void refresh();
      },
      onConnectionChange: (connected) => set({ connected }),
    });
  }
  const poll = setInterval(() => void refresh(), 20_000);
  return () => {
    clearInterval(poll);
    stopStream?.();
    stopStream = null;
  };
}
