import { Check, ShieldQuestion, X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { CrewRun } from '@kai/contracts';
import { UiButton } from './UiButton';

/**
 * What the plan says needs the person's OK before the crew builds, as Yes/No cards with a plain explanation. The
 * answer is recorded by the button, never by a sentence typed in a chat, so it cannot be given by accident or by
 * copying a suggested line without knowing what it means.
 */
export function CrewApprovals({ run, working, onDecide }: {
  run: CrewRun;
  working: boolean;
  onDecide: (approvalId: string, approve: boolean) => void;
}): ReactNode {
  const pending = run.approvals.filter((item) => item.status === 'pending');
  if (pending.length === 0) return null;
  return (
    <section className="crew-approvals" role="group" aria-label="Needs your OK">
      <h3 className="crew-subheading"><ShieldQuestion size={14} /> Needs your OK before the crew builds</h3>
      <ul className="crew-approval-list">
        {pending.map((item) => (
          <li key={item.id} className="crew-approval">
            <div className="crew-approval-copy">
              <strong>{item.what}</strong>
              <p>{item.why || 'The plan or the project rules say this needs your OK before it is added.'}</p>
            </div>
            <div className="crew-approval-actions">
              <UiButton type="button" className="primary-button" disabled={working} onClick={() => onDecide(item.id, true)}><Check size={14} /> Approve</UiButton>
              <UiButton type="button" className="secondary-button" disabled={working} onClick={() => onDecide(item.id, false)}><X size={14} /> Don&rsquo;t use it</UiButton>
            </div>
          </li>
        ))}
      </ul>
      <small className="crew-empty">Saying no does not stop the crew. It is told not to add this and to find another way.</small>
    </section>
  );
}
