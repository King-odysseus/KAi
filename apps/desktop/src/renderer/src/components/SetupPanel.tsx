import { ArrowRight, Brain, Check, Circle, FolderOpen, GitPullRequest, GraduationCap, Loader2, RefreshCw, Route, Send, Settings2, X } from 'lucide-react';
import type { FormEvent, ReactNode } from 'react';
import { useState } from 'react';
import type { SetupCheck, SetupGuideAnswer, SetupStatus } from '@kai/contracts';
import { UiButton } from './UiButton';
import { Composer, ComposerInput, ComposerSend, ComposerToolbar } from './ui/Composer';
import { UiTextInput } from './UiTextInput';
import { Modal } from 'flowbite-react';

export function SetupPanel({
  status,
  busy,
  onAction,
  onComplete,
  onDismiss,
  onAskGuide,
}: {
  status: SetupStatus;
  busy: boolean;
  onAction: (action: NonNullable<SetupCheck['action']>) => void;
  onComplete: () => void;
  onDismiss: () => void;
  onAskGuide: (question: string, conversationContext?: string) => Promise<SetupGuideAnswer>;
}): ReactNode {
  const [guideOpen, setGuideOpen] = useState(() => {
    try { return window.localStorage.getItem('kai.setupGuideEnabled') === 'true'; } catch { return false; }
  });
  const [guideQuestion, setGuideQuestion] = useState('');
  const [guideTurns, setGuideTurns] = useState<Array<{ question: string; response: SetupGuideAnswer }>>([]);
  const [guideBusy, setGuideBusy] = useState(false);
  const [guideError, setGuideError] = useState<string | null>(null);
  const blocked = status.checks.some((check) => check.status === 'blocked');
  const ready = status.checks.filter((check) => check.status === 'ready').length;
  const tutorReady = status.checks.some((check) => check.id === 'tutor' && check.status === 'ready');
  function toggleGuide(): void {
    setGuideOpen((open) => {
      const next = !open;
      try { window.localStorage.setItem('kai.setupGuideEnabled', String(next)); } catch { /* The toggle still works for this session. */ }
      return next;
    });
  }
  async function askGuide(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const question = guideQuestion.trim();
    if (!question || !tutorReady || guideBusy) return;
    setGuideBusy(true);
    setGuideError(null);
    try {
      const context = guideTurns.slice(-4).map(({ question: prior, response }) => `You asked: ${prior}\nKAI Guide: ${response.answer}`).join('\n\n').slice(-3_500);
      const response = await onAskGuide(question, context);
      setGuideTurns((turns) => [...turns, { question, response }].slice(-6));
      setGuideQuestion('');
    } catch (caught) {
      setGuideError(caught instanceof Error ? caught.message : 'KAI Guide could not answer. Check the Learning Tutor connection and try again.');
    } finally {
      setGuideBusy(false);
    }
  }
  return (
    <Modal show size="4xl" dismissible={false} aria-labelledby="setup-title">
      <section className="setup-panel">
        <header className="setup-head">
          <div>
            <span className="eyebrow">Welcome & reconfigure</span>
            <h2 id="setup-title">Set up KAI your way</h2>
            <p>{ready} of {status.checks.length} checks ready. Start with a local agent or API, then add optional learning, GitHub, memory, and routing when useful.</p>
          </div>
          <UiButton type="button" className="icon-button compact" aria-label="Set up later" onClick={onDismiss}>
            <X size={15} />
          </UiButton>
        </header>
        <div className="setup-guide-toggle">
          <UiButton type="button" className="secondary-button" onClick={toggleGuide} aria-expanded={guideOpen}>
            <GraduationCap size={14} /><span>{guideOpen ? 'Hide KAI Guide' : 'Turn on KAI Guide'}</span>
          </UiButton>
          <span>Ask questions about KAI and get step-by-step help.</span>
        </div>
        {guideOpen && (
          <aside className="setup-guide" aria-label="KAI setup guide">
            <strong>Your KAI tutor</strong>
            <p>Ask how to connect Codex or Claude, add a provider API, use GitHub, understand a KAI page, or set up Remote. Answers use the separate Learning Tutor connection and may incur charges from its provider.</p>
            {tutorReady ? (
              <>
                <div className="setup-guide-conversation" aria-live="polite">
                  {guideTurns.map(({ question, response }, index) => (
                    <article className="setup-guide-turn" key={`${index}:${question}`}>
                      <strong>You asked</strong><p>{question}</p>
                      <strong>KAI Guide</strong><p>{response.answer}</p>
                      {response.nextSteps.length > 0 && <ol>{response.nextSteps.map((step, stepIndex) => <li key={stepIndex}>{step}</li>)}</ol>}
                    </article>
                  ))}
                </div>
                <form onSubmit={(event) => void askGuide(event)}>
                  <Composer>
                    <ComposerInput aria-label="Ask KAI Guide" value={guideQuestion} maxLength={1_000} rows={2} onChange={(event) => setGuideQuestion(event.target.value)} placeholder="What do you want help with?" />
                    <ComposerToolbar actions={<ComposerSend submit label={guideBusy ? 'Thinking' : 'Ask KAI Guide'} sending={guideBusy} disabled={guideBusy || !guideQuestion.trim()} />} />
                  </Composer>
                </form>
                {guideError && <p className="setup-guide-error" role="alert">{guideError}</p>}
              </>
            ) : (
              <>
                <p>{status.checks.find((check) => check.id === 'tutor')?.detail ?? 'Set up the Learning Tutor connection to ask questions.'}</p>
                <UiButton type="button" className="secondary-button align-start" disabled={busy} onClick={() => onAction('open_tutor')}><GraduationCap size={14} /><span>Set up Learning Tutor</span></UiButton>
                <p className="setup-guide-hint">You can still use the setup checklist below. The Guide never asks for a key in chat; save it in Settings, where KAI stores it in the system credential vault.</p>
              </>
            )}
          </aside>
        )}
        <div className="setup-checks">
          {status.checks.map((check) => (
            <article className={`setup-check ${check.status}`} key={check.id}>
              <span className="setup-check-state" aria-hidden="true">
                {check.status === 'ready' ? <Check size={14} /> : check.status === 'blocked' ? <Circle size={10} fill="currentColor" /> : <RefreshCw size={13} />}
              </span>
              <div className="setup-check-copy">
                <strong>{check.label}</strong>
                <span>{check.detail}</span>
              </div>
              {check.action && (
                <UiButton type="button" className="secondary-button" disabled={busy} onClick={() => onAction(check.action!)}>
                  {setupActionIcon(check.action)}
                  <span>{setupActionLabel(check.action, check)}</span>
                </UiButton>
              )}
              {check.status === 'ready' && <span className="setup-ready-label">Ready</span>}
            </article>
          ))}
        </div>
        <footer className="setup-footer">
          <UiButton type="button" className="secondary-button" disabled={busy} onClick={onDismiss}>Set up later</UiButton>
          <UiButton type="button" className="primary-button" disabled={busy || blocked} onClick={onComplete}>
            <Check size={15} />
            <span>{blocked ? 'Finish required checks first' : 'Finish setup'}</span>
          </UiButton>
        </footer>
      </section>
    </Modal>
  );
}

function setupActionIcon(action: NonNullable<SetupCheck['action']>): ReactNode {
  if (action === 'open_project') return <FolderOpen size={14} />;
  if (action === 'open_settings') return <Settings2 size={14} />;
  if (action === 'open_tutor') return <GraduationCap size={14} />;
  if (action === 'open_github') return <GitPullRequest size={14} />;
  if (action === 'open_remote') return <Route size={14} />;
  if (action === 'start_cognitive1') return <Brain size={14} />;
  if (action === 'start_proxy') return <Route size={14} />;
  return <ArrowRight size={14} />;
}

function setupActionLabel(action: NonNullable<SetupCheck['action']>, check: SetupCheck): string {
  const checkId = check.id;
  if (action === 'open_project') return 'Open project';
  if (action === 'open_settings') return checkId === 'cli' ? 'Set up an agent' : 'Configure API';
  if (action === 'open_tutor') return 'Set up Tutor';
  if (action === 'open_github') return check.detail.includes('not installed') ? 'Install GitHub CLI' : 'Connect GitHub';
  if (action === 'open_remote') return 'Set up Remote';
  if (action === 'start_cognitive1') return 'Start Brain';
  if (action === 'start_proxy') return 'Start Proxy';
  return 'Open';
}
