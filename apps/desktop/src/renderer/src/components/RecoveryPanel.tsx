import { FileText, RotateCcw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { RecoveryRecap, RecoveryRecord, RecoveryResume } from '@kai/contracts';
import { relativeTime, unwrap } from '../types';
import { confirmDialog } from './AppDialog';
import { UiButton } from './UiButton';

export function RecoveryPanel({ onResume, onChanged }: { onResume: (resume: RecoveryResume) => Promise<void>; onChanged: () => void }): ReactNode {
  const [records, setRecords] = useState<RecoveryRecord[]>([]);
  const [unreadable, setUnreadable] = useState<string[]>([]);
  const [recap, setRecap] = useState<RecoveryRecap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const listing = unwrap(await window.kaiDesktop.listInterruptedRuns());
      setRecords(listing.records);
      setUnreadable(listing.unreadable);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Interrupted runs could not be loaded.');
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function act(id: string, action: () => Promise<void>): Promise<void> {
    setWorking(id);
    try {
      await action();
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That action failed.');
    } finally {
      setWorking(null);
      await refresh();
      onChanged();
    }
  }

  return (
    <div className="ops-panel">
      <p className="settings-note">
        These runs were still going when KAI closed or crashed. Nothing resumes on its own: review the recap, then choose Resume or Discard.
      </p>
      {error && <div className="workbench-error" role="alert">{error}</div>}
      {/* Said out loud rather than filed away. These used to be skipped silently, which is how the banner came to
          count two runs when eight were on disk — and why the missing ones could never be found again. */}
      {unreadable.length > 0 && (
        <div className="workbench-error" role="alert">
          {unreadable.length} record{unreadable.length === 1 ? '' : 's'} could not be read, so there is nothing to resume from {unreadable.length === 1 ? 'it' : 'them'}. Stop everything clears {unreadable.length === 1 ? 'it' : 'them'}.
        </div>
      )}
      {records.length === 0 && unreadable.length === 0 && <div className="empty-list">No interrupted runs</div>}
      {records.map((record) => (
        <section key={record.conversationId} className="settings-section ops-card">
          <div className="ops-card-head">
            <strong className="truncate">{record.title || record.conversationId}</strong>
            <span>{relativeTime(record.updatedAt)}</span>
          </div>
          <div className="settings-note">{record.agent} · {record.execution === 'api' ? `API (${record.route})` : 'CLI'} · {record.eventCount} events · last: {record.lastActivity}</div>
          <div className="ops-actions">
            <UiButton type="button" className="primary-button" disabled={working !== null} onClick={() => void act(record.conversationId, async () => {
              await onResume(unwrap(await window.kaiDesktop.resumeInterruptedRun(record.conversationId)));
            })}><RotateCcw size={14} /><span>Resume</span></UiButton>
            <UiButton type="button" className="secondary-button" disabled={working !== null} onClick={() => void act(record.conversationId, async () => {
              setRecap(unwrap(await window.kaiDesktop.interruptedRunRecap(record.conversationId)));
            })}><FileText size={14} /><span>View recap</span></UiButton>
            <UiButton type="button" className="secondary-button" disabled={working !== null} onClick={() => void confirmDialog({
              title: 'Discard interrupted run?',
              detail: 'Discard this interrupted run? Its files stay as they are.',
              confirmLabel: 'Discard run',
              destructive: true,
            }).then((confirmed) => {
              if (confirmed) void act(record.conversationId, async () => {
                unwrap(await window.kaiDesktop.discardInterruptedRun(record.conversationId));
                if (recap?.conversationId === record.conversationId) setRecap(null);
              });
            })}><Trash2 size={14} /><span>Discard</span></UiButton>
          </div>
          {recap?.conversationId === record.conversationId && (
            <div className="ops-recap">
              <pre>{recap.recap}</pre>
              {recap.brainRecap && <><small>From the C1 brain</small><pre>{recap.brainRecap}</pre></>}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
