import { useEffect, useState, type ReactNode } from 'react';
import type { ProjectRecord, RecoveryResume } from '@kai/contracts';
import { CoordinationPanel } from './CoordinationPanel';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { RecoveryPanel } from './RecoveryPanel';
import { VerificationPanel } from './VerificationPanel';
import { UiButton } from './UiButton';
import { PageHeader } from './ui/PageHeader';

export type OperationsTab = 'recovery' | 'coordination' | 'verification' | 'diagnostics';

const TABS: Array<{ id: OperationsTab; label: string }> = [
  { id: 'recovery', label: 'Recovery' },
  { id: 'coordination', label: 'Active work' },
  { id: 'verification', label: 'Checks' },
  { id: 'diagnostics', label: 'Diagnostics' },
];

export function OperationsView({ initialTab, activeProject, onResume, onRecoveryChanged, onStopEverything }: {
  initialTab?: OperationsTab;
  activeProject: ProjectRecord | null;
  onResume: (resume: RecoveryResume) => Promise<void>;
  onRecoveryChanged: () => void;
  /** Ends every run and clears what a run that never returned left behind. Never disabled, by design. */
  onStopEverything: () => void;
}): ReactNode {
  const [tab, setTab] = useState<OperationsTab>(initialTab ?? 'recovery');
  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);
  return (
    <div className="page-view ops-view">
      <PageHeader title="Operations" detail="Recovery, coordination and health for the work KAI is running" actions={<>{/* In the header rather than on a tab, so the way out of a stuck run is reachable from every section. It is
            deliberately never disabled: whatever is wrong, this is the control that should still work. */}
        <div className="page-actions">
          <UiButton type="button" className="secondary-button" onClick={onStopEverything} title="End every run and clear what an interrupted run left behind">Stop everything</UiButton>
        </div></>} />
      <div className="ops-tabs" role="tablist" aria-label="Operations sections">
        {TABS.map((item) => (
          <UiButton
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`ops-tab ${tab === item.id ? 'active' : ''}`}
            onClick={() => {
              setTab(item.id);
              document.getElementById(`ops-${item.id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
            }}
          >{item.label}</UiButton>
        ))}
      </div>
      {/* Every section is on the page at once, in two columns, and the tabs jump to them. Recovery and who is working
          sit together on the left; the checks and the services' health on the right. */}
      <div className="ops-board">
        <div className="ops-column">
          <section id="ops-recovery" className={tab === 'recovery' ? 'ops-section current' : 'ops-section'}><RecoveryPanel onResume={onResume} onChanged={onRecoveryChanged} /></section>
          <section id="ops-coordination" className={tab === 'coordination' ? 'ops-section current' : 'ops-section'}><CoordinationPanel /></section>
        </div>
        <div className="ops-column">
          <section id="ops-verification" className={tab === 'verification' ? 'ops-section current' : 'ops-section'}><VerificationPanel activeProject={activeProject} /></section>
          <section id="ops-diagnostics" className={tab === 'diagnostics' ? 'ops-section current' : 'ops-section'}><DiagnosticsPanel activeProject={activeProject} /></section>
        </div>
      </div>
    </div>
  );
}
