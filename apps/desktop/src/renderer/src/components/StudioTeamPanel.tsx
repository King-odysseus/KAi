import { useEffect, useRef, useState, type ReactNode } from 'react';
import { joinRoom, type Room } from 'trystero';
import { ARTIFACT_KINDS, type ArtifactKind, type StudioArtifacts, type StudioBoard } from '@kai/contracts';
import { unwrap } from '../types';
import { parseTeamInvite, shareableCodePath, shareableRepository } from './studio-team-share';
import { UiButton } from './UiButton';
import { UiTextInput } from './UiTextInput';

type TeamCard = { id: string; title: string; status: string; claimedBy: string | null; notes: string; story: string; files: string[]; acceptance: string[]; runs: Array<{ agent: string; at: string; files: string[] }>; checkedAt: string | null };
type TeamSnapshot = {
  name: string;
  projectTitle: string;
  repository: string | null;
  branch: string | null;
  updatedAt: string;
  cards: TeamCard[];
  artifacts: Array<{ kind: ArtifactKind; updatedAt: string; stale: boolean }>;
  files: string[];
  changedFiles: string[];
};
type TeamMessage = { id: string; from: string; text: string; at: string; cardId?: string };
type TeamResourceRequest = { kind: 'artifact' | 'file' | 'diff'; key: string };
type TeamResource = { kind: TeamResourceRequest['kind']; key: string; content: string; from: string };
type Peer = { id: string; snapshot: TeamSnapshot | null };

const APP_ID = 'ai.kai.desktop.project-studio.team.v1';
const MAX_MESSAGE = 2_000;
const MAX_RESOURCE = 250_000;
const SNAPSHOT_INTERVAL = 5_000;

function safeName(value: string): string {
  return value.trim().slice(0, 48) || 'Developer';
}

function readMessages(roomId: string): TeamMessage[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(`kai.team.chat.${roomId}`) ?? '[]');
    return Array.isArray(saved) ? saved.filter(isTeamMessage).slice(-100) : [];
  } catch { return []; }
}

function isTeamMessage(value: unknown): value is TeamMessage {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<TeamMessage>;
  return typeof row.id === 'string' && row.id.length <= 100 && typeof row.from === 'string' && row.from.length <= 48
    && typeof row.text === 'string' && row.text.length <= MAX_MESSAGE && typeof row.at === 'string' && row.at.length <= 50;
}

function isTeamSnapshot(value: unknown): value is TeamSnapshot {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<TeamSnapshot>;
  return typeof row.name === 'string' && row.name.length <= 48
    && typeof row.projectTitle === 'string' && row.projectTitle.length <= 300
    && (row.repository === null || (typeof row.repository === 'string' && shareableRepository(row.repository) !== null))
    && (row.branch === null || (typeof row.branch === 'string' && row.branch.length <= 100))
    && typeof row.updatedAt === 'string' && row.updatedAt.length <= 50
    && Array.isArray(row.cards) && row.cards.length <= 500
    && row.cards.every((card) => card && typeof card.id === 'string' && card.id.length <= 120
      && typeof card.title === 'string' && card.title.length <= 200
      && typeof card.status === 'string' && card.status.length <= 30
      && (card.claimedBy === null || (typeof card.claimedBy === 'string' && card.claimedBy.length <= 120))
      && typeof card.notes === 'string' && card.notes.length <= 1_000
      && typeof card.story === 'string' && card.story.length <= 2_000
      && Array.isArray(card.files) && card.files.length <= 50 && card.files.every((path: unknown) => typeof path === 'string' && path.length <= 1_000 && shareableCodePath(path))
      && Array.isArray(card.acceptance) && card.acceptance.length <= 20 && card.acceptance.every((line: unknown) => typeof line === 'string' && line.length <= 400)
      && Array.isArray(card.runs) && card.runs.length <= 10 && card.runs.every((run: TeamCard['runs'][number]) => run && typeof run.agent === 'string' && run.agent.length <= 120 && typeof run.at === 'string' && run.at.length <= 50 && Array.isArray(run.files) && run.files.length <= 50 && run.files.every((path: unknown) => typeof path === 'string' && path.length <= 1_000 && shareableCodePath(path)))
      && (card.checkedAt === null || (typeof card.checkedAt === 'string' && card.checkedAt.length <= 50)))
    && Array.isArray(row.artifacts) && row.artifacts.length <= ARTIFACT_KINDS.length
    && row.artifacts.every((item) => item && ARTIFACT_KINDS.includes(item.kind) && typeof item.updatedAt === 'string' && item.updatedAt.length <= 50 && typeof item.stale === 'boolean')
    && Array.isArray(row.files) && row.files.length <= 1_000
    && row.files.every((path) => typeof path === 'string' && path.length <= 1_000 && shareableCodePath(path))
    && Array.isArray(row.changedFiles) && row.changedFiles.length <= 500
    && row.changedFiles.every((path) => typeof path === 'string' && path.length <= 1_000 && shareableCodePath(path));
}

function cardFiles(card: StudioBoard['cards'][number]): string[] {
  return [...new Set(card.runs.flatMap((run) => run.files))].filter(shareableCodePath).slice(0, 50);
}

export function StudioTeamPanel({ projectId, projectTitle, linkedProjectId, artifacts, onArtifactsChanged }: {
  projectId: string;
  projectTitle: string;
  linkedProjectId: string | null;
  artifacts: StudioArtifacts | null;
  onArtifactsChanged: (artifacts: StudioArtifacts) => void;
}): ReactNode {
  const [name, setName] = useState(() => safeName(localStorage.getItem('kai.team.name') ?? ''));
  const [inviteInput, setInviteInput] = useState('');
  const [invite, setInvite] = useState<string | null>(null);
  const [status, setStatus] = useState('No session connected');
  const [peers, setPeers] = useState<Record<string, Peer>>({});
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null);
  const [resource, setResource] = useState<TeamResource | null>(null);
  const [resourceBusy, setResourceBusy] = useState(false);
  const [messages, setMessages] = useState<TeamMessage[]>([]);
  const [chatRoomId, setChatRoomId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fileFilter, setFileFilter] = useState('');
  const [learningCardId, setLearningCardId] = useState<string | null>(null);
  const roomRef = useRef<Room | null>(null);
  const snapshotRef = useRef<TeamSnapshot | null>(null);
  const filesRef = useRef<Set<string>>(new Set());
  const chatSendRef = useRef<((message: string) => Promise<void>) | null>(null);
  const resourceRequestRef = useRef<((request: string, options: { target: string; timeoutMs: number }) => Promise<string>) | null>(null);
  const parsedInvite = invite ? parseTeamInvite(invite) : null;
  const selectedPeer = selectedPeerId ? peers[selectedPeerId] ?? null : null;
  const learningCard = selectedPeer?.snapshot?.cards.find((card) => card.id === learningCardId) ?? null;

  useEffect(() => { localStorage.setItem('kai.team.name', safeName(name)); }, [name]);
  useEffect(() => {
    if (parsedInvite && chatRoomId === parsedInvite.roomId) localStorage.setItem(`kai.team.chat.${chatRoomId}`, JSON.stringify(messages.slice(-100)));
  }, [messages, chatRoomId, parsedInvite?.roomId]);
  useEffect(() => { setInvite(null); setPeers({}); setSelectedPeerId(null); setResource(null); }, [projectId]);

  useEffect(() => {
    if (!parsedInvite) return;
    let closed = false;
    const { roomId, password } = parsedInvite;
    setChatRoomId(roomId);
    setMessages(readMessages(roomId));
    setPeers({});
    setSelectedPeerId(null);
    setResource(null);
    setStatus('Connecting to session…');
    const room = joinRoom({ appId: APP_ID, password }, roomId, {
      onJoinError: ({ error: reason }) => { if (!closed) { setError(reason); setStatus('Connection failed'); } },
    });
    roomRef.current = room;
    const snapshotAction = room.makeAction<string>('snapshot');
    const chatAction = room.makeAction<string>('chat');
    const resourceAction = room.makeAction<string, string>('resource', {
      kind: 'request',
      onRequest: async (raw) => {
        try {
          if (raw.length > 500) throw new Error('Invalid request');
          const request = JSON.parse(raw) as TeamResourceRequest;
          if (!request || typeof request.key !== 'string' || request.key.length > 1_000) throw new Error('Invalid request');
          let content: string | null = null;
          if (request.kind === 'artifact' && ARTIFACT_KINDS.includes(request.key as ArtifactKind)) {
            content = unwrap(await window.kaiDesktop.studioArtifactText({ projectId, kind: request.key as ArtifactKind }));
          } else if (request.kind === 'file' && linkedProjectId && filesRef.current.has(request.key)) {
            content = unwrap(await window.kaiDesktop.readProjectFile(linkedProjectId, request.key)).content;
          } else if (request.kind === 'diff' && linkedProjectId && filesRef.current.has(request.key)) {
            content = unwrap(await window.kaiDesktop.gitDiff(linkedProjectId, request.key, false)).output;
          } else throw new Error('That item is not shared');
          if (content === null) throw new Error('The item is unavailable');
          if (content.length > MAX_RESOURCE) throw new Error('The item is too large to share');
          return JSON.stringify({ kind: request.kind, key: request.key, content });
        } catch (caught) { return JSON.stringify({ error: caught instanceof Error ? caught.message : String(caught) }); }
      },
    });
    resourceRequestRef.current = resourceAction.request;
    chatSendRef.current = (message) => chatAction.send(message);
    snapshotAction.onMessage = (raw, { peerId }) => {
      if (closed || raw.length > 1_000_000) return;
      try {
        const snapshot: unknown = JSON.parse(raw);
        if (!isTeamSnapshot(snapshot)) return;
        setPeers((current) => ({ ...current, [peerId]: { id: peerId, snapshot } }));
        setSelectedPeerId((current) => current ?? peerId);
      } catch { /* Ignore invalid peer data. */ }
    };
    chatAction.onMessage = (raw) => {
      if (closed || raw.length > 3_000) return;
      try {
        const message: unknown = JSON.parse(raw);
        if (isTeamMessage(message)) setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message].slice(-100));
      } catch { /* Ignore invalid peer data. */ }
    };
    room.onPeerJoin = (peerId) => {
      if (closed) return;
      setPeers((current) => ({ ...current, [peerId]: { id: peerId, snapshot: null } }));
      setStatus('Connected');
      if (snapshotRef.current) void snapshotAction.send(JSON.stringify(snapshotRef.current), { target: peerId });
    };
    room.onPeerLeave = (peerId) => {
      if (closed) return;
      setPeers((current) => { const next = { ...current }; delete next[peerId]; return next; });
      setSelectedPeerId((current) => current === peerId ? null : current);
      setStatus(Object.keys(room.getPeers()).length ? 'Connected' : 'Waiting for teammates');
    };
    const refresh = async (): Promise<void> => {
      try {
        const [nextBoard, nextArtifacts, git, tree] = await Promise.all([
          window.kaiDesktop.studioBoard(projectId).then(unwrap),
          window.kaiDesktop.studioArtifacts(projectId).then(unwrap),
          linkedProjectId ? window.kaiDesktop.gitOverview(linkedProjectId).then(unwrap).catch(() => null) : Promise.resolve(null),
          linkedProjectId ? window.kaiDesktop.projectFileTree(linkedProjectId).then(unwrap).catch(() => null) : Promise.resolve(null),
        ]);
        if (closed) return;
        const files = (tree?.files ?? []).map((entry) => entry.path).filter(shareableCodePath).slice(0, 1_000);
        filesRef.current = new Set(files);
        const snapshot: TeamSnapshot = {
          name: safeName(localStorage.getItem('kai.team.name') ?? name), projectTitle,
          repository: shareableRepository(git?.githubRepository ?? null), branch: git?.branch ?? null,
          updatedAt: new Date().toISOString(),
          cards: nextBoard.cards.slice(0, 500).map((card) => ({ id: card.id, title: card.title, status: card.status, claimedBy: card.claimedBy, notes: card.notes.slice(0, 1_000), story: card.story.slice(0, 2_000), files: cardFiles(card), acceptance: card.acceptance, runs: card.runs.slice(-10).map((run) => ({ agent: run.agent, at: run.at, files: run.files.filter(shareableCodePath).slice(0, 50) })), checkedAt: card.check?.at ?? null })),
          artifacts: nextArtifacts.artifacts.map((item) => ({ kind: item.kind, updatedAt: item.updatedAt, stale: item.stale })),
          files, changedFiles: (git?.changes ?? []).map((item) => item.path).filter(shareableCodePath).slice(0, 500),
        };
        const previous = snapshotRef.current;
        snapshotRef.current = snapshot;
        const comparable = (value: TeamSnapshot) => JSON.stringify({ ...value, updatedAt: '' });
        if (!previous || comparable(previous) !== comparable(snapshot)) await snapshotAction.send(JSON.stringify(snapshot));
        if (!Object.keys(room.getPeers()).length) setStatus('Waiting for teammates');
      } catch (caught) { if (!closed) setError(caught instanceof Error ? caught.message : String(caught)); }
    };
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, SNAPSHOT_INTERVAL);
    return () => {
      closed = true;
      window.clearInterval(interval);
      room.onPeerJoin = null;
      room.onPeerLeave = null;
      snapshotAction.onMessage = null;
      chatAction.onMessage = null;
      resourceRequestRef.current = null;
      chatSendRef.current = null;
      roomRef.current = null;
      snapshotRef.current = null;
      filesRef.current = new Set();
      void room.leave();
    };
  }, [invite, projectId, linkedProjectId, projectTitle]);

  function createSession(): void {
    const next = `kai-team:${crypto.randomUUID().replace(/-/g, '')}:${crypto.randomUUID().replace(/-/g, '')}`;
    setError(null); setNotice(null); setInvite(next); setInviteInput(next);
  }

  function joinSession(): void {
    const parsed = parseTeamInvite(inviteInput);
    if (!parsed) { setError('Enter a valid KAi Team invite code.'); return; }
    setError(null); setNotice(null); setInvite(`kai-team:${parsed.roomId}:${parsed.password}`);
  }

  async function requestResource(kind: TeamResourceRequest['kind'], key: string): Promise<void> {
    if (!selectedPeerId || !resourceRequestRef.current) return;
    setResourceBusy(true); setError(null); setResource(null);
    try {
      const raw = await resourceRequestRef.current(JSON.stringify({ kind, key }), { target: selectedPeerId, timeoutMs: 20_000 });
      if (raw.length > MAX_RESOURCE + 1_000) throw new Error('The response is too large');
      const response = JSON.parse(raw) as Partial<TeamResource> & { error?: string };
      if (response.error) throw new Error(response.error);
      if (response.kind !== kind || response.key !== key || typeof response.content !== 'string') throw new Error('Invalid response');
      setResource({ kind, key, content: response.content, from: selectedPeerId });
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setResourceBusy(false); }
  }

  async function pullArtifact(): Promise<void> {
    if (!resource || resource.kind !== 'artifact' || !ARTIFACT_KINDS.includes(resource.key as ArtifactKind)) return;
    const kind = resource.key as ArtifactKind;
    if (artifacts?.artifacts.some((item) => item.kind === kind) && !window.confirm(`Replace your local ${kind} artifact with this copy?`)) return;
    try {
      onArtifactsChanged(unwrap(await window.kaiDesktop.saveStudioArtifact({ projectId, kind, content: resource.content })));
      setNotice(`${kind} was saved to your Studio project.`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  }

  async function sendChat(): Promise<void> {
    const text = draft.trim().slice(0, MAX_MESSAGE);
    if (!text || !chatSendRef.current) return;
    const message: TeamMessage = { id: crypto.randomUUID(), from: safeName(name), text, at: new Date().toISOString() };
    try {
      await chatSendRef.current(JSON.stringify(message));
      setMessages((current) => [...current, message].slice(-100));
      setDraft('');
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  }

  async function pullBranch(): Promise<void> {
    if (!linkedProjectId || !selectedPeer?.snapshot?.repository || !selectedPeer.snapshot.branch) return;
    try {
      unwrap(await window.kaiDesktop.gitPullTeamBranch(linkedProjectId, selectedPeer.snapshot.repository, selectedPeer.snapshot.branch));
      setNotice(`Pulled ${selectedPeer.snapshot.branch}. The linked project is now on that branch.`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  }

  async function cloneRepository(): Promise<void> {
    if (!selectedPeer?.snapshot?.repository) return;
    try {
      const result = unwrap(await window.kaiDesktop.gitCloneTeamRepository(selectedPeer.snapshot.repository));
      if (result) setNotice(`Cloned into ${result.path} and added to Projects. You can link this Studio plan to it from the project picker above.`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  }

  return <section className="studio-card studio-team" aria-label="Team collaboration">
    <div className="studio-team-heading"><div><h2>Connected Project Studio</h2><p className="studio-note">Share this project live with another KAi Desktop. Only people with the invite code can join.</p></div><span className="studio-team-status">{status}</span></div>
    {error && <p className="studio-notice error" role="alert">{error}</p>}
    {notice && <p className="studio-notice" role="status">{notice}</p>}
    {!invite ? <div className="studio-team-join">
      <label>Your name<UiTextInput value={name} maxLength={48} onChange={(event) => setName(event.target.value)} /></label>
      <UiButton type="button" className="primary-button" onClick={createSession}>Share this project</UiButton>
      <label>Invite code<UiTextInput value={inviteInput} onChange={(event) => setInviteInput(event.target.value)} placeholder="Paste a teammate’s invite code" /></label>
      <UiButton type="button" className="secondary-button" onClick={joinSession}>Join session</UiButton>
    </div> : <>
      <div className="studio-team-invite"><code>{invite}</code><UiButton type="button" className="secondary-button" onClick={() => void navigator.clipboard.writeText(invite).then(() => setNotice('Invite code copied.'))}>Copy invite</UiButton><UiButton type="button" className="secondary-button" onClick={() => setInvite(null)}>Leave</UiButton></div>
      <p className="studio-note">Sharing: board activity, Studio artifact list, code file list and changed files. File contents are sent only when a teammate opens one. Close the session to stop sharing.</p>
      <div className="studio-team-layout">
        <aside className="studio-team-peers"><h3>Teammates ({Object.keys(peers).length})</h3>{Object.values(peers).length ? Object.values(peers).map((peer) => <UiButton key={peer.id} type="button" className={selectedPeerId === peer.id ? 'active' : ''} onClick={() => { setSelectedPeerId(peer.id); setResource(null); }}><span className="status-dot online" />{peer.snapshot?.name ?? 'Connecting…'}<small>{peer.snapshot?.projectTitle}</small></UiButton>) : <p className="studio-note">Waiting for someone to join with your invite code.</p>}</aside>
        <div className="studio-team-work">
          {selectedPeer?.snapshot ? <>
            <div className="studio-team-repo"><strong>{selectedPeer.snapshot.projectTitle}</strong><span>{selectedPeer.snapshot.repository ?? 'No GitHub repository'}{selectedPeer.snapshot.branch ? ` · ${selectedPeer.snapshot.branch}` : ''}</span>{selectedPeer.snapshot.repository && <><UiButton type="button" className="secondary-button" onClick={() => void cloneRepository()}>Clone repository</UiButton><UiButton type="button" className="secondary-button" disabled={!linkedProjectId || !selectedPeer.snapshot.branch} onClick={() => void pullBranch()}>Pull branch</UiButton></>}</div>
            <div className="studio-team-sections">
              <div><h3>Board ({selectedPeer.snapshot.cards.length})</h3><div className="studio-team-scroll">{selectedPeer.snapshot.cards.map((card) => <article key={card.id}><strong>{card.title}</strong><small>{card.status}{card.claimedBy ? ` · ${card.claimedBy}` : ''}</small><UiButton type="button" className="secondary-button" onClick={() => setLearningCardId(card.id)}>Learn from this work</UiButton></article>)}</div></div>
              <div><h3>Artifacts ({selectedPeer.snapshot.artifacts.length})</h3><div className="studio-team-scroll">{selectedPeer.snapshot.artifacts.map((item) => <UiButton key={item.kind} type="button" onClick={() => void requestResource('artifact', item.kind)}>{item.kind}{item.stale && <small>Stale</small>}</UiButton>)}</div></div>
              <div><h3>Code ({selectedPeer.snapshot.files.length})</h3><UiTextInput value={fileFilter} onChange={(event) => setFileFilter(event.target.value)} placeholder="Find a file" /><div className="studio-team-scroll">{selectedPeer.snapshot.files.filter((path) => path.toLowerCase().includes(fileFilter.toLowerCase())).slice(0, 100).map((path) => <UiButton key={path} type="button" onClick={() => void requestResource('file', path)}>{path}{selectedPeer.snapshot?.changedFiles.includes(path) && <small>Changed</small>}</UiButton>)}</div></div>
            </div>
            {learningCard && <div className="studio-team-learning"><h3>{learningCard.title}</h3><p>{learningCard.story || 'No story recorded.'}</p>{learningCard.acceptance.length > 0 && <><strong>What needed to work</strong><ul>{learningCard.acceptance.map((line) => <li key={line}>{line}</li>)}</ul></>}{learningCard.runs.length > 0 && <><strong>How it was built</strong><ol>{learningCard.runs.map((run, index) => <li key={`${run.at}-${index}`}>{run.agent} worked on {run.files.length ? run.files.join(', ') : 'this card'} · {new Date(run.at).toLocaleString()}</li>)}</ol></>}{learningCard.notes && <p>{learningCard.notes}</p>}{learningCard.checkedAt && <p>Checked {new Date(learningCard.checkedAt).toLocaleString()}</p>}</div>}
            {resourceBusy && <p className="studio-note">Reading from teammate…</p>}
            {resource && <div className="studio-team-resource"><div><strong>{resource.key}</strong><span>{resource.kind}</span>{resource.kind === 'artifact' && <UiButton type="button" className="primary-button" onClick={() => void pullArtifact()}>Pull artifact into my Studio</UiButton>}{resource.kind === 'file' && selectedPeer.snapshot.changedFiles.includes(resource.key) && <UiButton type="button" className="secondary-button" onClick={() => void requestResource('diff', resource.key)}>View diff</UiButton>}</div><pre>{resource.content}</pre></div>}
          </> : <p className="studio-note">Select a teammate to inspect their shared work.</p>}
        </div>
      </div>
      <div className="studio-team-chat"><h3>Project chat</h3><div className="studio-team-chat-messages">{messages.map((message) => <p key={message.id}><strong>{message.from}</strong><small>{new Date(message.at).toLocaleTimeString()}</small><span>{message.text}</span></p>)}{messages.length === 0 && <p className="studio-note">Messages are kept on each participant’s device while they are in this session.</p>}</div><div><UiTextInput value={draft} maxLength={MAX_MESSAGE} placeholder="Message this project" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void sendChat(); }} /><UiButton type="button" className="primary-button" onClick={() => void sendChat()} disabled={!draft.trim()}>Send</UiButton></div></div>
    </>}
  </section>;
}
