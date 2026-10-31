import { AlertOctagon, Bug, RefreshCw, ShieldAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { SecurityFinding, SecurityFindingSeverity } from '@kai/contracts';
import { UiButton } from './UiButton';
import { UiTextInput } from './UiTextInput';

interface SecurityAuditorPanelProps {
  findings: SecurityFinding[];
  busy: boolean;
  loadError: string | null;
  /** The file open in the editor right now, if any — offered as the default scan target. */
  currentFile: string | null;
  onReference: (filePath: string) => void;
  onRefresh: () => void;
  /** Starts the Security Auditor persona against a target, local only. An empty target scans the whole project. */
  onRunScan: (target: string) => void;
  onMarkFixed: (findingId: string) => void;
}

const severityOrder: SecurityFindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];
const severityLabel: Record<SecurityFindingSeverity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

export function SecurityAuditorPanel({
  findings,
  busy,
  loadError,
  currentFile,
  onReference,
  onRefresh,
  onRunScan,
  onMarkFixed,
}: SecurityAuditorPanelProps): ReactNode {
  const [target, setTarget] = useState('');
  const open = findings.filter((finding) => finding.status === 'open' || finding.status === 'assigned');
  const resolved = findings.filter((finding) => finding.status === 'fixed' || finding.status === 'wont-fix');
  const sorted = [...open].sort((a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity));

  return (
    <section className="learning-security-auditor">
      <div className="learning-security-intro">
        <ShieldAlert size={16} />
        <div>
          <strong>Security Auditor</strong>
          <p>
            Tries to break a feature you just built — injection, broken auth, secrets, insecure dependencies — against
            your own code and a local dev server. Local only: it never touches a deployed or public URL.
          </p>
        </div>
      </div>

      <div className="learning-security-scan">
        <label className="input-with-icon">
          <Bug size={13} />
          <UiTextInput
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            placeholder={currentFile ? `Scan ${currentFile} (leave blank for the whole project)` : 'File or feature to scan (leave blank for the whole project)'}
            aria-label="Scan target"
          />
        </label>
        <UiButton
          type="button"
          disabled={busy}
          onClick={() => onRunScan(target.trim() || currentFile || '')}
        >
          {busy ? 'Scanning…' : 'Attack this feature'}
        </UiButton>
        {currentFile && !target.trim() && <small>Defaults to the open file: {currentFile}</small>}
      </div>

      <div className="learning-security-header">
        <strong>Findings</strong>
        <UiButton type="button" className="secondary-button" onClick={onRefresh} disabled={busy} title="Reload findings">
          <RefreshCw size={13} />
        </UiButton>
      </div>

      {loadError && <div className="learning-error" role="alert">{loadError}</div>}
      {!loadError && sorted.length === 0 && <p>No open findings. Run a scan on a feature you just built to check it.</p>}

      {sorted.map((finding) => (
        <article key={finding.id} className={`learning-security-finding severity-${finding.severity}`}>
          <header>
            <span className="learning-security-severity"><AlertOctagon size={13} />{severityLabel[finding.severity]}</span>
            <span className="learning-security-vuln-class">{finding.vulnClass}</span>
          </header>
          <strong>{finding.title}</strong>
          <UiButton type="button" className="secondary-button" onClick={() => onReference(locationFile(finding.location))}>
            {finding.location}
          </UiButton>
          <p>{finding.conceptCard}</p>
          <footer>
            {finding.taskId ? <small>Fixer task filed: {finding.taskId}</small> : <small>No fixer task filed yet.</small>}
            <UiButton type="button" className="secondary-button" onClick={() => onMarkFixed(finding.id)}>Mark fixed</UiButton>
          </footer>
        </article>
      ))}

      {resolved.length > 0 && (
        <details className="learning-security-resolved">
          <summary>{resolved.length} resolved finding{resolved.length === 1 ? '' : 's'}</summary>
          {resolved.map((finding) => (
            <div key={finding.id} className="learning-security-finding resolved">
              <strong>{finding.title}</strong> <small>{finding.status === 'fixed' ? 'Fixed' : "Won't fix"} · {finding.location}</small>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}

/** A finding's location may carry a line/route suffix after the file path; the reference only needs the path. */
function locationFile(location: string): string {
  const match = location.match(/^[^:]+\.[a-zA-Z0-9]+/);
  return match ? match[0] : location;
}
