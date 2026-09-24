import { ArrowRight, Brain, Check, Circle, FolderOpen, RefreshCw, Route, Settings2, X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { SetupCheck, SetupStatus } from '@kai/contracts';

export function SetupPanel({
  status,
  busy,
  onAction,
  onComplete,
  onDismiss,
}: {
  status: SetupStatus;
  busy: boolean;
  onAction: (action: NonNullable<SetupCheck['action']>) => void;
  onComplete: () => void;
  onDismiss: () => void;
}): ReactNode {
  const blocked = status.checks.some((check) => check.status === 'blocked');
  const ready = status.checks.filter((check) => check.status === 'ready').length;
  return (
    <div className="setup-overlay">
      <section className="setup-panel" role="dialog" aria-modal="true" aria-labelledby="setup-title">
        <header className="setup-head">
          <div>
            <span className="eyebrow">First-run setup</span>
            <h2 id="setup-title">Make KAI ready</h2>
            <p>{ready} of {status.checks.length} core checks ready. Optional services can be started here or later in Settings.</p>
          </div>
          <button type="button" className="icon-button compact" aria-label="Set up later" onClick={onDismiss}>
            <X size={15} />
          </button>
        </header>
        <div className="setup-checks">
          {status.checks.map((check) => (
            <article className={`setup-check ${check.status}`} key={check.id}>
              <span className="setup-check-state" aria-hidden="true">
                {check.status === 'ready' ? <Check size={14} /> : check.status === 'blocked' ? <Circle size={10} fill="currentColor" /> : <RefreshCw size={13} />}
              </span>
              <div className="setup-check-copy">
                <strong>{check.label}</strong>
                <span>{check.detail}</span>
              </div>
              {check.action && (
                <button type="button" className="secondary-button" disabled={busy} onClick={() => onAction(check.action!)}>
                  {setupActionIcon(check.action)}
                  <span>{setupActionLabel(check.action, check.id)}</span>
                </button>
              )}
              {check.status === 'ready' && <span className="setup-ready-label">Ready</span>}
            </article>
          ))}
        </div>
        <footer className="setup-footer">
          <button type="button" className="secondary-button" disabled={busy} onClick={onDismiss}>Set up later</button>
          <button type="button" className="primary-button" disabled={busy || blocked} onClick={onComplete}>
            <Check size={15} />
            <span>{blocked ? 'Finish required checks first' : 'Finish setup'}</span>
          </button>
        </footer>
      </section>
    </div>
  );
}

function setupActionIcon(action: NonNullable<SetupCheck['action']>): ReactNode {
  if (action === 'open_project') return <FolderOpen size={14} />;
  if (action === 'open_settings') return <Settings2 size={14} />;
  if (action === 'start_cognitive1') return <Brain size={14} />;
  if (action === 'start_proxy') return <Route size={14} />;
  return <ArrowRight size={14} />;
}

function setupActionLabel(action: NonNullable<SetupCheck['action']>, checkId: SetupCheck['id']): string {
  if (action === 'open_project') return 'Open project';
  if (action === 'open_settings') return checkId === 'cli' ? 'Set up an agent' : 'Configure API';
  if (action === 'start_cognitive1') return 'Start Brain';
  if (action === 'start_proxy') return 'Start Proxy';
  return 'Open';
}
