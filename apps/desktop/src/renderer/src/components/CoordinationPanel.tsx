import { AlertTriangle, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { CoordinationOverview, UrgentNote } from '@kai/contracts';
import { unwrap } from '../types';
import { confirmDialog } from './AppDialog';

const REFRESH_MS = 15_000;

function useCoordination(intervalMs: number) {
  const [overview, setOverview] = useState<CoordinationOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setOverview(unwrap(await window.kaiDesktop.coordinationOverview()));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Coordination data could not be loaded.');
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), intervalMs);
    return () => window.clearInterval(timer);
  }, [refresh, intervalMs]);
  return { overview, error, refresh };
}

async function clearUrgent(project: string): Promise<void> {
  unwrap(await window.kaiDesktop.cognitive1Operation({ operation: 'urgent-clear', payload: { project } }));
}

/** Shown across the whole app while any urgent warning is set in Cognitive1. */
export function UrgentBanner(): ReactNode {
  const { overview, refresh } = useCoordination(30_000);
  if (!overview || overview.urgent.length === 0) return null;
  const [first, ...rest] = overview.urgent;
  return (
    <div className="urgent-banner" role="alert">
      <AlertTriangle size={15} />
      <span className="urgent-banner-text">
        <strong>Urgent{first!.project !== 'global' ? ` (${first!.project})` : ''}:</strong> {first!.what}
        {first!.do ? ` Do: ${first!.do}.` : ''}{first!.doNot ? ` Do not: ${first!.doNot}.` : ''}
        {rest.length > 0 ? ` +${rest.length} more` : ''}
      </span>
      <button type="button" className="secondary-button" onClick={() => void clearUrgent(first!.project).then(refresh)}>Clear</button>
    </div>
  );
}

export function CoordinationPanel(): ReactNode {
  const { overview, error, refresh } = useCoordination(REFRESH_MS);
  const [form, setForm] = useState({ project: 'global', what: '', do: '', do_not: '', until: '' });
  const [message, setMessage] = useState<string | null>(null);

  async function run(action: () => Promise<void>, done: string): Promise<void> {
    try {
      await action();
      setMessage(done);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'That action failed.');
    }
    await refresh();
  }

  if (error) return <div className="workbench-error" role="alert">{error}</div>;
  if (!overview) return <div className="empty-list">Loading…</div>;
  if (!overview.available) return <div className="empty-list">Cognitive1 is not running. Start it from the C1 Brain page to see active work and urgent warnings.</div>;

  return (
    <div className="ops-panel">
      {message && <div className="workbench-notice" role="status"><span>{message}</span></div>}

      <section className="settings-section">
        <div className="section-title"><span>Active work</span></div>
        <p className="settings-note">Agents claim a project while they work, so others can avoid the same files. KAI claims and releases automatically around each CLI run.</p>
        {overview.claims.length === 0 ? <div className="empty-list">No active work right now</div> : (
          <table className="ops-table">
            <thead><tr><th>Agent</th><th>Project</th><th>Doing</th><th>Files</th><th /></tr></thead>
            <tbody>
              {overview.claims.map((claim) => (
                <tr key={`${claim.agent}-${claim.project}-${claim.time}`}>
                  <td>{claim.agent}</td>
                  <td>{claim.project}</td>
                  <td title={claim.what}>{claim.what}</td>
                  <td title={claim.files.join(', ')}>{claim.files.join(', ') || '—'}</td>
                  <td>
                    <button type="button" className="icon-button compact" aria-label={`Release ${claim.agent}'s claim`} title="Release this claim" onClick={() => {
                      void confirmDialog({
                        title: 'Release this claim?',
                        detail: `Release ${claim.agent}'s claim on ${claim.project}? They may still be working.`,
                        confirmLabel: 'Release claim',
                        destructive: true,
                      }).then((confirmed) => {
                        if (confirmed) {
                        void run(async () => { unwrap(await window.kaiDesktop.cognitive1Operation({ operation: 'active-release', payload: { agent: claim.agent } })); }, `Released ${claim.agent}'s claim.`);
                        }
                      });
                    }}><Trash2 size={13} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="settings-section">
        <div className="section-title"><span>Urgent warnings</span></div>
        {overview.urgent.length === 0 ? <div className="empty-list">No urgent warnings</div> : overview.urgent.map((note: UrgentNote, index) => (
          <div key={`${note.project}-${index}`} className="ops-card-head">
            <span><strong>{note.project}</strong> — {note.what}{note.do ? ` · Do: ${note.do}` : ''}{note.doNot ? ` · Do not: ${note.doNot}` : ''}{note.until ? ` · Until: ${note.until}` : ''}</span>
            <button type="button" className="secondary-button" onClick={() => void run(() => clearUrgent(note.project), `Cleared the warning for ${note.project}.`)}>Clear</button>
          </div>
        ))}
        <div className="field-grid">
          <label className="field"><span>Project (or global)</span><input value={form.project} onChange={(event) => setForm({ ...form, project: event.target.value })} /></label>
          <label className="field"><span>What is wrong</span><input value={form.what} onChange={(event) => setForm({ ...form, what: event.target.value })} /></label>
          <label className="field"><span>Agents must</span><input value={form.do} onChange={(event) => setForm({ ...form, do: event.target.value })} /></label>
          <label className="field"><span>Agents must not</span><input value={form.do_not} onChange={(event) => setForm({ ...form, do_not: event.target.value })} /></label>
          <label className="field"><span>Until</span><input value={form.until} placeholder="manually cleared" onChange={(event) => setForm({ ...form, until: event.target.value })} /></label>
        </div>
        <button type="button" className="primary-button align-end" disabled={!form.what.trim() || !form.project.trim()} onClick={() => void run(async () => {
          unwrap(await window.kaiDesktop.cognitive1Operation({ operation: 'urgent-set', payload: { ...form, until: form.until || 'manually cleared' } }));
          setForm({ ...form, what: '', do: '', do_not: '', until: '' });
        }, 'Urgent warning set. Every agent will see it.')}>Set urgent warning</button>
      </section>
    </div>
  );
}
