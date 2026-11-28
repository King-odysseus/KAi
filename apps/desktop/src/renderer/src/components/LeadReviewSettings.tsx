import type { ConversationRecord, LeadDeliverySettings } from '@kai/contracts';
import { LeadModelControls, useLeadModelSelection } from './LeadModelControls';
import type { LeadModelInventory } from './lead-model-selection';
import { deliverySettings } from './lead-completion';
import { Toggle } from './ui/Toggle';
import { useState } from 'react';

export function LeadReviewSettings({ conversation, inventory, disabled, onSave }: { conversation: ConversationRecord; inventory: LeadModelInventory; disabled: boolean; onSave?: (settings: LeadDeliverySettings) => Promise<void> }) {
  const settings = deliverySettings(conversation);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const save = (patch: Partial<LeadDeliverySettings>): void => {
    if (!onSave) return;
    setError(''); setSaving(true);
    void onSave({ ...settings, ...patch }).catch((caught) => setError(String(caught.message))).finally(() => setSaving(false));
  };
  const picker = useLeadModelSelection({ projectId: conversation.id, inventory, savedCoach: settings.reviewer, storagePrefix: 'kai.lead.reviewer', onTargetChange: (reviewer) => save({ reviewer, autoReview: false }) });
  return <details className="lead-review-settings"><summary>Review and continuation settings</summary>
    <p>Lead keeps its own model. Choose a separate read-only reviewer; its replies appear in this chat.</p>
    <div className="lead-model-row"><LeadModelControls picker={picker} label="Reviewer" disabled={disabled || saving || !onSave} /></div>
    <small>{picker.unavailableReason || (picker.selection.target ? 'Reviewer: ' + (picker.modelTierLabel ?? 'Subscription') : 'Choose a reviewer to enable independent review.')}</small>
    <Toggle checked={settings.autoReview} disabled={disabled || saving || !onSave || !settings.reviewer || Boolean(picker.unavailableReason)} ariaLabel="Automatically review Builder results" label="Automatically review Builder results" onChange={(autoReview) => save({ autoReview })} />
    <small>Enabling this authorizes requests to that reviewer, including paid API calls. Changing reviewer turns automatic review off until you enable it again.</small>
    <div className="lead-continuation-limits">
      <label>Tasks per automatic cycle<input aria-label="Automatic task limit" type="number" min={1} max={5} defaultValue={settings.maxTasks} disabled={disabled || saving || !onSave} onBlur={(event) => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1 && value <= 5) save({ maxTasks: value }); else event.target.value = String(settings.maxTasks); }} /></label>
      <label>Repair attempts<input aria-label="Automatic repair limit" type="number" min={0} max={2} defaultValue={settings.maxRepairs} disabled={disabled || saving || !onSave} onBlur={(event) => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 0 && value <= 2) save({ maxRepairs: value }); else event.target.value = String(settings.maxRepairs); }} /></label>
      <label>Cycle budget (USD)<input aria-label="Automatic cycle budget" type="number" min={0.01} max={100} step={0.1} defaultValue={settings.maxUsd} disabled={disabled || saving || !onSave} onBlur={(event) => { const value = Number(event.target.value); if (value > 0 && value <= 100) save({ maxUsd: value }); else event.target.value = String(settings.maxUsd); }} /></label>
    </div>
    <small>Limits apply to new cycles; existing usage limits still apply. Unknown paid usage pauses continuation. No automatic phase sign-off.</small>
    {error && <p role="alert">{error}</p>}
  </details>;
}
