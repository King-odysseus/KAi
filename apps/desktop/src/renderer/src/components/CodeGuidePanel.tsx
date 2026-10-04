import { AlertTriangle, ArrowRight, Check, Circle, Loader2, Sparkles } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { CodeGuideAction, CodeGuideStep, CodeGuideView } from '@kai/contracts';

/**
 * The Senior Dev for the Code screen: where the whole project is, and the one thing to do next.
 *
 * The twin of `GuidePanel`, against the code-shaped steps. The split is the same and so is the reason for it: the
 * steps and the button under them come from the rules in `main/code-guide.ts`, so they are right even when the
 * explanation below is missing, stale, or has not been paid for yet.
 *
 * What it deliberately does not do is tell you which file or concept to study. That question is already answered,
 * well, by the Learn panel beside it — this one stays at the level of the project.
 *
 * The styles are the Studio guide's, reused rather than copied: they are not scoped to that screen, so the two
 * guides look like the same feature because they are one.
 */

interface Props {
  view: CodeGuideView | null;
  /** True while the explanation is being fetched; the steps are already on screen by then. */
  explaining: boolean;
  /** The screen is running something else, so a button that starts work is held back. */
  busy: boolean;
  /** Why the guide has nothing to show, when that is the reason. Only reachable when the read itself failed. */
  error?: string | null;
  onExplain: () => void;
  onAction: (action: CodeGuideAction) => void;
}

function StepMark({ state }: { state: CodeGuideStep['state'] }): ReactNode {
  if (state === 'done') return <Check size={13} aria-hidden="true" />;
  if (state === 'blocked') return <AlertTriangle size={13} aria-hidden="true" />;
  if (state === 'current') return <ArrowRight size={13} aria-hidden="true" />;
  return <Circle size={13} aria-hidden="true" />;
}

function Step({ step, index, busy, onAction }: { step: CodeGuideStep; index: number; busy: boolean; onAction: (action: CodeGuideAction) => void }): ReactNode {
  const here = step.state === 'current' || step.state === 'blocked';
  return (
    <li className={`guide-step ${step.state}`}>
      <div className="guide-step-head">
        <span className="guide-mark"><StepMark state={step.state} /></span>
        <strong>{index + 1}. {step.title}</strong>
        {here && <span className="guide-here">{step.state === 'blocked' ? 'needs you' : 'you are here'}</span>}
      </div>
      {/* The "why" is for the step being read, not for all of them at once: a wall of justifications is a wall. */}
      {here && <p className="studio-note guide-why">{step.why}</p>}
      {step.detail && <p className="studio-note">{step.detail}</p>}
      {here && step.action && step.actionLabel && (
        <button type="button" className="secondary-button" onClick={() => onAction(step.action as CodeGuideAction)} disabled={busy}>
          {step.actionLabel}
        </button>
      )}
    </li>
  );
}

export function CodeGuidePanel({ view, explaining, busy, error = null, onExplain, onAction }: Props): ReactNode {
  const [showHistory, setShowHistory] = useState(false);

  if (!view) {
    return (
      <article className="studio-card" aria-label="Senior dev">
        <h2><Sparkles size={16} /> Senior dev</h2>
        {error
          ? <p className="studio-note error" role="alert"><AlertTriangle size={13} /> {error}</p>
          : <p className="studio-note"><Loader2 className="spin" size={13} /> Reading where this project is…</p>}
      </article>
    );
  }

  const current = view.steps.find((step) => step.id === view.currentStepId);
  return (
    <article className="studio-card" aria-label="Senior dev">
      <h2><Sparkles size={16} /> Senior dev</h2>
      <p className="studio-note">
        Reads this project — the repository, the files, what you have studied and the board — and says where it has
        got to and what to do next. The steps come from the project itself; the explanation is written for you.
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
          <button type="button" className="link-button" onClick={onExplain} disabled={busy}>
            {view.narrative ? 'Explain this again' : 'Explain where I am'}
          </button>
        )}
        {view.narrativeAt && <span className="studio-note"> Written {view.narrativeAt.slice(0, 16).replace('T', ' ')}.</span>}
      </div>

      {/* The full picture, above the ladder. The steps say where the project is in a process; this says what there
          is to work on. Both are counted from the same file list the steps were decided from, so the two cannot end
          up describing different projects. It is hidden for a folder with no files rather than shown empty. */}
      {view.project.files > 0 && (
        <div className="guide-project">
          <h3>What this project is made of</h3>
          <p className="studio-note">
            {view.project.files} file{view.project.files === 1 ? '' : 's'}
            {view.project.languages.length > 0 ? `, written mostly in ${view.project.languages[0]!.label}` : ''}.
          </p>
          <ul className="guide-areas">
            {view.project.areas.map((area) => (
              <li key={area.path}>
                <code>{area.path}</code>
                <span>
                  {area.files} file{area.files === 1 ? '' : 's'}
                  {area.tests > 0 ? ` · ${area.tests} test${area.tests === 1 ? '' : 's'}` : ''}
                </span>
              </li>
            ))}
          </ul>
          {/* Only worth a line when there is more than one language to compare; "TypeScript 412" alone says nothing
              the sentence above it has not already said. */}
          {view.project.languages.length > 1 && (
            <p className="studio-note">{view.project.languages.map((entry) => `${entry.label} ${entry.files}`).join(' · ')}</p>
          )}
        </div>
      )}

      <ol className="guide-steps">
        {view.steps.map((step, index) => (
          <Step key={step.id} step={step} index={index} busy={busy} onAction={onAction} />
        ))}
      </ol>

      <div className="guide-history">
        <button type="button" className="link-button" aria-expanded={showHistory} onClick={() => setShowHistory((open) => !open)}>
          {showHistory ? 'Hide' : 'Show'} what has been done ({view.history.length})
        </button>
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
 * The same answer in one line, pinned above the editor.
 *
 * This is the half that matters while you are actually typing: the panel above is behind a tab, and a guide you have
 * to go and open is a guide you will not read. It is deliberately not tied to the Learn panel being open, for the
 * same reason — the moment it is most useful is the moment the panel is closed.
 */
export function CodeGuideStrip({ view, busy, onAction, onOpen }: { view: CodeGuideView | null; busy: boolean; onAction: (action: CodeGuideAction) => void; onOpen: () => void }): ReactNode {
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
        {/* Unlike the board's strip, every action here is kept: "Open Learn" is worth offering from the strip
            precisely because it is what you would otherwise have to go looking for. */}
        {current.action && current.actionLabel && (
          <button type="button" className="secondary-button" onClick={() => onAction(current.action as CodeGuideAction)} disabled={busy}>{current.actionLabel}</button>
        )}
        <button type="button" className="link-button" onClick={onOpen}>Open the guide</button>
      </span>
    </div>
  );
}
