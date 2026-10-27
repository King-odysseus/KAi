import { AlertTriangle, ArrowRight, Check, Circle, Loader2, Sparkles } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { GuideAction, StudioGuideStep, StudioGuideView } from '@kai/contracts';
import { UiButton } from './UiButton';

/**
 * The Senior Dev: where this project is, and the one thing to do next.
 *
 * The steps and the button under them come from the rules in `main/studio-guide.ts`, so they are right even when the
 * explanation below is missing, stale, or has not been paid for yet. That ordering is deliberate — a guide whose
 * "next step" depended on a model reply would be a guide that goes quiet exactly when something is wrong.
 */

interface Props {
  view: StudioGuideView | null;
  /** True while the explanation is being fetched; the steps are already on screen by then. */
  explaining: boolean;
  /** The screen is running something else, so a button that starts work is held back. */
  busy: boolean;
  onExplain: () => void;
  onAction: (action: GuideAction) => void;
}

function StepMark({ state }: { state: StudioGuideStep['state'] }): ReactNode {
  if (state === 'done') return <Check size={13} aria-hidden="true" />;
  if (state === 'blocked') return <AlertTriangle size={13} aria-hidden="true" />;
  if (state === 'current') return <ArrowRight size={13} aria-hidden="true" />;
  return <Circle size={13} aria-hidden="true" />;
}

function Step({ step, index, busy, onAction }: { step: StudioGuideStep; index: number; busy: boolean; onAction: (action: GuideAction) => void }): ReactNode {
  const here = step.state === 'current' || step.state === 'blocked';
  // Only the step being read is named. Stamping "done" on five rows and "later" on the rest is noise the markers
  // already carry, and it buries the one word worth reading.
  return (
    <li className={`guide-step ${step.state}`}>
      <div className="guide-step-head">
        <span className="guide-mark"><StepMark state={step.state} /></span>
        <strong>{index + 1}. {step.title}</strong>
        {here && <span className="guide-here">{step.state === 'blocked' ? 'needs you' : 'you are here'}</span>}
      </div>
      {/* The "why" is for the step being read, not for all eight at once: eight explanations at once is a wall. */}
      {here && <p className="studio-note guide-why">{step.why}</p>}
      {step.detail && <p className="studio-note">{step.detail}</p>}
      {here && step.action && step.actionLabel && (
        <UiButton type="button" className="secondary-button" onClick={() => onAction(step.action as GuideAction)} disabled={busy}>
          {step.actionLabel}
        </UiButton>
      )}
    </li>
  );
}

export function GuidePanel({ view, explaining, busy, onExplain, onAction }: Props): ReactNode {
  const [showHistory, setShowHistory] = useState(false);

  if (!view) {
    return (
      <article className="studio-card" aria-label="Senior dev">
        <h2><Sparkles size={16} /> Senior dev</h2>
        <p className="studio-note"><Loader2 className="spin" size={13} /> Reading where this project is…</p>
      </article>
    );
  }

  const current = view.steps.find((step) => step.id === view.currentStepId);
  return (
    <article className="studio-card" aria-label="Senior dev">
      <h2><Sparkles size={16} /> Senior dev</h2>
      <p className="studio-note">
        Reads this project — the brief, the plan, the board and the design — and says where it has got to and what to do
        next. The steps come from the project itself; the explanation is written for you.
      </p>

      <div className="guide-now">
        <h3>{view.narrative?.headline ?? current?.title ?? 'Where you are'}</h3>
        {view.narrative
          ? <p className="guide-explanation">{view.narrative.explanation}</p>
          : (
            <p className="studio-note">
              {explaining
                ? <><Loader2 className="spin" size={13} /> Writing you a walkthrough…</>
                : 'No walkthrough written for where the project is now.'}
            </p>
          )}
        {!explaining && (
          <UiButton type="button" className="link-button" onClick={onExplain} disabled={busy}>
            {view.narrative ? 'Explain this again' : 'Explain where I am'}
          </UiButton>
        )}
        {view.narrativeAt && <span className="studio-note"> Written {view.narrativeAt.slice(0, 16).replace('T', ' ')}.</span>}
      </div>

      <ol className="guide-steps">
        {view.steps.map((step, index) => (
          <Step key={step.id} step={step} index={index} busy={busy} onAction={onAction} />
        ))}
      </ol>

      <div className="guide-history">
        <UiButton type="button" className="link-button" aria-expanded={showHistory} onClick={() => setShowHistory((open) => !open)}>
          {showHistory ? 'Hide' : 'Show'} what has been done ({view.history.length})
        </UiButton>
        {showHistory && (
          view.history.length === 0
            ? <p className="studio-note">Nothing yet. Each step is recorded the first time it is finished.</p>
            : (
              <ul className="guide-done">
                {[...view.history].reverse().map((entry) => (
                  <li key={`${entry.stepId}-${entry.at}`}>
                    <Check size={12} aria-hidden="true" /> {entry.title}
                    <time>{entry.at.slice(0, 16).replace('T', ' ')}</time>
                  </li>
                ))}
              </ul>
            )
        )}
      </div>
    </article>
  );
}

/**
 * The same answer in one line, for the board: the step the project is on, and the button for it.
 *
 * It sits above the board because the board is where the work is, and "what do I do now" is the question a board of
 * fifty cards is worst at answering. The strip reads the same view the Guide tab does, so the two never disagree.
 */
export function GuideStrip({ view, busy, onAction, onOpen }: { view: StudioGuideView | null; busy: boolean; onAction: (action: GuideAction) => void; onOpen: () => void }): ReactNode {
  if (!view) return null;
  const current = view.steps.find((step) => step.id === view.currentStepId);
  if (!current) return null;
  const position = view.steps.indexOf(current) + 1;
  return (
    <div className={`guide-strip ${current.state}`}>
      <span className="guide-strip-where">
        Step {position} of {view.steps.length}
      </span>
      <strong>{current.title}</strong>
      <span className="guide-strip-detail">{current.detail}</span>
      <span className="guide-strip-actions">
        {current.action && current.actionLabel && !current.action.startsWith('open-') && (
          <UiButton type="button" className="secondary-button" onClick={() => onAction(current.action as GuideAction)} disabled={busy}>{current.actionLabel}</UiButton>
        )}
        <UiButton type="button" className="link-button" onClick={onOpen}>Open the guide</UiButton>
      </span>
    </div>
  );
}
