import { CheckCircle2, CircleDashed, Play, RefreshCw, XCircle } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { FileVerificationState, ProjectRecord, VerificationOverview } from '@kai/contracts';
import { relativeTime, unwrap } from '../types';
import { confirmDialog } from './AppDialog';
import { UiButton } from './UiButton';
import { UiTextInput } from './UiTextInput';

const LABELS: Record<FileVerificationState, string> = {
  verified: 'Verified',
  failed: 'Check failed',
  stale: 'Stale',
  unverified: 'Not checked',
};

export function VerificationBadge({ status }: { status: FileVerificationState }): ReactNode {
  return <span className={`verify-badge ${status}`} title={status === 'stale' ? 'This file changed since the last check ran' : undefined}>{LABELS[status]}</span>;
}

export function VerificationPanel({ activeProject }: { activeProject: ProjectRecord | null }): ReactNode {
  const projectId = activeProject?.id ?? null;
  const [overview, setOverview] = useState<VerificationOverview | null>(null);
  const [command, setCommand] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      const next = unwrap(await window.kaiDesktop.verificationOverview(projectId));
      setOverview(next);
      setCommand((current) => current || next.latest?.command || next.suggestedCommand || '');
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Verification data could not be loaded.');
    }
  }, [projectId]);
  useEffect(() => {
    setOverview(null);
    setCommand('');
    void refresh();
  }, [refresh]);

  async function run(): Promise<void> {
    if (!projectId || !command.trim()) return;
    if (!(await confirmDialog({
      title: 'Run this check?',
      detail: `Run "${command.trim()}" in ${activeProject?.name}?\n\nIt runs with your user permissions and can take a few minutes.`,
      confirmLabel: 'Run check',
    }))) return;
    setRunning(true);
    try {
      unwrap(await window.kaiDesktop.runVerification(projectId, command.trim()));
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The check could not be run.');
    } finally {
      setRunning(false);
    }
  }

  if (!activeProject) return <div className="empty-list">Open a project to see its checks.</div>;
  if (error) return <div className="workbench-error" role="alert">{error}</div>;
  if (!overview) return <div className="empty-list">Loading…</div>;

  const stale = overview.files.some((file) => file.status === 'stale');
  const latest = overview.latest;
  return (
    <div className="ops-panel">
      <p className="settings-note">
        A check result belongs to the exact content of the files it saw. Edit a file afterwards and its result goes stale until the check runs again.
      </p>
      {!overview.gitAvailable && <div className="workbench-notice" role="status"><span>This project is not a Git repository, so KAI cannot tell which files a check covered.</span></div>}

      <section className="settings-section">
        <div className="section-title">{stale ? <CircleDashed size={16} /> : latest?.passed ? <CheckCircle2 size={16} /> : latest ? <XCircle size={16} /> : <CircleDashed size={16} />}<span>Latest check</span></div>
        {latest ? (
          <p className="settings-note">
            <strong>{latest.passed ? 'Passed' : 'Failed'}</strong> · <code>{latest.command}</code> · {latest.source === 'agent' ? 'run by an agent' : 'run here'} · {relativeTime(latest.startedAt)}
            {latest.testsPassed !== null ? ` · ${latest.testsPassed} passed${latest.testsFailed ? `, ${latest.testsFailed} failed` : ''}` : ''}
            {latest.taskOutcome ? ` · Goal: ${latest.taskOutcome}` : ''}
            {stale ? ' · files have changed since' : ''}
          </p>
        ) : <p className="settings-note">No check has been recorded for this project yet.</p>}
        <div className="field-grid">
          <label className="field"><span>Check command</span><UiTextInput value={command} placeholder="npm test" onChange={(event) => setCommand(event.target.value)} /></label>
        </div>
        <div className="ops-actions">
          <UiButton type="button" className="primary-button" disabled={running || !command.trim()} onClick={() => void run()}><Play size={14} /><span>{running ? 'Running…' : stale ? 'Re-run checks' : 'Run checks'}</span></UiButton>
          <UiButton type="button" className="secondary-button" onClick={() => void refresh()}><RefreshCw size={14} /><span>Refresh</span></UiButton>
        </div>
        {latest && !latest.passed && latest.outputTail && <pre className="verify-output">{latest.outputTail}</pre>}
      </section>

      <section className="settings-section">
        <div className="section-title"><span>Changed files</span></div>
        {overview.files.length === 0 ? <div className="empty-list">No changed files</div> : (
          <table className="ops-table">
            <thead><tr><th>File</th><th>Status</th></tr></thead>
            <tbody>{overview.files.map((file) => <tr key={file.path}><td className="truncate" title={file.path}>{file.path}</td><td><VerificationBadge status={file.status} /></td></tr>)}</tbody>
          </table>
        )}
      </section>

      <section className="settings-section">
        <div className="section-title"><span>History</span></div>
        {overview.history.length === 0 ? <div className="empty-list">No checks yet</div> : (
          <table className="ops-table">
            <thead><tr><th>Result</th><th>Command</th><th>Tests</th><th>When</th></tr></thead>
            <tbody>{overview.history.slice(0, 15).map((item) => (
              <tr key={item.id}>
                <td>{item.passed ? 'Passed' : 'Failed'}</td>
                <td className="truncate" title={[item.command, item.taskOutcome ? `Goal: ${item.taskOutcome}` : ''].filter(Boolean).join('\n')}>
                  <div>{item.command}</div>
                  {item.taskOutcome && <small className="settings-note">Goal: {item.taskOutcome}</small>}
                </td>
                <td>{item.testsPassed === null ? '—' : `${item.testsPassed}${item.testsFailed ? ` / ${item.testsFailed} failed` : ''}`}</td>
                <td>{relativeTime(item.startedAt)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
    </div>
  );
}
