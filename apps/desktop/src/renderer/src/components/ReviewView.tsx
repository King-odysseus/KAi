import { FileTypeIcon } from './FileTypeIcon';
import { CheckCircle2, ListChecks, RefreshCw, Sparkles, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ChangeReviewResult, CheckpointReview, ConversationRecord, FileVerificationState, ProjectRecord, ReviewMode, VerificationOverview } from '@kai/contracts';
import { MAX_REVIEW_FILES } from '@kai/contracts';
import { relativeTime, unwrap } from '../types';
import { confirmDialog } from './AppDialog';
import { HunkReview, canReviewHunks } from './HunkReview';
import { Pill } from './Pill';
import { UiButton } from './UiButton';
import { VerificationBadge } from './VerificationPanel';
import { Card } from './ui/Card';
import { PageHeader } from './ui/PageHeader';

interface ReviewableTurn {
  turnId: string;
  at: string;
  fileCount: number;
}

type Verdict = { tone: 'success' | 'warning' | 'error' | 'neutral'; label: string; detail: string };

/** One honest line about whether this turn's changes are ready to accept, from the checks and the AI review. */
function verdictFor(review: CheckpointReview | null, statuses: Record<string, FileVerificationState>, ai: ChangeReviewResult | null): Verdict {
  if (!review || review.files.length === 0) return { tone: 'neutral', label: 'Nothing to review', detail: 'No files differ from this checkpoint.' };
  const states = review.files.map((file) => statuses[file.path] ?? 'unverified');
  const failed = states.filter((state) => state === 'failed').length;
  const unchecked = states.filter((state) => state !== 'verified' && state !== 'failed').length;
  const high = ai?.findings.filter((finding) => finding.severity === 'high').length ?? 0;
  if (failed > 0) return { tone: 'error', label: 'Needs you', detail: `${failed} changed file${failed === 1 ? '' : 's'} failed the latest check.` };
  if (high > 0) return { tone: 'error', label: 'Needs you', detail: `The AI review raised ${high} serious point${high === 1 ? '' : 's'}.` };
  if (unchecked > 0) return { tone: 'warning', label: 'Not fully checked', detail: `${unchecked} changed file${unchecked === 1 ? ' is' : 's are'} not covered by a passing check.` };
  if (ai && !ai.ok) return { tone: 'warning', label: 'Read the notes', detail: 'Every file passed its check, and the AI review has points to read.' };
  return { tone: 'success', label: 'Looks ready', detail: ai ? 'Every file passed its check and the AI review found nothing to stop on.' : 'Every file passed its check. Run the AI review for a second opinion.' };
}

/**
 * The diff-first review page: every turn that changed files, the changed files with their hunks, whether each is covered
 * by a passing check, and the actions that put work back. It uses the same checkpoint and verification channels as the
 * workspace's review dialog, so what it undoes is exactly what that dialog would.
 */
export function ReviewView({ activeProject, conversation, reviewMode, onReviewCheckpoint, onRejectCheckpointFile, onRestoreCheckpoint }: {
  activeProject: ProjectRecord | null;
  conversation: ConversationRecord | null;
  reviewMode: ReviewMode;
  onReviewCheckpoint: (conversationId: string, turnId: string) => Promise<CheckpointReview>;
  onRejectCheckpointFile: (conversationId: string, turnId: string, filePath: string) => Promise<void>;
  onRestoreCheckpoint: (conversationId: string, turnId: string) => Promise<void>;
}): ReactNode {
  const turns = useMemo<ReviewableTurn[]>(() => {
    const found: ReviewableTurn[] = [];
    for (const event of conversation?.events ?? []) {
      if (event.type === 'turn.changes' && event.turnId && event.hasCheckpoint && event.files.length > 0) {
        found.push({ turnId: event.turnId, at: event.timestamp, fileCount: event.files.length });
      }
    }
    // Newest first, and a turn that appears twice (a re-run of its summary) is listed once.
    return found.filter((turn, index) => found.findIndex((other) => other.turnId === turn.turnId) === index).reverse();
  }, [conversation?.events]);

  const [selectedTurn, setSelectedTurn] = useState<string | null>(null);
  const [review, setReview] = useState<CheckpointReview | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, FileVerificationState>>({});
  const [overview, setOverview] = useState<VerificationOverview | null>(null);
  const [ai, setAi] = useState<{ state: 'idle' | 'loading' | 'done' | 'error'; result?: ChangeReviewResult; error?: string }>({ state: 'idle' });
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const conversationId = conversation?.id ?? null;
  const projectId = activeProject?.id ?? null;
  const activeTurn = selectedTurn && turns.some((turn) => turn.turnId === selectedTurn) ? selectedTurn : turns[0]?.turnId ?? null;

  // App makes a new onReviewCheckpoint on every render, and loading sets App's busy state. Depending on it directly
  // re-ran the load forever, pulling megabytes of diff over IPC each time until the app fell over.
  const reviewRef = useRef(onReviewCheckpoint);
  reviewRef.current = onReviewCheckpoint;

  const load = useCallback(async (): Promise<void> => {
    if (!conversationId || !activeTurn) { setReview(null); return; }
    setLoading(true);
    try {
      setReview(await reviewRef.current(conversationId, activeTurn));
    } catch (caught) {
      setReview(null);
      setNotice(caught instanceof Error ? caught.message : 'The changes could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [conversationId, activeTurn]);

  useEffect(() => { setAi({ state: 'idle' }); setSelectedFile(null); void load(); }, [load]);

  useEffect(() => {
    if (!projectId) { setStatuses({}); setOverview(null); return; }
    let cancelled = false;
    void window.kaiDesktop.verificationOverview(projectId).then((response) => {
      if (cancelled || !response.ok) return;
      setOverview(response.data);
      setStatuses(Object.fromEntries(response.data.files.map((file) => [file.path, file.status])));
    });
    return () => { cancelled = true; };
  }, [projectId, review]);

  const files = review?.files ?? [];
  const current = files.find((file) => file.path === selectedFile) ?? files[0] ?? null;
  const verdict = verdictFor(review, statuses, ai.result ?? null);

  async function restoreFile(path: string): Promise<void> {
    if (!conversationId || !activeTurn) return;
    try {
      await onRejectCheckpointFile(conversationId, activeTurn, path);
      setNotice(`Restored ${path} from the checkpoint.`);
      await load();
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : 'The file could not be restored.');
    }
  }

  async function rejectHunk(path: string, hunkId: number): Promise<void> {
    if (!conversationId || !activeTurn) return;
    try {
      unwrap(await window.kaiDesktop.rejectCheckpointHunks(conversationId, activeTurn, path, [hunkId]));
      setNotice(`Rejected one change in ${path}.`);
      await load();
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : 'The change could not be rejected.');
    }
  }

  async function undoAll(): Promise<void> {
    if (!conversationId || !activeTurn) return;
    if (!(await confirmDialog({ title: 'Undo every change in this turn?', detail: `All ${files.length} changed files go back to how they were before this turn.`, confirmLabel: 'Undo all' }))) return;
    try {
      await onRestoreCheckpoint(conversationId, activeTurn);
      setNotice('Restored every file changed during that turn.');
      await load();
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : 'The turn could not be undone.');
    }
  }

  async function runAiReview(): Promise<void> {
    if (!projectId || files.length === 0) return;
    setAi({ state: 'loading' });
    try {
      const result = unwrap(await window.kaiDesktop.reviewChanges({ projectId, paths: files.map((file) => file.path).slice(0, MAX_REVIEW_FILES), mode: reviewMode }));
      setAi({ state: 'done', result });
    } catch (caught) {
      setAi({ state: 'error', error: caught instanceof Error ? caught.message : 'The review could not be completed.' });
    }
  }

  const notesForCurrent = current ? ai.result?.findings.filter((finding) => finding.file === current.path) ?? [] : [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Review"
        detail={conversation ? conversation.title : 'Open a conversation to review its changes'}
        actions={<>
          <UiButton type="button" className="secondary-button" disabled={loading} onClick={() => void load()}><RefreshCw size={14} /><span>Refresh</span></UiButton>
          <UiButton type="button" className="secondary-button" disabled={files.length === 0 || ai.state === 'loading'} onClick={() => void runAiReview()}><Sparkles size={14} /><span>{ai.state === 'loading' ? 'Reviewing…' : 'AI review'}</span></UiButton>
          <UiButton type="button" className="secondary-button" disabled={files.length === 0} onClick={() => void undoAll()}><Undo2 size={14} /><span>Undo all</span></UiButton>
        </>}
      />
      {notice && <div className="workbench-notice" role="status"><span>{notice}</span></div>}
      {!activeProject || !conversation ? (
        <div className="empty-list">Open a project and a conversation to review what the agent changed.</div>
      ) : turns.length === 0 ? (
        <div className="empty-list">No turn in this conversation has changed files yet.</div>
      ) : (
        <div className="grid min-h-0 flex-1 gap-3 overflow-hidden p-4" style={{ gridTemplateColumns: 'minmax(180px, 220px) minmax(200px, 280px) minmax(0, 1fr)' }}>
          <Card title="Turns" className="min-h-0 overflow-auto">
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {turns.map((turn, index) => (
                <li key={turn.turnId}>
                  <button type="button" className={`review-pick${turn.turnId === activeTurn ? ' current' : ''}`} onClick={() => setSelectedTurn(turn.turnId)}>
                    <strong>{index === 0 ? 'Latest turn' : `Turn ${turns.length - index}`}</strong>
                    <small>{turn.fileCount} file{turn.fileCount === 1 ? '' : 's'} · {relativeTime(turn.at)}</small>
                  </button>
                </li>
              ))}
            </ul>
          </Card>

          <Card title="Changed files" className="min-h-0 overflow-auto">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Pill tone={verdict.tone}>{verdict.tone === 'success' ? <CheckCircle2 size={12} /> : <ListChecks size={12} />}{verdict.label}</Pill>
              <small className="text-[var(--text-dim)]">{verdict.detail}</small>
            </div>
            {overview?.latest && <small className="mb-2 block text-[var(--text-dim)]">Latest check: {overview.latest.passed ? 'passed' : 'failed'} · {overview.latest.command} · {relativeTime(overview.latest.startedAt)}</small>}
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {files.map((file) => (
                <li key={file.path}>
                  <button type="button" className={`review-pick${file.path === current?.path ? ' current' : ''}`} onClick={() => setSelectedFile(file.path)} title={file.path}>
                    <strong className="truncate"><FileTypeIcon name={file.path.split('/').at(-1) ?? file.path} size={14} />{file.path}</strong>
                    <small><b className="diff-add">+{file.added}</b> <b className="diff-remove">-{file.removed}</b> <VerificationBadge status={statuses[file.path] ?? 'unverified'} /></small>
                  </button>
                </li>
              ))}
              {files.length === 0 && <li className="empty-list">No files differ from this checkpoint</li>}
            </ul>
          </Card>

          <Card
            title={current ? current.path : 'Diff'}
            className="min-h-0 overflow-auto"
            actions={current && <UiButton type="button" className="secondary-button" disabled={!review?.gitAvailable} onClick={() => void restoreFile(current.path)}><Undo2 size={13} /><span>Restore file</span></UiButton>}
          >
            {review && !review.gitAvailable && <div className="workbench-error">This turn has no Git checkpoint, so files cannot be restored automatically.</div>}
            {ai.state === 'error' && <div className="workbench-error" role="alert">{ai.error}</div>}
            {ai.result && <p className="settings-note">{ai.result.summary}</p>}
            {notesForCurrent.map((finding, index) => (
              <div key={index} className={`workbench-notice review-note ${finding.severity}`} role="status">
                <span><strong>{finding.severity}</strong>{finding.line ? ` · line ${finding.line}` : ''} · {finding.note}</span>
              </div>
            ))}
            {current && !current.binary && review?.gitAvailable && canReviewHunks(current.before, current.after) && (
              <HunkReview before={current.before} after={current.after} disabled={false} onReject={(hunkId) => void rejectHunk(current.path, hunkId)} />
            )}
            {current && !current.binary && !(review?.gitAvailable && canReviewHunks(current.before, current.after)) && (
              <div className="checkpoint-diff">
                <div><span>Before</span><pre>{current.before || '(empty)'}</pre></div>
                <div><span>After</span><pre>{current.after || '(empty)'}</pre></div>
              </div>
            )}
            {current?.binary && <div className="empty-list">Binary file: no line diff to show</div>}
            {!current && <div className="empty-list">Pick a changed file to see its diff</div>}
          </Card>
        </div>
      )}
    </div>
  );
}
