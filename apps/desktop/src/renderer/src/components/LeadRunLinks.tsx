import { useEffect, useState, type ReactNode } from 'react';
import { Markdown } from './Markdown';
import { leadModelTier } from './lead-model-selection';
import { describeRole } from './guided-build-engine';
import type { ConversationRecord, RoleTarget } from '@kai/contracts';
import { handoffResult, type LeadHandoff } from './lead-delivery';
import { UiButton } from './UiButton';
import { unwrap } from '../types';
import { isLeadPricePause } from './lead-review-pause';
import type { LeadModelInventory } from './lead-model-selection';

export function LeadRunLinks({ leadId, conversations, target, reviewerTarget = null, inventory, running, onOpen, onReview, onRecovery }: { leadId: string; conversations: readonly ConversationRecord[]; target: RoleTarget | null; reviewerTarget?: RoleTarget | null; inventory: LeadModelInventory; running: boolean; onOpen?: (id: string) => void; onReview?: (id: string, handoff: LeadHandoff, target: RoleTarget) => Promise<void>; onRecovery?: (builder: ConversationRecord, handoff: LeadHandoff, target: RoleTarget) => void }): ReactNode {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Record<string, ConversationRecord>>({});
  const relevant = conversations.filter((conversation) => conversation.leadHandoffs?.some((handoff) => handoff.leadConversationId === leadId));
  const revision = relevant.map((conversation) => `${conversation.id}:${conversation.updatedAt}`).join('|');
  useEffect(() => {
    let alive = true;
    for (const conversation of relevant) {
      if (!('__summary' in conversation)) continue;
      void window.kaiDesktop.getConversation(conversation.id).then(unwrap).then((full) => {
        if (alive && full) setLoaded((current) => ({ ...current, [full.id]: full }));
      }).catch(() => { if (alive) setError('Could not load a saved Builder result. Open its conversation to retry.'); });
    }
    return () => { alive = false; };
  }, [leadId, revision]);
  const hydrated = relevant.map((conversation) => loaded[conversation.id]?.updatedAt === conversation.updatedAt ? loaded[conversation.id]! : conversation);
  const links = hydrated.flatMap((conversation) => (conversation.leadHandoffs ?? []).filter((handoff) => handoff.leadConversationId === leadId).map((handoff) => ({ conversation, handoff })));
  if (!links.length) return null;
  return <details open className="lead-run-links"><summary>Builder tasks and results ({links.length})</summary>
    {error && <p role="alert">{error}</p>}
    {links.map(({ conversation, handoff }) => {
      const result = handoffResult(conversation, handoff);
      const pricePaused = isLeadPricePause(handoff.completion?.continuationNote);
      return <section key={handoff.id} className="lead-builder-task">
        <strong>{conversation.title}</strong><span role="status">{handoff.completion ? ({ 'review-needed': 'Review needed', 'passed': 'Passed', 'needs-repair': 'Needs repair', 'not-checked': 'Not checked', 'needs-you': 'Needs you' })[handoff.completion.state] : result ? 'Review needed' : handoff.delivery === 'run' ? 'Sent to Builder · awaiting result' : 'Awaiting result'}</span>{result && <small>Task status only. A phase stays open until all its required gates pass. Checks apply to this reply, not later edits.</small>}
        {handoff.completion && <p>{handoff.completion.reason}</p>}
        {handoff.completion?.continuationNote && <div role="note">{pricePaused && <strong>Automatic review paused — price unavailable</strong>}<p>{handoff.completion.continuationNote}</p>{pricePaused && <small>Normal Lead chat still works. The button below requests one review using the visible model; a Paid API choice may incur a charge. It does not restart automatic Builder work.</small>}</div>}
        {handoff.completion?.reviewedBy && <small>Reviewed by {describeRole(handoff.completion.reviewedBy, {}, inventory).label} · {leadModelTier(handoff.completion.reviewedBy, inventory)}</small>}
        <details><summary>Task sent to Builder</summary><pre>{handoff.task}</pre></details>
        {result && <details><summary>Builder reply</summary><Markdown text={result.answer.text} /></details>}
        {result?.commands.map((command) => <details key={command.id}><summary>Recorded command: {command.command} · exit {command.exitCode ?? 'unknown'}</summary><small>{command.timestamp}</small><pre>{command.output}</pre></details>)}
        {result?.reason && <small>{result.reason}</small>}
        {handoff.completion && (handoff.completion.state !== 'passed' || handoff.completion.continuationNote) && <div role="note"><strong>Keep the project moving</strong><small>Ask Lead for a recovery step, an exact decision or independent work. This keeps failed gates open and does not start Builder. Uses the selected Lead model{target && leadModelTier(target, inventory) === 'Paid API' ? '; this planning request may incur a charge' : ''}.</small><UiButton type="button" className="secondary-button" disabled={!target || running || Boolean(busy) || !onRecovery} onClick={() => { if (target) onRecovery?.(conversation, handoff, target); }}>Plan ways forward</UiButton></div>}
        <UiButton type="button" className="secondary-button" onClick={() => onOpen?.(conversation.id)}>Open Builder</UiButton>
        <UiButton type="button" className="secondary-button" disabled={!target || running || Boolean(busy) || !onReview} onClick={() => { if (!target || !onReview) return; setBusy(handoff.id); setError(null); void onReview(conversation.id, handoff, target).catch((caught) => setError(caught instanceof Error ? caught.message : String(caught))).finally(() => setBusy(null)); }}>{busy === handoff.id ? 'Reading result…' : pricePaused ? `Review once with Lead · ${target ? leadModelTier(target, inventory) : 'Choose model'}` : 'Review result with Lead'}</UiButton>
        {reviewerTarget && <UiButton type="button" className="secondary-button" disabled={!result || running || Boolean(busy) || !onReview} onClick={() => { if (!onReview) return; setBusy(handoff.id); setError(null); void onReview(conversation.id, handoff, reviewerTarget).catch((caught) => setError(caught instanceof Error ? caught.message : String(caught))).finally(() => setBusy(null)); }}>Review with reviewer · {leadModelTier(reviewerTarget, inventory)}</UiButton>}
      </section>;
    })}
  </details>;
}
