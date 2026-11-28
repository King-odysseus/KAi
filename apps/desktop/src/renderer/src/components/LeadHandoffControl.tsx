import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { OptionMenu } from './ui/OptionMenu';
import type { LeadHandoffMode } from './lead-handoff';

export function LeadHandoffControl({ mode, disabled, onChange }: { mode: LeadHandoffMode; disabled: boolean; onChange?: (mode: LeadHandoffMode) => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const help = 'Builder handoff: Discuss only fills a draft; Ask first requires approval; Auto handoff starts new agreed tasks automatically. Idea approvals stay manual. Builder keeps its own model and access settings.';
  return <div className="lead-handoff-control" title={help}>
    <OptionMenu ariaLabel="Lead handoff mode" title={help} icon={<ShieldCheck size={13} />} value={mode} disabled={disabled || saving || !onChange} options={[
      { value: 'discuss', label: 'Discuss only', description: 'Read and advise. Send tasks to the Builder draft yourself.' },
      { value: 'ask', label: 'Ask first', description: 'Review the exact task, then approve starting Builder.' },
      { value: 'auto', label: 'Auto handoff', description: 'New agreed tasks can start Builder without another confirmation.' },
    ]} onChange={(value) => {
      if (!onChange) return;
      setSaving(true); setError('');
      void onChange(value).catch((caught) => setError(caught instanceof Error ? caught.message : String(caught))).finally(() => setSaving(false));
    }} />
    {error && <p role="alert">{error}</p>}
  </div>;
}
