import { History, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import type { CrewRun, CrewTask, CrewTaskDiff } from '@kai/contracts';
import { unwrap } from '../types';
import { UiButton } from './UiButton';

const VERDICT: Record<string, string> = { accept: 'accepted it', sendBack: 'sent it back', needsYou: 'needs you' };

function flat(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** The biggest number of times the same send-back reason came up, ignoring wording, case and punctuation. */
export function repeatedReasons(task: Pick<CrewTask, 'reviews'>): number {
  const counts = new Map<string, number>();
  for (const review of task.reviews) {
    if (review.verdict !== 'sendBack' || !flat(review.feedback)) continue;
    const key = flat(review.feedback).slice(0, 120);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values());
}

/**
 * What a card on the board leaves out: what the task is, what it has to satisfy, every review it went through in the
 * reviewers' own words, the files it changed, and, while the crew is not working, a way back to before it started.
 */
export function CrewTaskDetail({ run, task, busy, onClose, onRevert }: {
  run: CrewRun;
  task: CrewTask;
  busy: boolean;
  onClose: () => void;
  onRevert: (taskId: string) => void;
}): ReactNode {
  const roleLabel = (id: string): string => run.config.roles.find((role) => role.id === id)?.label ?? id;
  const live = run.status === 'running' || run.status === 'planning';
  const repeats = useMemo(() => repeatedReasons(task), [task]);
  const [diff, setDiff] = useState<{ taskId: string; value: CrewTaskDiff } | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const showDiff = async (): Promise<void> => {
    setLoading(true);
    setDiffError(null);
    try {
      setDiff({ taskId: task.id, value: unwrap(await window.kaiDesktop.crewTaskDiff(run.id, task.id)) });
    } catch (error) {
      setDiffError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };
  const shown = diff && diff.taskId === task.id ? diff.value : null;
  return (
    <section className="ops-panel crew-task-detail" aria-label={`Details of ${task.title}`}>
      <div className="crew-task-detail-head">
        <h3>{task.title}</h3>
        <UiButton type="button" className="composer-text-button" aria-label="Close the details" onClick={onClose}><X size={14} /> Close</UiButton>
      </div>
      <p className="tasks-tab-help">
        {roleLabel(task.role)} · {task.status === 'accepted' ? 'accepted' : task.status === 'skipped' ? 'skipped' : task.status} · round {task.round}
        {task.phase ? ` · ${task.phase}` : ''}{task.costUsd > 0 ? ` · $${task.costUsd.toFixed(2)}` : ''}
      </p>
      {repeats >= 2 && <p className="crew-feedback" role="status">Sent back {repeats} times for the same reason, so more rounds are unlikely to change it. Steer the crew, or skip this task.</p>}
      {task.note && <p className="crew-feedback">{task.note}</p>}
      {task.description && <p className="crew-task-detail-text">{task.description}</p>}

      <h4 className="crew-subheading">What it has to satisfy</h4>
      <ul className="crew-list">{task.acceptance.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>

      {task.reviews.length > 0 && (
        <>
          <h4 className="crew-subheading">What the reviewers said</h4>
          <ul className="crew-list">
            {task.reviews.map((review, index) => (
              <li key={`${review.at}-${index}`}><strong>{roleLabel(review.reviewer)}, round {review.round}, {VERDICT[review.verdict] ?? review.verdict}.</strong>{review.feedback ? ` ${review.feedback}` : ''}</li>
            ))}
          </ul>
        </>
      )}

      {task.files.length > 0 && (
        <details>
          <summary>{task.files.length} {task.files.length === 1 ? 'file' : 'files'} changed</summary>
          <ul className="crew-list">{task.files.slice(0, 60).map((file) => <li key={file}><code>{file}</code></li>)}{task.files.length > 60 && <li>and {task.files.length - 60} more</li>}</ul>
        </details>
      )}

      {task.checkpoint && task.status !== 'backlog' && (
        <div className="crew-diff">
          <UiButton type="button" className="secondary-button" disabled={loading} onClick={() => void showDiff()} title="Show the lines this task changed, compared with before it started">{loading ? 'Loading…' : shown ? 'Refresh the changes' : 'Show what changed'}</UiButton>
          {diffError && <p className="crew-feedback" role="alert">{diffError}</p>}
          {shown && (shown.files.length === 0 ? <small className="crew-empty">Nothing differs from before the task started.</small> : (
            <>
              {shown.files.map((file) => (
                <details key={file.path}>
                  <summary><code>{file.path}</code></summary>
                  <pre className="crew-diff-body">{file.diff.trim() || 'No text changes to show (a new, deleted or binary file).'}</pre>
                </details>
              ))}
              {shown.more > 0 && <small className="crew-empty">and {shown.more} more {shown.more === 1 ? 'file' : 'files'} not shown.</small>}
            </>
          ))}
        </div>
      )}

      {task.checkpoint && !live && task.status !== 'backlog' && (
        <div className="studio-actions">
          <UiButton type="button" className="secondary-button" disabled={busy} onClick={() => onRevert(task.id)} title="Put the project back as it was before this task started"><History size={14} /> Go back to before this task</UiButton>
          <small className="crew-empty">It shows what would change first, and asks.</small>
        </div>
      )}
      {task.checkpoint && live && <small className="crew-empty">Pause the crew to go back to before this task.</small>}
    </section>
  );
}
