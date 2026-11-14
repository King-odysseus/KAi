import { Checkbox } from 'flowbite-react';
import { CheckCircle2, ListPlus, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { ImportFinding, ImportReport, ProjectRecord } from '@kai/contracts';
import { unwrap } from '../types';
import { Pill, type PillTone } from './Pill';
import { UiButton } from './UiButton';
import { Card } from './ui/Card';
import { PageHeader } from './ui/PageHeader';

const SEVERITY_TONE: Record<ImportFinding['severity'], PillTone> = { high: 'error', medium: 'warning', low: 'neutral' };
const SEVERITY_WORD: Record<ImportFinding['severity'], string> = { high: 'Fix first', medium: 'Worth fixing', low: 'When you can' };

/**
 * The import wizard: scan an existing project, see what it is and what it lacks, and pick the findings that become the
 * first cards on the Studio board. Scanning reads the folder only; nothing is written until cards are added.
 */
export function ImportView({ activeProject, onOpenStudio }: { activeProject: ProjectRecord | null; onOpenStudio: () => void }): ReactNode {
  const projectId = activeProject?.id ?? null;
  const [report, setReport] = useState<ImportReport | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'scan' | 'add' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<number | null>(null);

  const scan = useCallback(async (): Promise<void> => {
    if (!projectId) return;
    setBusy('scan');
    setError(null);
    setAdded(null);
    try {
      const next = unwrap(await window.kaiDesktop.importScan(projectId));
      setReport(next);
      // The serious and the worthwhile start ticked; the small stuff is the person's call.
      setPicked(new Set(next.findings.filter((finding) => finding.severity !== 'low' && !next.onBoard.includes(finding.id)).map((finding) => finding.id)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The project could not be scanned.');
    } finally {
      setBusy(null);
    }
  }, [projectId]);

  useEffect(() => { setReport(null); setAdded(null); void scan(); }, [scan]);

  async function addCards(): Promise<void> {
    if (!projectId || picked.size === 0) return;
    setBusy('add');
    setError(null);
    try {
      const result = unwrap(await window.kaiDesktop.importAddCards(projectId, [...picked]));
      setAdded(result.added.length);
      setReport(result.report);
      setPicked(new Set());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The cards could not be added.');
    } finally {
      setBusy(null);
    }
  }

  const toggle = (id: string): void => setPicked((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Import project"
        detail={activeProject ? activeProject.name : 'Open a project to scan it'}
        actions={<UiButton type="button" className="secondary-button" disabled={!projectId || busy !== null} onClick={() => void scan()}><RefreshCw size={14} /><span>{busy === 'scan' ? 'Scanning…' : 'Scan again'}</span></UiButton>}
      />
      {error && <div className="workbench-error" role="alert">{error}</div>}
      {!activeProject ? (
        <div className="empty-list">Open a project from the Projects page, then scan it here.</div>
      ) : !report ? (
        <div className="empty-list">{busy === 'scan' ? 'Reading the project…' : 'No scan yet'}</div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
          <Card title="What this project is">
            <div className="flex flex-wrap items-center gap-2">
              {report.stack.length === 0 && <small className="text-[var(--text-dim)]">No known framework detected.</small>}
              {report.stack.map((item) => <Pill key={item} tone="info">{item}</Pill>)}
              {report.languages.map((language) => <Pill key={language.name}>{language.name} · {language.files}</Pill>)}
            </div>
            <small className="text-[var(--text-dim)]">
              {report.fileCount}{report.truncated ? '+' : ''} files · {report.testFileCount} test {report.testFileCount === 1 ? 'file' : 'files'} · {report.gitAvailable ? 'under Git' : 'not under Git'} ·{' '}
              {report.suggestedCheck ? <>check command: <code>{report.suggestedCheck}</code></> : 'no check command'}
            </small>
            {report.truncated && <small className="text-[var(--text-dim)]">Large project: the scan stopped at its file limit, so counts are a lower bound.</small>}
          </Card>

          <Card
            title={`First backlog · ${report.findings.length} ${report.findings.length === 1 ? 'finding' : 'findings'}`}
            actions={<UiButton type="button" className="primary-button" disabled={picked.size === 0 || busy !== null} onClick={() => void addCards()}><ListPlus size={14} /><span>{busy === 'add' ? 'Adding…' : `Add ${picked.size} to board`}</span></UiButton>}
          >
            {added !== null && (
              <div className="workbench-notice" role="status">
                <span>{added === 0 ? 'Those cards were already on the board.' : `Added ${added} ${added === 1 ? 'card' : 'cards'} to the Studio board.`}</span>
                <UiButton type="button" className="secondary-button" onClick={onOpenStudio}>Open Project Studio</UiButton>
              </div>
            )}
            {report.findings.length === 0 && <div className="empty-list"><CheckCircle2 size={14} /> Nothing obvious to fix. This project has tests, a check command, Git and CI.</div>}
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {report.findings.map((finding) => {
                const onBoard = report.onBoard.includes(finding.id);
                return (
                  <li key={finding.id} className="import-finding">
                    <label className="flex cursor-pointer items-start gap-3">
                      <Checkbox className="mt-1" checked={picked.has(finding.id)} disabled={onBoard} onChange={() => toggle(finding.id)} />
                      <span className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <strong>{finding.title}</strong>
                          <Pill tone={SEVERITY_TONE[finding.severity]}>{SEVERITY_WORD[finding.severity]}</Pill>
                          {onBoard && <Pill tone="success">On board</Pill>}
                        </span>
                        <small className="text-[var(--text-dim)]">{finding.detail}</small>
                        {finding.files.length > 0 && <small className="mono text-[var(--text-dim)]">{finding.files.join(', ')}</small>}
                        <small>Card: {finding.card.title}</small>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </Card>
        </div>
      )}
    </div>
  );
}
