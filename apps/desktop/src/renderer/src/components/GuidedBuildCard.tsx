import { useState, type ReactNode } from 'react';
import { ArrowRight, Check, Code2, Cpu, FileText, ListChecks, Pencil, ShieldCheck, Sparkles, Users, X } from 'lucide-react';
import type { GuidedBuild, GuidedBuildStep } from '@kai/contracts';
import { UiButton } from './UiButton';
import { Pill } from './Pill';
import { planLocation } from './guided-build-engine';
import { IconButton } from './ui/IconButton';
import { ActionsMenu } from './ui/ActionsMenu';
import { Textarea } from 'flowbite-react';

/**
 * Guided Build as a conversation, not a form.
 *
 * A thin strip says where you are in the plan. Below it the Coach speaks about the current step in plain words, with the
 * choices as buttons: let the Builder do it, see the code and type it yourself, or open the file and edit it. After a
 * check, the Coach's verdict and the one obvious next button sit in the same place. The fields of the step are still
 * editable, but behind "Edit this step", because most people never need them.
 *
 * Both Workspace and Learn & Code mount this; it holds no model logic, only what to show and which button was pressed.
 */

export interface GuidedBuildCardProps {
  state: GuidedBuild;
  disabled: boolean;
  planBusy: boolean;
  reviewBusy: boolean;
  /** Who plans and who builds, as a person reads it: "Claude · opus", "qwen3-coder · on this computer". */
  coachLabel: string;
  builderLabel: string;
  /** Whether the Builder runs on this computer or the home network, which the card says out loud. */
  builderIsLocal: boolean;
  /** True when Guided Build was started from a Studio brief, which the Coach turns into the plan. */
  hasBrief?: boolean;
  /** Why the Builder stopped and asked for help, when it did; null otherwise. */
  stuckReason?: string | null;
  /** Who a stronger retry would use (the Coach's model); null when the Builder is not a small local model. */
  escalateLabel?: string | null;
  /** One run of this step on that stronger model. The saved Builder does not change. */
  onEscalate?: () => void;
  /** How much the person wants to do, which decides which button leads. */
  handsOn?: GuidedBuild['handsOn'];
  /** Every model a single step could be built with, and the action for choosing one. The saved Builder is not changed. */
  withOptions?: ReadonlyArray<{ value: string; label: string }>;
  onBuildWith?: (value: string) => void;
  onChange: (state: GuidedBuild) => void;
  onOpenFile: (path: string, line?: number) => void;
  onGeneratePlan: () => void;
  /** The person's idea for the plan, typed in the card. The host asks the Coach to fit it in at the right place. */
  onAddIdea: (idea: string) => void;
  /** Hides the card. Left out where the card is the whole panel (Learn & Code), so no hide button is drawn. */
  onDismiss?: () => void;
  /** Opens Plan and team: the dial, the roles and the plan in one place. */
  onOpenTeam?: () => void;
  /** "Do it for me": the Builder makes this step's change. */
  onBuild: () => void;
  /** "Show me the code": the Coach says where to type and what, without editing anything. */
  onShowCode: () => void;
  /** The Coach checks the saved files against the step. */
  onReview: () => void;
  onNext: () => void;
}

function splitWhere(where: string): { path: string; line?: number } {
  const [path = '', line] = where.split(':');
  const number = Number(line);
  return { path: path.trim(), ...(Number.isFinite(number) && number > 0 ? { line: number } : {}) };
}

const VERDICT: Record<NonNullable<GuidedBuild['review']>['status'], { tone: 'success' | 'warning' | 'neutral'; label: string }> = {
  ready: { tone: 'success', label: 'Ready to continue' },
  'changes-needed': { tone: 'warning', label: 'Changes needed' },
  unverified: { tone: 'neutral', label: 'Could not verify' },
};

export function GuidedBuildCard(props: GuidedBuildCardProps): ReactNode {
  const { state, disabled, planBusy, reviewBusy, coachLabel, builderLabel, builderIsLocal, hasBrief, stuckReason, escalateLabel, onEscalate, handsOn, withOptions, onBuildWith, onChange, onOpenFile, onGeneratePlan, onAddIdea, onDismiss, onOpenTeam, onBuild, onShowCode, onReview, onNext } = props;
  const [planOpen, setPlanOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [ideaOpen, setIdeaOpen] = useState(false);
  const [idea, setIdea] = useState('');
  const step = state.steps[state.currentStep];
  const total = state.steps.length;
  const last = state.currentStep >= total - 1;
  // A plan saved by an older build can hold two file names run together; the first is the one to show and open.
  const stepFile = step ? planLocation(step.where).where : '';
  const where = step ? splitWhere(stepFile) : null;
  const review = state.review;
  const stepDone = step?.status === 'complete' || review?.status === 'ready';

  const updateStep = (index: number, update: Partial<GuidedBuildStep>): void => {
    onChange({ ...state, steps: state.steps.map((item, position) => (position === index ? { ...item, ...update } : item)), review: null });
  };
  const open = (): void => { if (where?.path) onOpenFile(where.path, where.line); };

  if (!step) {
    return (
      <section className="guided-build-panel mx-4 my-2 flex flex-wrap items-center gap-3 rounded-xl border border-[color:var(--border-soft)] bg-[var(--bg-panel)] p-3" aria-label="Guided Build">
        <Sparkles size={16} className="text-[var(--accent)]" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <strong className="text-sm">Guided Build</strong>
          <p className="m-0 text-xs text-[var(--text-dim)]">{hasBrief
            ? 'Your Studio brief is loaded. The Coach reads the project and makes a short plan from it, keeping what you decided and asking before anything rests on a risky guess.'
            : 'Tell the Coach what you want to build. It reads the project and makes a short plan, one change per step.'}</p>
        </div>
        <UiButton type="button" className="secondary-button" disabled={disabled || planBusy} onClick={onGeneratePlan}>{planBusy ? 'Making your plan…' : 'Make my plan now'}</UiButton>
        {onDismiss && <IconButton aria-label="Hide Guided Build" title="Hide this panel; Guided Build stays on" onClick={onDismiss} icon={<X size={14} />} />}
      </section>
    );
  }

  return (
    <section className="guided-build-panel mx-4 my-2 max-h-[62vh] shrink-0 overflow-y-auto rounded-xl border border-[color:var(--border-soft)] bg-[var(--bg-panel)]" aria-label="Guided Build">
      {/* Where you are */}
      <div className="sticky top-0 z-10 border-b border-[color:var(--border-soft)] bg-[var(--bg-panel)] px-4 pb-3 pt-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--accent)]">Step {state.currentStep + 1} of {total}</span>
          <strong className="min-w-0 flex-1 text-sm">{step.title}</strong>
          {state.planTitle && <span className="text-xs text-[var(--text-dim)]">{state.planTitle}</span>}
          {onOpenTeam && <UiButton type="button" className="secondary-button" onClick={onOpenTeam}><Users size={14} /> Plan and team</UiButton>}
          <UiButton type="button" className="secondary-button" aria-expanded={planOpen} onClick={() => setPlanOpen((value) => !value)}><ListChecks size={14} /> {planOpen ? 'Hide plan' : 'Show plan'}</UiButton>
          {onDismiss && <IconButton aria-label="Hide Guided Build" title="Hide this panel; Guided Build stays on" onClick={onDismiss} icon={<X size={14} />} />}
        </div>
        <div className="mt-3 flex gap-1.5" role="list" aria-label="Plan progress">
          {state.steps.map((item, index) => {
            const done = item.status === 'complete' || index < state.currentStep;
            const current = index === state.currentStep;
            return <div key={item.id} role="listitem" aria-label={`${index + 1}. ${item.title}${done ? ', done' : current ? ', current' : ''}`} title={item.title}
              className={`h-1.5 flex-1 rounded-full ${done ? 'bg-[var(--accent)] opacity-60' : current ? 'bg-[var(--accent)]' : 'bg-[var(--border)]'}`} />;
          })}
        </div>
        {ideaOpen && (
          <form className="mt-3 flex flex-wrap items-center gap-2" aria-label="Add an idea to the plan"
            onSubmit={(event) => { event.preventDefault(); const text = idea.trim(); if (!text || disabled) return; onAddIdea(text); setIdea(''); setIdeaOpen(false); }}>
            <input aria-label="Your idea for the plan" autoFocus className="guided-build-field-control min-w-0 flex-1" placeholder="For example: add a dark-mode toggle to Settings" value={idea} onChange={(event) => setIdea(event.target.value)} />
            <UiButton type="submit" className="primary-button" disabled={disabled || !idea.trim()}>Add to the plan</UiButton>
            <UiButton type="button" className="secondary-button" onClick={() => { setIdeaOpen(false); setIdea(''); }}>Cancel</UiButton>
            <p className="m-0 basis-full text-xs text-[var(--text-dim)]">The Coach fits it in at the right place and keeps the steps that are still useful.</p>
          </form>
        )}
        {planOpen && (
          <ol className="m-0 mt-3 grid list-none gap-1 p-0">
            {state.steps.map((item, index) => (
              <li key={item.id}>
                <button type="button" disabled={disabled} aria-current={index === state.currentStep ? 'step' : undefined}
                  className={`flex w-full items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left text-sm hover:bg-[var(--bg-raised)] ${index === state.currentStep ? 'bg-[var(--bg-raised)] font-semibold' : ''}`}
                  onClick={() => { onChange({ ...state, currentStep: index, review: null }); setEditing(false); }}>
                  <span className="w-5 text-xs text-[var(--text-dim)]">{index + 1}</span>
                  <span className="min-w-0 flex-1">{item.title}</span>
                  {(item.status === 'complete') && <Check size={14} aria-label="Done" />}
                  <span className="text-xs text-[var(--text-dim)]">{splitWhere(planLocation(item.where).where).path}</span>
                </button>
              </li>
            ))}
            <li><UiButton type="button" className="secondary-button" disabled={disabled} onClick={() => { setIdeaOpen(true); setPlanOpen(false); }}>Add an idea to the plan</UiButton></li>
          </ol>
        )}
      </div>

      {/* The Coach speaks */}
      <div className="flex gap-3 px-4 py-4">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--bg-raised)]" aria-hidden="true"><Sparkles size={16} className="text-[var(--accent)]" /></div>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2"><strong>Coach</strong><span className="text-[11px] text-[var(--text-dim)]">{coachLabel}</span></div>
          {step.why && <p className="m-0 text-sm text-[var(--text)]">{step.why}</p>}
          {step.instructions && <p className="m-0 mt-2 whitespace-pre-line text-sm text-[var(--text)]">{step.instructions}</p>}
          {where?.path && (
            <button type="button" onClick={open} disabled={disabled} className="mt-3 inline-flex items-center gap-2 rounded-md bg-[var(--bg-raised)] px-2 py-1 font-mono text-xs text-[var(--text)] hover:underline" title="Open this file in the editor">
              <FileText size={13} aria-hidden="true" />{stepFile}
            </button>
          )}
          {step.acceptanceCriteria.length > 0 && (
            <div className="mt-3">
              <div className="mb-1 text-xs font-semibold text-[var(--text-muted)]">Done when</div>
              <ul className="m-0 grid gap-1 pl-0 text-sm text-[var(--text)]" style={{ listStyle: 'none' }}>
                {step.acceptanceCriteria.map((item, index) => <li key={`${index}-${item}`} className="flex items-start gap-2"><Check size={14} className="mt-0.5 shrink-0 text-[var(--text-dim)]" aria-hidden="true" /><span>{item}</span></li>)}
              </ul>
            </div>
          )}

          {/* A step that rests on a guess from the brief waits for the person's OK */}
          {step.needsApproval && !stepDone && (
            <div className="mt-4 rounded-lg border border-[color:var(--border-soft)] bg-[var(--bg-shell)] p-3" role="alert">
              <div className="mb-1"><Pill tone="warning">Needs your OK first</Pill></div>
              <p className="m-0 text-sm text-[var(--text)]">{step.needsApproval}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <UiButton type="button" className="primary-button" disabled={disabled} onClick={() => updateStep(state.currentStep, { needsApproval: undefined })}><Check size={15} /> That's right, go ahead</UiButton>
                <UiButton type="button" className="secondary-button" disabled={disabled} onClick={() => setEditing(true)}>Change this step</UiButton>
              </div>
            </div>
          )}

          {/* The Builder asked for help */}
          {stuckReason && !stepDone && (
            <div className="mt-4 rounded-lg border border-[color:var(--border-soft)] bg-[var(--bg-shell)] p-3" role="status">
              <div className="mb-1 flex flex-wrap items-center gap-2"><Pill tone="warning">The Builder got stuck</Pill><span className="text-[11px] text-[var(--text-dim)]">{builderLabel}</span></div>
              <p className="m-0 text-sm text-[var(--text)]">{stuckReason}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {escalateLabel && onEscalate && <UiButton type="button" className="primary-button" disabled={disabled} onClick={onEscalate}><Sparkles size={15} /> Retry with {escalateLabel}</UiButton>}
                <UiButton type="button" className="secondary-button" disabled={disabled} onClick={onShowCode}><Code2 size={15} /> Show me the code</UiButton>
                <UiButton type="button" className="secondary-button" disabled={disabled} onClick={onBuild}>Try again</UiButton>
              </div>
            </div>
          )}

          {/* Choices */}
          {!stepDone && (
            <>
              <div className="mt-4 flex flex-wrap gap-2">
                <UiButton type="button" className={handsOn === 'auto' ? 'primary-button' : 'secondary-button'} disabled={disabled || Boolean(step.needsApproval)} onClick={onBuild} title={`${builderLabel} makes this change`}><Cpu size={15} /> Do it for me</UiButton>
                <UiButton type="button" className="secondary-button" disabled={disabled} onClick={onShowCode}><Code2 size={15} /> Show me the code</UiButton>
                <UiButton type="button" className={handsOn === 'manual' ? 'primary-button' : 'secondary-button'} disabled={disabled || !where?.path} onClick={open}><Pencil size={15} /> I'll edit it myself</UiButton>
                {withOptions && withOptions.length > 0 && onBuildWith && (
                  <ActionsMenu
                    ariaLabel="Choose which model builds this step"
                    items={withOptions.map((option) => ({ key: option.value, label: option.label, onSelect: () => onBuildWith(option.value) }))}
                    trigger={({ onClick, expanded }) => <UiButton type="button" className="secondary-button" disabled={disabled || Boolean(step.needsApproval)} aria-haspopup="menu" aria-expanded={expanded} onClick={onClick} title="Build just this step with a different model. Your saved Builder does not change."><Cpu size={15} /> With…</UiButton>}
                  />
                )}
              </div>
              <p className="m-0 mt-2 text-xs text-[var(--text-dim)]">
                {builderIsLocal ? <>Builder: {builderLabel}. Runs on your own models, so the Coach's strong model is only used to plan and check.</> : <>Builder: {builderLabel}.</>}
              </p>
            </>
          )}

          {/* The check and its verdict */}
          {!stepDone && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <UiButton type="button" className="secondary-button" disabled={disabled || reviewBusy} onClick={onReview}><ShieldCheck size={15} /> {reviewBusy ? 'Checking…' : 'Check my edit'}</UiButton>
              <span className="text-xs text-[var(--text-dim)]">Save your change, then the Coach checks it against the list above.</span>
            </div>
          )}
          {review && (
            <div className="mt-4 rounded-lg border border-[color:var(--border-soft)] bg-[var(--bg-shell)] p-3" role="status">
              <div className="mb-1 flex flex-wrap items-center gap-2"><Pill tone={VERDICT[review.status].tone}>{VERDICT[review.status].label}</Pill><span className="text-[11px] text-[var(--text-dim)]">{coachLabel}</span></div>
              <p className="m-0 whitespace-pre-line text-sm text-[var(--text)]">{review.summary}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {review.status === 'ready'
                  ? <UiButton type="button" className="primary-button" disabled={disabled || last} onClick={onNext}>{last ? 'That was the last step' : <>Next: {state.steps[state.currentStep + 1]?.title ?? 'next step'} <ArrowRight size={15} /></>}</UiButton>
                  : <UiButton type="button" className="primary-button" disabled={disabled} onClick={onBuild}><Cpu size={15} /> Have the Builder fix it</UiButton>}
                {review.status !== 'ready' && escalateLabel && onEscalate && <UiButton type="button" className="secondary-button" disabled={disabled} onClick={onEscalate}><Sparkles size={15} /> Retry with {escalateLabel}</UiButton>}
                <UiButton type="button" className="secondary-button" disabled={disabled || reviewBusy} onClick={onReview}>Check again</UiButton>
              </div>
            </div>
          )}

          <div className="mt-4 flex flex-wrap gap-4 text-xs">
            <button type="button" className="link-button" aria-expanded={editing} onClick={() => setEditing((value) => !value)}>{editing ? 'Done editing' : 'Edit this step'}</button>
            <button type="button" className="link-button" disabled={disabled} aria-expanded={ideaOpen} title={disabled ? 'Available when the current run has finished' : undefined} onClick={() => setIdeaOpen(true)}>Add an idea to the plan</button>
          </div>

          {editing && (
            <div className="mt-3 grid gap-2 rounded-lg border border-[color:var(--border-soft)] bg-[var(--bg-shell)] p-3">
              <label className="guided-build-field"><span>What are we doing?</span><input aria-label="Step name" className="guided-build-field-control" value={step.title} onChange={(event) => updateStep(state.currentStep, { title: event.target.value })} /></label>
              <label className="guided-build-field"><span>Why does this change help?</span><Textarea aria-label="Why this change matters" rows={2} className="guided-build-field-control" value={step.why} onChange={(event) => updateStep(state.currentStep, { why: event.target.value })} /></label>
              <label className="guided-build-field"><span>Which file?</span><input aria-label="File and code location" className="guided-build-field-control" placeholder="For example, src/App.tsx:42" value={step.where} onChange={(event) => updateStep(state.currentStep, { where: event.target.value })} /></label>
              <label className="guided-build-field"><span>What should change?</span><Textarea aria-label="What to change" rows={3} className="guided-build-field-control" value={step.instructions} onChange={(event) => updateStep(state.currentStep, { instructions: event.target.value })} /></label>
              <label className="guided-build-field"><span>Done when (one check per line)</span><Textarea aria-label="How will we know it works?" rows={2} className="guided-build-field-control" value={step.acceptanceCriteria.join('\n')} onChange={(event) => updateStep(state.currentStep, { acceptanceCriteria: event.target.value.split('\n').filter(Boolean) })} /></label>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
