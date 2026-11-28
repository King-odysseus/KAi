import { useState, type ReactNode } from 'react';
import type { LeadHandoffMode } from './lead-handoff';
import { SendHorizontal } from 'lucide-react';
import { Markdown } from './Markdown';
import { UiButton } from './UiButton';

export function LeadTaskCard({ task, builderEnabled, onSend, onChange, mode = 'discuss', canStart = true, sent = false, onStart }: { task: string; builderEnabled: boolean; onSend: (task: string) => void; onChange: (message: string) => void; mode?: LeadHandoffMode; canStart?: boolean; sent?: boolean; onStart?: () => Promise<void> }): ReactNode {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  return <section className="lead-builder-task" aria-label="Builder task proposal">
    <strong>Builder task</strong><Markdown text={task} />
    {error && <p role="alert">{error}</p>}
    <div className="lead-idea-actions lead-task-actions">
      <UiButton type="button" className="secondary-button" onClick={() => onChange(`Please revise this Builder task.\n\n${task}\n\nWhat I want changed: `)}>Change task</UiButton>
      <UiButton type="button" className="secondary-button" onClick={() => { void navigator.clipboard.writeText(task).catch(() => onChange('Could not copy instructions. Please select and copy the task text above.')); }}>Copy instructions</UiButton>
      <UiButton type="button" className="secondary-button lead-send-builder" disabled={!builderEnabled} title="Fill the Builder draft; you choose when to send it" onClick={() => onSend(task)}><SendHorizontal size={13} />{builderEnabled ? 'Send task to Builder' : 'Builder is off'}</UiButton>
      {mode !== 'discuss' && <UiButton type="button" className="primary-button" disabled={!builderEnabled || !canStart || !onStart || starting || sent} onClick={() => {
        if (!onStart) return;
        setStarting(true); setError('');
        void onStart().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught))).finally(() => setStarting(false));
      }}>{sent ? 'Sent to Builder' : starting ? 'Starting Builder…' : 'Approve and start Builder'}</UiButton>}
    </div>
    <small>Sending fills the Builder draft. It does not start work.</small>
    {mode !== 'discuss' && <small>Approve and start runs exactly this task in Builder, using Builder’s existing access settings.{!canStart && !sent ? ' A complete task and a finished Lead reply are required.' : ''}</small>}
  </section>;
}
