import { Download, RefreshCw, RotateCw } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { AppSettings, UpdateState } from '@kai/contracts';
import { relativeTime, unwrap } from '../types';
import { confirmDialog } from './AppDialog';

function useUpdateState(): [UpdateState | null, (state: UpdateState) => void] {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.kaiDesktop.updateState().then((response) => {
      if (!cancelled && response.ok) setState(response.data);
    });
    const off = window.kaiDesktop.onUpdateState(setState);
    return () => {
      cancelled = true;
      off();
    };
  }, []);
  return [state, setState];
}

/** Shown across the app only when a new version is found or ready. */
export function UpdateBanner({ onOpen }: { onOpen: () => void }): ReactNode {
  const [state] = useUpdateState();
  if (!state || (state.status !== 'available' && state.status !== 'ready')) return null;
  return (
    <div className="workbench-notice update-banner" role="status">
      <span>{state.status === 'ready' ? `KAI ${state.version ?? ''} is downloaded and ready to install.` : `KAI ${state.version ?? 'update'} is available.`}</span>
      <button type="button" className="secondary-button" onClick={onOpen}>View update</button>
    </div>
  );
}

export function UpdatesPanel({ settings }: { settings: AppSettings }): ReactNode {
  const [state, setState] = useUpdateState();
  const [autoCheck, setAutoCheck] = useState(settings.updates.autoCheck);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setAutoCheck(settings.updates.autoCheck), [settings.updates.autoCheck]);

  async function step(action: () => Promise<UpdateState>): Promise<void> {
    setError(null);
    try {
      setState(await action());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That step failed.');
    }
  }

  if (!state) return null;
  const busy = state.status === 'checking' || state.status === 'downloading';
  return (
    <section className="settings-section span-two">
      <div className="section-title"><RotateCw size={17} /><span>Updates</span></div>
      <p className="settings-note">
        KAI {state.currentVersion}
        {state.checkedAt ? ` · checked ${relativeTime(state.checkedAt)}` : ''}
        {state.status === 'disabled' ? ` · ${state.message}` : ''}
        {state.status === 'none' ? ` · ${state.message}` : ''}
      </p>
      {state.status === 'available' && <p className="settings-note"><strong>Version {state.version} is available.</strong></p>}
      {state.status === 'downloading' && <div className="usage-bar" role="progressbar" aria-valuenow={state.percent ?? 0} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${state.percent ?? 0}%` }} /></div>}
      {state.status === 'ready' && <p className="settings-note"><strong>Version {state.version} is downloaded.</strong> Installing backs up your settings first, then restarts KAI. Running work is stopped.</p>}
      {state.status === 'error' && <div className="workbench-error" role="alert">{state.message}</div>}
      {error && <div className="workbench-error" role="alert">{error}</div>}
      {state.notes && (state.status === 'available' || state.status === 'ready') && <pre className="verify-output">{state.notes}</pre>}
      {state.backupName && <p className="settings-note">Settings backup saved as "{state.backupName}". Restore it from Configuration backups below if anything looks wrong after the update.</p>}
      <div className="ops-actions">
        <button type="button" className="secondary-button" disabled={state.status === 'disabled' || busy || state.status === 'ready'} onClick={() => void step(async () => unwrap(await window.kaiDesktop.checkForUpdates()))}><RefreshCw size={14} /><span>{state.status === 'checking' ? 'Checking…' : 'Check for updates'}</span></button>
        {state.status === 'available' && <button type="button" className="primary-button" onClick={() => void step(async () => unwrap(await window.kaiDesktop.downloadUpdate()))}><Download size={14} /><span>Download</span></button>}
        {state.status === 'ready' && <button type="button" className="primary-button" onClick={() => void confirmDialog({
          title: 'Install the update now?',
          detail: 'KAI backs up your settings, stops running work and restarts.',
          confirmLabel: 'Install and restart',
        }).then((confirmed) => {
          if (confirmed) void step(async () => unwrap(await window.kaiDesktop.installUpdate()));
        })}><RotateCw size={14} /><span>Install and restart</span></button>}
      </div>
      <label className="toggle-row"><span><strong>Check automatically</strong><small>Once after startup and every few hours. Nothing is downloaded or installed without you.</small></span><input type="checkbox" checked={autoCheck} onChange={(event) => {
        setAutoCheck(event.target.checked);
        void window.kaiDesktop.updateSettings({ updates: { autoCheck: event.target.checked } });
      }} /></label>
    </section>
  );
}
