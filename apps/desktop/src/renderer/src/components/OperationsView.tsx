import { useState, type ReactNode } from 'react';
import type { ProjectRecord, RecoveryResume } from '@kai/contracts';
import { CoordinationPanel } from './CoordinationPanel';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { RecoveryPanel } from './RecoveryPanel';
import { VerificationPanel } from './VerificationPanel';

export type OperationsTab = 'recovery' | 'coordination' | 'verification' | 'diagnostics';

const TABS: Array<{ id: OperationsTab; label: string }> = [
  { id: 'recovery', label: 'Recovery' },
  { id: 'coordination', label: 'Active work' },
  { id: 'verification', label: 'Checks' },
  { id: 'diagnostics', label: 'Diagnostics' },
];

export function OperationsView({ initialTab, activeProject, onResume, onRecoveryChanged }: {
  initialTab?: OperationsTab;
  activeProject: ProjectRecord | null;
  onResume: (resume: RecoveryResume) => Promise<void>;
  onRecoveryChanged: () => void;
}): ReactNode {
  const [tab, setTab] = useState<OperationsTab>(initialTab ?? 'recovery');
  return (
    <div className="page-view ops-view">
      <header className="page-header">
        <div>
          <h1>Operations</h1>
          <p>Recovery, coordination and health for the work KAI is running</p>
        </div>
      </header>
      <div className="ops-tabs" role="tablist" aria-label="Operations sections">
        {TABS.map((item) => (
          <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={`ops-tab ${tab === item.id ? 'active' : ''}`} onClick={() => setTab(item.id)}>{item.label}</button>
        ))}
      </div>
      {tab === 'recovery' && <RecoveryPanel onResume={onResume} onChanged={onRecoveryChanged} />}
      {tab === 'coordination' && <CoordinationPanel />}
      {tab === 'verification' && <VerificationPanel activeProject={activeProject} />}
      {tab === 'diagnostics' && <DiagnosticsPanel activeProject={activeProject} />}
    </div>
  );
}
