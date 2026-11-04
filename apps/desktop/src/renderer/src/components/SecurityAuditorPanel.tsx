import { AlertOctagon, Bug, CheckCircle2, RefreshCw, RotateCcw, Save, ShieldAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import {
  SECURITY_SCAN_RECIPES,
  securityAuditPrompt,
  type SecurityFinding,
  type SecurityFindingSeverity,
  type SecurityScanProfile,
  type SecurityScanResult,
} from '@kai/contracts';
import { unwrap } from '../types';
import { UiButton } from './UiButton';
import { UiTextInput } from './UiTextInput';

export interface SecurityScanRequest {
  profile: SecurityScanProfile;
  target: string;
  findingId?: string;
}

interface SecurityAuditorPanelProps {
  findings: SecurityFinding[];
  busy: boolean;
  loadError: string | null;
  /** The file open in the editor right now, if any — offered as the default scan target. */
  currentFile: string | null;
  /** The last finished pass, so its report can be read without leaving the panel. */
  lastReport: SecurityScanResult | null;
  onReference: (filePath: string) => void;
  onRefresh: () => void;
  /** Runs one recipe as a real agent task, local only. */
  onRunScan: (request: SecurityScanRequest) => void;
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
  lastReport,
  onReference,
  onRefresh,
  onRunScan,
  onMarkFixed,
}: SecurityAuditorPanelProps): ReactNode {
  const [target, setTarget] = useState('');
  const [profile, setProfile] = useState<SecurityScanProfile>('full');
  const [savedSlot, setSavedSlot] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const open = findings.filter((finding) => finding.status === 'open' || finding.status === 'assigned');
  const resolved = findings.filter((finding) => finding.status === 'fixed' || finding.status === 'wont-fix');
  const sorted = [...open].sort((a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity));
  const selected = SECURITY_SCAN_RECIPES.find((recipe) => recipe.id === profile) ?? SECURITY_SCAN_RECIPES[0]!;

  /**
   * Saves a recipe into the first empty numbered slot, so it is reachable with `#` in the composer exactly like a
   * prompt the person wrote themselves. The panel's recipes are always here; the slot is for carrying one over.
   */
  async function saveToSlot(): Promise<void> {
    setSaveError(null);
    setSavedSlot(null);
    try {
      const preset = securityAuditPrompt({ profile: selected.id, target: target.trim() });
      const existing = unwrap(await window.kaiDesktop.listPromptPresets());
      const slot = Array.from({ length: 9 }, (_, index) => index + 1).find((candidate) => !existing.some((entry) => entry.slot === candidate));
      if (!slot) {
        setSaveError('All nine saved-prompt slots are full. Delete one in the composer\'s # menu first.');
        return;
      }
      unwrap(await window.kaiDesktop.savePromptPreset(slot, selected.label.slice(0, 60), preset));
      setSavedSlot(slot);
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : 'The prompt could not be saved.');
    }
  }

  return (
    <section className="learning-security-auditor">
      <div className="learning-security-intro">
        <ShieldAlert size={16} />
        <div>
          <strong>Security Auditor</strong>
          <p>
            Runs a real agent task against your own code and a local dev server: injection, broken auth, secrets,
            paths, dependency advisories. Local only — it never touches a deployed or public URL. The task opens in the
            chat so you can watch what it does, and findings land back here when it finishes.
          </p>
        </div>
      </div>

      <div className="learning-security-recipes" role="group" aria-label="Audit recipe">
        {SECURITY_SCAN_RECIPES.map((recipe) => (
          <UiButton
            key={recipe.id}
            type="button"
            variant={recipe.id === profile ? 'primary' : 'secondary'}
            className="learning-security-recipe"
            title={recipe.description}
            disabled={busy}
            onClick={() => setProfile(recipe.id)}
          >
            {recipe.label}
          </UiButton>
        ))}
      </div>
      <p className="learning-security-recipe-help">{selected.description}</p>

      <div className="learning-security-scan">
        <label className="input-with-icon">
          <Bug size={13} />
          <UiTextInput
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            placeholder={currentFile ? `Scan ${currentFile} (leave blank for this recipe's default)` : selected.targetHint}
            aria-label="Scan target"
          />
        </label>
        <div className="learning-security-actions">
          <UiButton
            type="button"
            variant="primary"
            disabled={busy}
            onClick={() => onRunScan({ profile: selected.id, target: target.trim() })}
          >
            {busy ? 'Scanning…' : `Run ${selected.label.toLowerCase()} audit`}
          </UiButton>
          <UiButton type="button" variant="secondary" disabled={busy} onClick={() => void saveToSlot()}>
            <Save size={13} /> Save prompt to a slot
          </UiButton>
        </div>
        {currentFile && !target.trim() && <small>Defaults to the open file: {currentFile}</small>}
        {savedSlot !== null && <small className="learning-security-saved"><CheckCircle2 size={12} /> Saved to slot {savedSlot} — open it with # in the composer.</small>}
        {saveError && <small className="learning-security-save-error" role="alert">{saveError}</small>}
        {busy && (
          <div className="learning-security-running" role="status">
            Running the audit as an agent task. Follow it in the <strong>chat</strong>; findings land back here when it
            finishes.
          </div>
        )}
      </div>

      <div className="learning-security-header">
        <strong>Findings</strong>
        <UiButton type="button" className="secondary-button" onClick={onRefresh} disabled={busy} title="Reload findings">
          <RefreshCw size={13} />
        </UiButton>
      </div>

      {loadError && <div className="learning-error" role="alert">{loadError}</div>}
      {!loadError && sorted.length === 0 && <p>No open findings. Run a recipe on a feature you just built to check it.</p>}

      {sorted.map((finding) => (
        <article key={finding.id} className={`learning-security-finding severity-${finding.severity}`}>
          <header>
            <span className="learning-security-severity"><AlertOctagon size={13} />{severityLabel[finding.severity]}</span>
            <span className="learning-security-vuln-class">{finding.vulnClass}</span>
          </header>
          <strong>{finding.title}</strong>
          {isFilePath(finding.location) ? (
            <UiButton type="button" className="secondary-button" onClick={() => onReference(locationFile(finding.location))}>
              {finding.location}
            </UiButton>
          ) : (
            <small className="learning-security-location">{finding.location}</small>
          )}
          <details className="learning-security-evidence">
            <summary>Evidence — how to reproduce it</summary>
            <p>{finding.evidence}</p>
          </details>
          <p>{finding.conceptCard}</p>
          <footer>
            <small>
              {finding.lastSeenAt ? `Last seen ${relativeTime(finding.lastSeenAt)}` : 'Not seen by a scan yet'}
              {finding.lastVerifiedAt ? ` · re-tested ${relativeTime(finding.lastVerifiedAt)}` : ''}
            </small>
            <span className="learning-security-finding-actions">
              <UiButton
                type="button"
                variant="secondary"
                disabled={busy}
                title="Re-run the original reproduction and update this finding"
                onClick={() => onRunScan({ profile: 'verify', target: locationFile(finding.location), findingId: finding.id })}
              >
                <RotateCcw size={13} /> Re-test
              </UiButton>
              <UiButton type="button" className="secondary-button" onClick={() => onMarkFixed(finding.id)}>Mark fixed</UiButton>
            </span>
          </footer>
          <small>{finding.taskId ? `Fixer task filed: ${finding.taskId}` : 'No fixer task filed yet.'}</small>
        </article>
      ))}

      {lastReport && (
        <details className="learning-security-report">
          <summary>
            Last audit — {lastReport.status === 'completed' ? 'finished' : 'failed'}
            {lastReport.findings.length > 0 ? ` · ${lastReport.findings.length} finding${lastReport.findings.length === 1 ? '' : 's'} in the log` : ''}
          </summary>
          {lastReport.error && <p role="alert">{lastReport.error}</p>}
          <pre>{lastReport.output.trim() || 'The run produced no report text.'}</pre>
        </details>
      )}

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

/** A finding's location may carry a line suffix after the file path; the reference only needs the path. */
function locationFile(location: string): string {
  const match = location.match(/^[^:]+?\.\w+(?::\d+)*$/);
  return match ? location.replace(/:\d+(?::\d+)*$/, '') : location;
}

/** A dynamic finding names a route, not a file; offering to open it in the editor would open nothing. */
function isFilePath(location: string): boolean {
  return /^[^:\s]+\.\w+(?::\d+)*$/.test(location.trim());
}

/** Short, human wording for a timestamp; the table is read at a glance rather than parsed. */
function relativeTime(value: string): string {
  const then = Date.parse(value);
  if (!Number.isFinite(then)) return value;
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
