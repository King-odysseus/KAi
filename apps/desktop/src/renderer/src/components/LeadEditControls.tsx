import { useState } from 'react';
import { FilePenLine } from 'lucide-react';
import type { LeadAccess, LeadEditProposal } from '@kai/contracts';
import { OptionMenu } from './ui/OptionMenu';
import { UiButton } from './UiButton';
import { lineContentDiff } from './lead-idea-files';

export const leadAccessLabel = (mode: LeadAccess) => ({ 'read-only': 'Read-only', ask: 'Edits: ask', plan: 'Plan edits' })[mode];
export function LeadAccessControl({ access, disabled, onChange }: { access: LeadAccess; disabled: boolean; onChange?: (mode: LeadAccess) => Promise<void> }) {
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  const help = 'Lead access: Read-only prevents writes. Ask before edits needs approval. Plan edits may complete verified steps automatically; code, decisions, scope and baselines still need approval. Builder access is separate.';
  return <div className="lead-handoff-control" title={help}>
    <OptionMenu ariaLabel="Lead access" title={help} icon={<FilePenLine size={13} />} value={access} disabled={disabled || saving || !onChange} options={[
      { value: 'read-only', label: 'Read-only', description: 'Discuss and prepare Builder tasks; no Lead edits.' },
      { value: 'ask', label: 'Ask before edits', description: 'Preview one small correction and approve its exact diff.' },
      { value: 'plan', label: 'Plan edits allowed', description: 'Mark existing plan steps complete from Passed task evidence. Other edits need approval.' },
    ]} onChange={(value) => { if (!onChange) return; setSaving(true); setError(''); void onChange(value).catch((caught) => setError(String(caught.message))).finally(() => setSaving(false)); }} />
    {error && <p role="alert">{error}</p>}
  </div>;
}
export function LeadEditCard({ proposal, disabled, onDecide }: { proposal: LeadEditProposal; disabled: boolean; onDecide?: (id: string, action: 'approve' | 'reject' | 'refresh') => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const act = (action: 'approve' | 'reject' | 'refresh') => { if (!onDecide) return; setBusy(true); setError(''); void onDecide(proposal.id, action).catch((caught) => setError(String(caught.message))).finally(() => setBusy(false)); };
  return <section className="lead-builder-task lead-edit-card" aria-label="Lead edit proposal">
    <strong>Lead edit · {proposal.path}</strong><p>{proposal.reason}</p>
    <span role="status">{({ pending: 'Awaiting approval', conflict: 'File changed — review again', applied: proposal.automatic ? 'Plan updated from evidence' : 'Applied with approval', rejected: 'Declined' })[proposal.state]}</span>
    <details open={proposal.state === 'pending'}><summary>Exact proposed difference</summary><pre>{lineContentDiff(proposal.original, proposal.replacement)}</pre></details>
    {proposal.conflictContent !== undefined && <details open><summary>Your file changed since this preview</summary><pre>{lineContentDiff(proposal.original, proposal.conflictContent)}</pre></details>}
    {proposal.note && <p>{proposal.note}</p>}{error && <p role="alert">{error}</p>}
    {(proposal.state === 'pending' || proposal.state === 'conflict') && <div className="lead-idea-actions lead-task-actions">
      {proposal.state === 'pending' ? <UiButton className="primary-button" disabled={disabled || busy || !onDecide} onClick={() => act('approve')}>Approve exact edit</UiButton> : <UiButton className="secondary-button" disabled={disabled || busy || !onDecide} onClick={() => act('refresh')}>Refresh preview</UiButton>}
      <UiButton className="secondary-button" disabled={busy || !onDecide} onClick={() => act('reject')}>Decline edit</UiButton>
    </div>}
    <small>Only this preview is applied. No command runs, no Builder draft is replaced, and phase gates remain unchanged.</small>
  </section>;
}
