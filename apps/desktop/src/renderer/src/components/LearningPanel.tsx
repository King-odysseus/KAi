import {
  BookOpen,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Code2,
  Copy,
  Eye,
  FileCode2,
  FolderTree,
  GitBranch,
  GraduationCap,
  HelpCircle,
  Lightbulb,
  ListChecks,
  LibraryBig,
  LoaderCircle,
  PanelRightClose,
  Play,
  Save,
  Search,
  Send,
  Settings,
  Sparkles,
  Target,
  WandSparkles,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MAX_SAVED_LESSONS } from '@kai/contracts';
import type {
  GitFileInfo,
  LearningAction,
  LearningAssistance,
  LearningEvaluationResult,
  LearningExplainBackGrade,
  LearningExplainBackHelp,
  LearningExplainBackHelpKind,
  LearningMastery,
  LearningProgress,
  LearningReadiness,
  LearningTutorScope,
  TeachingDraft,
  TeachingDraftGenerateInput,
  TeachingLibrary,
  TeachingLibraryEntryInput,
  TeachingLibrarySaveInput,
} from '@kai/contracts';
import { suggestionTarget } from '../learning-placement';
import { projectLessons } from './learning-path';
import { TeachingLibraryPanel } from './TeachingLibraryPanel';

interface LearningPanelProps {
  projectFiles: string[];
  onReference: (filePath: string, startLine?: number, endLine?: number) => void;
  responseLessonId: string | null;
  onLessonSelect: (lesson: NonNullable<LearningProgress['lessons']>[number]) => void;
  onUnderstood: (lessonId: string) => void;
  onExplainBack: (lessonId: string, question: string, answer: string) => Promise<LearningExplainBackGrade | null>;
  /** Rewords the question or shows a model answer; neither is graded or counts toward mastery. */
  onExplainBackHelp: (lessonId: string, question: string, kind: LearningExplainBackHelpKind) => Promise<LearningExplainBackHelp | null>;
  onRunCheck: () => Promise<string>;
  projectName: string | null;
  progress: LearningProgress | null;
  readiness: LearningReadiness | null;
  result: LearningEvaluationResult | null;
  scope: LearningTutorScope;
  selection: LearningSelectionPreview | null;
  gitInfo: GitFileInfo | null;
  busy: LearningAction | 'record' | null;
  error: string | null;
  question: string;
  submittedQuestion: string;
  conversation: TutorConversationTurn[];
  onQuestionChange: (value: string) => void;
  onAction: (action: LearningAction) => void;
  onScopeChange: (scope: LearningTutorScope) => void;
  onPreferences: (assistance: LearningAssistance, inlineSuggestions: boolean, modes?: LearningAssistance[]) => void;
  onInsertSuggestion: () => void;
  /** Puts the suggestion where the tutor said it belongs; only offered when the tutor named a place. */
  onPlaceSuggestion: () => void;
  appliedSuggestionNeedsExplanation: boolean;
  onExplainAppliedSuggestion: () => void;
  onStuck: () => void;
  /** Hints already taken on the current step: 0 none, 3 means the exact code was shown. */
  hintLevel: number;
  onRecordLesson?: () => void;
  teachingLibrary: TeachingLibrary | null;
  teachingBusy: string | null;
  onSaveTeachingEntry: (input: TeachingLibrarySaveInput) => Promise<void>;
  onDeleteTeachingEntry: (input: TeachingLibraryEntryInput) => Promise<void>;
  onResetTeachingEntry: (input: TeachingLibraryEntryInput) => Promise<void>;
  onGenerateTeachingDraft: (input: TeachingDraftGenerateInput) => Promise<TeachingDraft>;
  onOpenSettings: () => void;
  onClose: () => void;
}

export interface LearningSelectionPreview {
  filePath: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  text: string;
}

export interface TutorConversationTurn {
  id: string;
  question: string;
  response: LearningEvaluationResult['response'];
}

const assistanceOptions: Array<{ id: LearningAssistance; label: string; description: string }> = [
  { id: 'learn', label: 'Learn', description: 'Step by step' },
  { id: 'guided', label: 'Guided', description: 'Hints only' },
  { id: 'pair', label: 'Pair', description: 'Build together' },
  { id: 'copilot', label: 'Copilot', description: 'Suggest code' },
];

const actionOptions: Array<{ id: LearningAction; label: string; icon: ReactNode; needsSelection?: boolean }> = [
  { id: 'explain-selection', label: 'Explain selection', icon: <Code2 size={14} />, needsSelection: true },
  { id: 'explain-file', label: 'Explain file', icon: <FileCode2 size={14} /> },
  { id: 'hint', label: 'Hint', icon: <Lightbulb size={14} /> },
  { id: 'check-code', label: 'Check code', icon: <ListChecks size={14} /> },
  { id: 'explain-error', label: 'Explain error', icon: <BrainCircuit size={14} /> },
  { id: 'next-step', label: 'Next step', icon: <Play size={14} /> },
  { id: 'complete', label: 'Complete', icon: <WandSparkles size={14} /> },
];

// Indexed by hints already taken on the current step.
const stuckHints = [
  { label: "I'm stuck", title: 'Hint 1 of 3: a nudge toward where to look' },
  { label: 'Another hint', title: 'Hint 2 of 3: the file, the concept, and what to change, without the code' },
  { label: 'Show me the code', title: 'Hint 3 of 3: the exact code and where it goes' },
  { label: 'Code shown', title: 'All three hints used. Ask a new question to start again.' },
];

const explainBackVerdicts: Record<LearningExplainBackGrade['verdict'], string> = {
  solid: 'You got it',
  partial: 'Nearly there',
  missing: 'Not yet',
};

function explainBackQuestion(response: LearningEvaluationResult['response']): string {
  const question = response.followUpQuestion.trim() || response.checks[0]?.trim();
  return question || `In your own words, what did "${response.title}" change, and why does it work?`;
}

export function LearningPanel({
  projectFiles, onReference, onUnderstood, onExplainBack, onExplainBackHelp, onRunCheck, responseLessonId, onLessonSelect,
  progress,
  readiness,
  result,
  scope,
  selection,
  gitInfo,
  busy,
  error,
  question,
  submittedQuestion,
  conversation,
  onQuestionChange,
  onAction,
  onScopeChange,
  onPreferences,
  onInsertSuggestion,
  onPlaceSuggestion,
  appliedSuggestionNeedsExplanation,
  onExplainAppliedSuggestion,
  onStuck,
  hintLevel,
  onRecordLesson,
  teachingLibrary,
  teachingBusy,
  onSaveTeachingEntry,
  onDeleteTeachingEntry,
  onResetTeachingEntry,
  onGenerateTeachingDraft,
  onOpenSettings,
  onClose,
}: LearningPanelProps): ReactNode {
  const [focus, setFocus] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkOutput, setCheckOutput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const lessons = useMemo(() => projectLessons(projectFiles, progress), [projectFiles, progress]);
  const responseUnderstood = progress?.lessons?.find((lesson) => lesson.id === responseLessonId)?.understood ?? false;
  const reference = result?.response.sourceNotes.find((source) => source.filePath);
  const runCheck = async (): Promise<void> => {
    setChecking(true);
    try { setCheckOutput(await onRunCheck()); }
    catch (error) { setCheckOutput(error instanceof Error ? error.message : 'Check failed.'); }
    finally { setChecking(false); }
  };
  const [tab, setTab] = useState<'tutor' | 'history' | 'progress' | 'teaching' | 'git'>('tutor');
  const [historyQuery, setHistoryQuery] = useState('');
  function focusExplainBack(): void {
    const box = document.querySelector<HTMLElement>('.learning-explain-back');
    box?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    box?.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true });
  }
  // Every word must appear somewhere in the lesson's title, file, recap or concept names.
  const historyLessons = useMemo(() => {
    const lessons = progress?.lessons ?? [];
    const words = historyQuery.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return lessons;
    return lessons.filter((lesson) => {
      const text = [lesson.response.title, lesson.filePath ?? '', lesson.response.recap, ...lesson.response.concepts.map((concept) => concept.name)].join(' ').toLowerCase();
      return words.every((word) => text.includes(word));
    });
  }, [progress?.lessons, historyQuery]);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(true);
  const assistance = progress?.preferences.assistance ?? 'guided';
  const teachingModes = progress?.preferences.teachingModes ?? [assistance];
  const inlineSuggestions = progress?.preferences.inlineSuggestions ?? false;
  const response = result?.response ?? null;
  const concepts = progress?.concepts ?? [];
  const overallScore = useMemo(() => concepts.length
    ? Math.round(concepts.reduce((total, concept) => total + concept.score, 0) / concepts.length)
    : 0, [concepts]);
  const selectionKey = selection?.text.trim()
    ? `${selection.filePath}:${selection.startLine}:${selection.startColumn}:${selection.endLine}:${selection.endColumn}`
    : '';

  useEffect(() => {
    if (selectionKey) setTab('tutor');
  }, [selectionKey]);

  useEffect(() => {
    if (result && readiness?.ready) setControlsOpen(false);
  }, [readiness?.ready, result]);

  useEffect(() => {
    if (tab !== 'tutor') return;
    const scroll = scrollRef.current;
    if (!scroll) return;
    scroll.scrollTop = scroll.scrollHeight;
  }, [tab, conversation.length, submittedQuestion, result]);

  return (
    <aside className={`learning-panel ${focus ? 'learning-focus' : ''}`} aria-label="Learning tutor">
      <div className="learning-panel-head">
        <div className="learning-title">
          <span className="learning-mark"><GraduationCap size={16} /></span>
          <div><strong>Learning Mode</strong><small>{overallScore}% local mastery signal</small></div>
        </div>
        <div className="learning-panel-head-actions">
          <button type="button" className="secondary-button learning-focus-toggle" aria-pressed={focus} onClick={() => { setFocus(!focus); setTab('tutor'); setComposerOpen(true); }}>{focus ? 'Exit focus' : 'Focus'}</button>
          <button
            type="button"
            className="icon-button compact"
            aria-label={controlsOpen ? 'Collapse learning controls' : 'Expand learning controls'}
            aria-expanded={controlsOpen}
            aria-controls="learning-controls"
            title={controlsOpen ? 'Collapse learning controls' : 'Expand learning controls'}
            onClick={() => setControlsOpen((current) => !current)}
          >
            {controlsOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          <button type="button" className="icon-button compact" aria-label="Close learning tutor" title="Close learning tutor" onClick={onClose}>
            <PanelRightClose size={14} />
          </button>
        </div>
      </div>

      {tab === 'tutor' && (
        <>
          {controlsOpen && !focus && (
            <div className="learning-controls" id="learning-controls">
              <div className="learning-assistance" role="group" aria-label="Assistance level">
                {assistanceOptions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={teachingModes.includes(option.id) ? 'active' : ''}
                    aria-pressed={teachingModes.includes(option.id)}
                    title={`${option.label}: ${option.description}. Click to combine modes.`}
                    onClick={() => {
                      const modes = teachingModes.includes(option.id) ? teachingModes.filter((mode) => mode !== option.id) : [...teachingModes, option.id];
                      if (!modes.length) return;
                      const primary = assistanceOptions.find((candidate) => modes.includes(candidate.id))!.id;
                      onPreferences(primary, primary === 'copilot' ? inlineSuggestions : false, modes);
                    }}
                  >
                    <span>{teachingModes.includes(option.id) && <CheckCircle2 size={11} aria-hidden="true" />}{option.label}</span>
                  </button>
                ))}
              </div>

              <label className="learning-inline-toggle" title="Copilot only: pause typing or press Alt + Backslash for ghost text. Tab accepts; Escape dismisses. Combined teaching modes keep completion off.">
                <input
                  type="checkbox"
                  checked={assistance === 'copilot' && inlineSuggestions}
                  disabled={assistance !== 'copilot'}
                  onChange={(event) => onPreferences(assistance, event.target.checked)}
                />
                <span>Inline suggestions</span>
              </label>

              <div className="learning-actions">
                {actionOptions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    disabled={!readiness?.ready || Boolean(busy) || (!selection && option.id !== 'next-step') || (option.id === 'complete' && assistance !== 'copilot')}
                    onClick={() => onAction(option.id)}
                    aria-label={option.label}
                    title={option.label}
                  >
                    {busy === option.id ? <LoaderCircle className="spin" size={14} /> : option.icon}
                    <span className="visually-hidden">{option.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {readiness && !readiness.ready && (
            <div className="learning-readiness" role="alert">
              <div>
                <strong>{readiness.displayName} needs attention</strong>
                <span>{readiness.reason}</span>
                {readiness.recovery && <small>{readiness.recovery}</small>}
              </div>
              <button type="button" className="secondary-button" onClick={onOpenSettings}><Settings size={13} />Settings</button>
            </div>
          )}
          {!readiness && <div className="learning-readiness neutral"><LoaderCircle className="spin" size={14} /><span>Checking tutor readiness</span></div>}
        </>
      )}

      <div className="learning-tabs" role="tablist" aria-label="Learning panel views">
        <button type="button" className={tab === 'tutor' ? 'active' : ''} role="tab" aria-selected={tab === 'tutor'} onClick={() => setTab('tutor')}><BookOpen size={13} />Tutor</button>
        <button type="button" role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>History</button>
        <button type="button" className={tab === 'progress' ? 'active' : ''} role="tab" aria-selected={tab === 'progress'} onClick={() => setTab('progress')}><GraduationCap size={13} />Progress</button>
        <button type="button" className={tab === 'teaching' ? 'active' : ''} role="tab" aria-selected={tab === 'teaching'} onClick={() => setTab('teaching')}><LibraryBig size={13} />Teaching</button>
        <button type="button" className={tab === 'git' ? 'active' : ''} role="tab" aria-selected={tab === 'git'} onClick={() => setTab('git')}><GitBranch size={13} />Git</button>
      </div>

      <div className="learning-scroll" ref={scrollRef}>
        {!focus && response && progress?.memory && <section className="learning-memory">
          <strong>Last lesson: {progress.memory.lastLesson}</strong>
          {progress.memory.filePath && <button type="button" onClick={() => onReference(progress.memory!.filePath!)}>{progress.memory.filePath}</button>}
          <p>{progress.memory.unresolvedCheck ? `Unresolved check: ${progress.memory.unresolvedCheck}` : progress.memory.understood ? 'Marked understood (self-reported).' : 'No outstanding check.'}</p>
          {progress.memory.recommendedNext && <button type="button" onClick={() => { onQuestionChange(progress.memory!.recommendedNext); setTab('tutor'); }}>Next: {progress.memory.recommendedNext}</button>}
          {!progress.memory.understood && <button type="button" disabled={Boolean(busy)} onClick={() => onUnderstood(progress.memory!.lessonId)}>Mark understood</button>}
        </section>}
        {!focus && tab === 'progress' && <section className="learning-path">
          <strong>Learning path</strong>
          <p>Practice needs first, then project structure. Independent evidence advances the queue.</p>
          {lessons.map((lesson, index) => <button key={lesson.id} type="button" onClick={() => { onQuestionChange(lesson.prompt); setTab('tutor'); }}><span>{index + 1}. {lesson.title}</span><small>{lesson.filePath ?? 'Based on learning evidence'}</small></button>)}
          {!lessons.length && <p>Scan or open a project to build your lesson queue.</p>}
        </section>}
        {checkOutput && <pre className="learning-check-output" role="status">{checkOutput}</pre>}
        {error && <div className="learning-error" role="alert">{error}</div>}
        {tab === 'tutor' && (
          <>
            {conversation.map((turn) => (
              <div className="learning-conversation-turn" key={turn.id}>
                <TutorQuestion question={turn.question} />
                <TutorContent
                  onReference={onReference}
                  response={turn.response}
                  selection={null}
                  busy={false}
                  onAction={onAction}
                  onInsertSuggestion={onInsertSuggestion}
                  canInsertSuggestion={false}
                />
              </div>
            ))}
            {submittedQuestion.trim() && <TutorQuestion question={submittedQuestion} />}
            <TutorContent
              onReference={onReference}
              response={response}
              selection={selection}
              busy={Boolean(busy)}
              onAction={onAction}
              onInsertSuggestion={onInsertSuggestion}
              onPlaceSuggestion={onPlaceSuggestion}
              onAnswerQuestion={responseLessonId ? focusExplainBack : undefined}
              canInsertSuggestion
            />
            {appliedSuggestionNeedsExplanation && <section className="learning-applied-suggestion-nudge" role="status">
              <div><BrainCircuit size={14} /><strong>You applied Tutor code</strong></div>
              <p>Before moving on, explain in your own words what it does and why it belongs here. KAI will use your explanation as learning evidence.</p>
              <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={onExplainAppliedSuggestion}>Explain it back</button>
            </section>}
          </>
        )}
        {response && tab === 'tutor' && <div className="learning-response-actions">
          {reference?.filePath && <>
            <button type="button" onClick={() => onReference(reference.filePath!)}>Open referenced file</button>
            {reference.startLine && <button type="button" onClick={() => onReference(reference.filePath!, reference.startLine, reference.endLine)}>Select lines</button>}
          </>}
          <button type="button" disabled={checking || Boolean(busy)} onClick={() => void runCheck()}>{checking ? 'Running check...' : 'Run check'}</button>
        </div>}
        {response && tab === 'tutor' && responseLessonId && (
          <ExplainBack
            key={responseLessonId}
            lessonId={responseLessonId}
            question={explainBackQuestion(response)}
            previous={progress?.lessons?.find((lesson) => lesson.id === responseLessonId)?.explainBack ?? null}
            understood={responseUnderstood}
            disabled={Boolean(busy)}
            onExplainBack={onExplainBack}
            onExplainBackHelp={onExplainBackHelp}
            onSkip={() => onUnderstood(responseLessonId)}
          />
        )}
        {tab === 'history' && <section className="learning-history">
          <strong>Lesson history</strong><p>The last {MAX_SAVED_LESSONS} lessons for this project, newest first.</p>
          {!(progress?.lessons?.length) && <p>Your lessons will appear here after a tutor response.</p>}
          {(progress?.lessons?.length ?? 0) > 5 && (
            <label className="input-with-icon learning-history-search">
              <Search size={13} />
              <input value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder="Search lessons by title, file or topic" aria-label="Search lessons" />
            </label>
          )}
          {historyQuery.trim() && historyLessons.length === 0 && <p>No lesson matches “{historyQuery.trim()}”.</p>}
          {historyLessons.map((lesson) => <button key={lesson.id} type="button" disabled={Boolean(busy)} onClick={() => { onLessonSelect(lesson); setTab('tutor'); }}>
            <strong>{lesson.response.title}</strong>
            <small>{new Date(lesson.createdAt).toLocaleString()} - {lesson.filePath ?? 'Whole project'}</small>
            <span>{lesson.explainBack?.verdict === 'solid'
              ? 'Explained it back'
              : lesson.understood
                ? 'Understood (self-reported)'
                : lesson.explainBack
                  ? 'Explain it back again'
                  : 'Review lesson'}</span>
          </button>)}
        </section>}
        {tab === 'progress' && <ProgressContent progress={progress} />}
        {tab === 'teaching' && (
          <TeachingLibraryPanel
            library={teachingLibrary}
            busy={teachingBusy}
            onSave={onSaveTeachingEntry}
            onDelete={onDeleteTeachingEntry}
            onReset={onResetTeachingEntry}
            onGenerate={onGenerateTeachingDraft}
          />
        )}
        {tab === 'git' && <GitContent info={gitInfo} />}
      </div>
      {tab === 'tutor' && (
        <TutorComposer
          question={question}
          submittedQuestion={submittedQuestion}
          busy={Boolean(busy)}
          selection={selection}
          response={Boolean(response)}
          scope={scope}
          open={focus || composerOpen}
          onToggle={() => setComposerOpen((current) => !current)}
          onScopeChange={onScopeChange}
          onQuestionChange={onQuestionChange}
          onAction={onAction}
          onStuck={onStuck}
          hintLevel={hintLevel}
          onRecordLesson={onRecordLesson}
        />
      )}
    </aside>
  );
}

function TutorContent({
  onReference,
  response,
  selection,
  busy,
  onAction,
  onInsertSuggestion,
  onPlaceSuggestion,
  onAnswerQuestion,
  canInsertSuggestion = true,
}: {
  onReference: LearningPanelProps['onReference'];
  response: LearningEvaluationResult['response'] | null;
  selection: LearningSelectionPreview | null;
  busy: boolean;
  onAction: (action: LearningAction) => void;
  onInsertSuggestion: () => void;
  onPlaceSuggestion?: () => void;
  /** Takes the learner to the Explain it back box, where the follow-up question can be answered. */
  onAnswerQuestion?: () => void;
  canInsertSuggestion?: boolean;
}): ReactNode {
  const [copied, setCopied] = useState(false);
  if (!response) {
    return null;
  }
  const nextStep = response.steps[0];
  const remainingSteps = response.steps.slice(1);
  const suggestedLocation = response.suggestion
    ? suggestionTarget([response.suggestion.explanation, nextStep.explanation], response.sourceNotes)
    : null;
  const applyLabel = response.suggestion?.replaceSelection && selection?.text.trim()
    ? 'Apply to selected code'
    : 'Insert at cursor';
  const placement = onPlaceSuggestion ? response.suggestion?.placement : undefined;
  const placementFile = placement?.filePath.split(/[\\/]/).at(-1);
  const placementLine = placement?.anchor.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  const placementWhere = placement ? { before: 'before', after: 'after', replace: 'in place of' }[placement.position] : '';
  const copySuggestion = async (): Promise<void> => {
    if (!response.suggestion || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(response.suggestion.code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="learning-response">
      {selection?.text.trim() && <SelectionContext selection={selection} busy={busy} onAction={onAction} />}
      <header>
        <span className="learning-mastery introduced">Tutor response</span>
        <h2>{response.title}</h2>
      </header>
      <p className="learning-answer">{response.recap}</p>
      <section className="learning-next-action" aria-label="Do this next">
        <div><Target size={15} /><span>Do this next</span></div>
        {nextStep.title !== 'Do this next' && <strong>{nextStep.title}</strong>}
        <p>{nextStep.explanation}</p>
        {response.checks[0] && <small><CheckCircle2 size={13} />Done when: {response.checks[0]}</small>}
      </section>
      {response.suggestion && (
        <div className="learning-suggestion">
          <div><Sparkles size={14} /><strong>Code to type</strong></div>
          <p>{response.suggestion.explanation}</p>
          <pre><code>{response.suggestion.code}</code></pre>
          <small className="learning-suggestion-target">
            {placement
              ? <>Goes in <strong>{placement.filePath}</strong>, {placementWhere} <code>{placementLine}</code>. Typing it yourself is the better way to learn it.</>
              : response.suggestion.replaceSelection && selection?.text.trim()
                ? 'Insert replaces the selected code. Typing it yourself is the better way to learn it.'
                : 'Insert puts it at your cursor. Typing it yourself is the better way to learn it.'}
          </small>
          <div className="learning-question-actions">
            <button type="button" className="secondary-button" onClick={() => void copySuggestion()}><Copy size={13} />{copied ? 'Copied' : 'Copy code'}</button>
            {!placement && suggestedLocation && <button type="button" className="secondary-button" title={`Opens ${suggestedLocation.filePath}`} onClick={() => onReference(suggestedLocation.filePath, suggestedLocation.startLine, suggestedLocation.endLine)}><FileCode2 size={13} />Open {suggestedLocation.filePath.split('/').at(-1)}</button>}
            {canInsertSuggestion && placement && <button type="button" className="primary-button" title={`Opens ${placement.filePath} and puts the code ${placementWhere} the line the tutor named`} onClick={onPlaceSuggestion}><WandSparkles size={13} />Insert in {placementFile}</button>}
            {canInsertSuggestion && <button type="button" className={placement ? 'secondary-button' : 'primary-button'} onClick={onInsertSuggestion}>{!placement && <WandSparkles size={13} />}{applyLabel}</button>}
          </div>
        </div>
      )}
      {response.followUpQuestion && (onAnswerQuestion
        ? <button type="button" className="learning-question answerable" title="Answer this in Explain it back below" onClick={onAnswerQuestion}><Lightbulb size={14} /><span>{response.followUpQuestion}</span><small>Answer below</small></button>
        : <div className="learning-question"><Lightbulb size={14} /><span>{response.followUpQuestion}</span></div>)}
      <LearningSection title="Why this matters" className="analogy" collapsible defaultOpen={false}>
        <p>{response.purpose}</p>
        <p><strong>{response.analogy.title}:</strong> {response.analogy.explanation}</p>
        {response.analogy.mappings.length > 0 && (
          <dl>
            {response.analogy.mappings.map((mapping, index) => (
              <div key={`${mapping.analogyPart}-${index}`}>
                <dt>{mapping.analogyPart} <span>→ {mapping.codePart}</span></dt>
                <dd>{mapping.explanation}</dd>
              </div>
            ))}
          </dl>
        )}
        <p className="learning-limits"><strong>Where it stops:</strong> {response.analogy.limits}</p>
      </LearningSection>
      {remainingSteps.length > 0 && (
        <LearningSection title="How it works" collapsible defaultOpen={false}>
          <ol className="learning-steps">
            {remainingSteps.map((step, index) => <li key={`${step.title}-${index}`}><strong>{step.title}</strong><span>{step.explanation}</span></li>)}
          </ol>
        </LearningSection>
      )}
      {response.codePreview.trim() && (
        <LearningSection title="Code preview" collapsible defaultOpen={false}><pre className="learning-code"><code>{response.codePreview}</code></pre></LearningSection>
      )}
      {response.lineByLine.length > 0 && (
        <LearningSection title="Line by line" collapsible defaultOpen={false}>
          <div className="learning-lines">
            {response.lineByLine.map((item, index) => <div key={`${item.line}-${index}`}><code>{item.line}</code><span>{item.explanation}</span></div>)}
          </div>
        </LearningSection>
      )}
      {response.checks.length > 1 && (
        <LearningSection title="Check your understanding" collapsible defaultOpen={false}>
          <ul className="learning-checks">{response.checks.slice(1).map((check, index) => <li key={`${check}-${index}`}><CheckCircle2 size={13} />{check}</li>)}</ul>
        </LearningSection>
      )}
      {response.concepts.length > 0 && (
        <LearningSection title="Concepts" collapsible defaultOpen={false}>
          <div className="learning-concept-chips">{response.concepts.map((concept) => <span key={`${concept.category}-${concept.name}`} className={`learning-mastery ${concept.mastery}`}>{concept.name}</span>)}</div>
        </LearningSection>
      )}
      {response.sourceNotes.length > 0 && (
        <LearningSection title="Sources" collapsible defaultOpen={false}>
          <ul className="learning-sources">{response.sourceNotes.map((source, index) => <li key={`${source.label}-${index}`}>{source.filePath ? <button type="button" onClick={() => onReference(source.filePath!, source.startLine, source.endLine)}>{source.label} - {source.filePath}{source.startLine ? `:${source.startLine}${source.endLine ? `-${source.endLine}` : ''}` : ''}</button> : source.url && /^https?:\/\//i.test(source.url) ? <a href={source.url} target="_blank" rel="noreferrer">{source.label}</a> : source.label}</li>)}</ul>
        </LearningSection>
      )}
    </div>
  );
}

function ExplainBack({
  lessonId,
  question,
  previous,
  understood,
  disabled,
  onExplainBack,
  onExplainBackHelp,
  onSkip,
}: {
  lessonId: string;
  question: string;
  previous: { verdict: LearningExplainBackGrade['verdict']; feedback: string } | null;
  understood: boolean;
  disabled: boolean;
  onExplainBack: LearningPanelProps['onExplainBack'];
  onExplainBackHelp: LearningPanelProps['onExplainBackHelp'];
  onSkip: () => void;
}): ReactNode {
  const [answer, setAnswer] = useState('');
  const [checking, setChecking] = useState(false);
  const [grade, setGrade] = useState<LearningExplainBackGrade | null>(null);
  // The question being answered now: the tutor's, a simpler wording of it, or a follow-up after a shown answer.
  const [asked, setAsked] = useState(question);
  const [help, setHelp] = useState<{ kind: LearningExplainBackHelpKind; explanation: string } | null>(null);
  const [helping, setHelping] = useState<LearningExplainBackHelpKind | null>(null);
  const shown = grade ?? (previous ? { ...previous, gap: '' } : null);
  const solid = shown?.verdict === 'solid';
  const submit = async (): Promise<void> => {
    if (!answer.trim() || checking) return;
    setChecking(true);
    try {
      const result = await onExplainBack(lessonId, asked, answer.trim());
      if (result) setGrade(result);
    } finally {
      setChecking(false);
    }
  };
  const askForHelp = async (kind: LearningExplainBackHelpKind): Promise<void> => {
    if (helping) return;
    setHelping(kind);
    try {
      const result = await onExplainBackHelp(lessonId, asked, kind);
      if (!result) return;
      setHelp({ kind, explanation: result.explanation });
      setAsked(result.question);
      setGrade(null);
    } finally {
      setHelping(null);
    }
  };
  const answerShown = help?.kind === 'answer';
  return (
    <section className={`learning-explain-back ${shown ? shown.verdict : ''}`} aria-label="Explain it back">
      <div><BrainCircuit size={14} /><strong>Explain it back</strong></div>
      <p className="learning-explain-back-question">{asked}</p>
      {help && (
        <div className={`learning-explain-back-help ${help.kind}`} role="status">
          <strong>{answerShown ? 'The answer' : 'Hint'}</strong>
          <p>{help.explanation}</p>
          {answerShown && <small>Seeing the answer does not count toward mastery. Say the key idea back in your own words below, and that will.</small>}
        </div>
      )}
      {shown && (
        <div className="learning-explain-back-grade" role="status">
          <strong>{explainBackVerdicts[shown.verdict]}</strong>
          <p>{shown.feedback}</p>
          {shown.gap && <p><b>Revisit:</b> {shown.gap}</p>}
        </div>
      )}
      {!solid && (
        <>
          <textarea
            aria-label="Your explanation"
            value={answer}
            placeholder="Answer in your own words. A sentence or two is enough."
            rows={3}
            disabled={checking}
            onChange={(event) => setAnswer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <div className="learning-question-actions">
            <button type="button" className="secondary-button" disabled={disabled || checking || helping !== null} onClick={() => void askForHelp('rephrase')} title="The tutor asks it again in simpler words, with a hint">
              {helping === 'rephrase' ? <LoaderCircle className="spin" size={13} /> : <HelpCircle size={13} />}
              <span>I don't get the question</span>
            </button>
            {!answerShown && (
              <button type="button" className="secondary-button" disabled={disabled || checking || helping !== null} onClick={() => void askForHelp('answer')} title="Shows a model answer and why; it does not count toward mastery">
                {helping === 'answer' ? <LoaderCircle className="spin" size={13} /> : <Eye size={13} />}
                <span>Show me the answer</span>
              </button>
            )}
            {!understood && <button type="button" className="secondary-button" disabled={disabled || checking} onClick={onSkip} title="Records a self-report only; it does not raise mastery.">Skip, mark understood</button>}
            <button type="button" className="primary-button" disabled={disabled || checking || !answer.trim()} onClick={() => void submit()}>
              {checking ? <LoaderCircle className="spin" size={13} /> : <Send size={13} />}
              <span>{checking ? 'Checking...' : shown ? 'Try again' : 'Check my answer'}</span>
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function SelectionContext({
  selection,
  busy,
  onAction,
}: {
  selection: LearningSelectionPreview | null;
  busy: boolean;
  onAction: (action: LearningAction) => void;
}): ReactNode {
  if (!selection) return null;
  const selected = selection.text.trim().length > 0;
  return (
    <section className={`learning-selection-context ${selected ? 'attached' : ''}`} aria-live="polite">
      <header>
        <div><FileCode2 size={14} /><strong>{selected ? 'Selected code' : 'Current file'}</strong></div>
        <span>{selected ? 'Attached' : 'No selection'}</span>
      </header>
      <div className="learning-selection-meta">
        <code title={selection.filePath}>{selection.filePath}</code>
        <small>{formatSelectionRange(selection, selected)}</small>
      </div>
      {selected ? <pre><code>{selection.text}</code></pre> : <p>No selection attached.</p>}
      {selected && (
        <button type="button" className="secondary-button learning-selection-action" disabled={busy} onClick={() => onAction('explain-selection')}>
          <Code2 size={13} />Explain selection
        </button>
      )}
    </section>
  );
}

function TutorComposer({
  question,
  submittedQuestion,
  busy,
  selection,
  response,
  scope,
  open,
  onToggle,
  onScopeChange,
  onQuestionChange,
  onAction,
  onStuck,
  hintLevel,
  onRecordLesson,
}: {
  question: string;
  submittedQuestion: string;
  busy: boolean;
  selection: LearningSelectionPreview | null;
  response: boolean;
  scope: LearningTutorScope;
  open: boolean;
  onToggle: () => void;
  onScopeChange: (scope: LearningTutorScope) => void;
  onQuestionChange: (value: string) => void;
  onAction: (action: LearningAction) => void;
  onStuck: () => void;
  hintLevel: number;
  onRecordLesson?: () => void;
}): ReactNode {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [progressTick, setProgressTick] = useState(0);
  useEffect(() => {
    if (!busy) {
      setProgressTick(0);
      return;
    }
    const timer = window.setInterval(() => setProgressTick((current) => current + 1), 3_500);
    return () => window.clearInterval(timer);
  }, [busy]);
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const resize = (): void => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(input.parentElement!);
    return () => observer.disconnect();
  }, [question, open]);
  const selected = Boolean(selection?.text.trim());
  const fileLabel = selection
    ? `${selection.filePath.split('/').at(-1) ?? selection.filePath} - ${formatSelectionRange(selection, selected)}`
    : 'No file open';
  const scopeName = scope === 'auto' ? 'Auto' : 'Whole project';
  const contextLabel = scope !== 'active-file'
    ? selection
      ? `${scopeName} · ${fileLabel}`
      : scopeName
    : selection
      ? fileLabel
      : 'Open a file to use file context';
  const placeholder = scope !== 'active-file'
    ? selected
      ? 'Ask about the selected code or the whole project...'
      : 'Ask about the whole project...'
    : selected
      ? 'Ask about the selected code...'
      : 'Ask about this file...';
  return (
    <div className={`learning-composer ${response ? 'follow-up' : 'initial'} ${open ? '' : 'collapsed'}`}>
      <header>
        <div><Sparkles size={14} /><strong>{response ? 'Follow up' : 'Tutor prompt'}</strong></div>
        <div className="learning-composer-heading-actions">
          <label className="learning-composer-scope">
            <FolderTree size={13} aria-hidden="true" />
            <span className="visually-hidden">Tutor context scope</span>
            <select
              aria-label="Tutor context scope"
              value={scope}
              title="Auto starts from the open file and searches the project for your question"
              onChange={(event) => onScopeChange(event.target.value === 'active-file' || event.target.value === 'project' ? event.target.value : 'auto')}
            >
              <option value="auto">Auto</option>
              <option value="project">Whole project</option>
              <option value="active-file">File context</option>
            </select>
          </label>
          <button
            type="button"
            className="icon-button compact"
            aria-label={open ? 'Collapse tutor composer' : 'Expand tutor composer'}
            aria-expanded={open}
            aria-controls="learning-composer-body"
            title={open ? 'Collapse tutor composer' : 'Expand tutor composer'}
            onClick={onToggle}
          >
            {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </button>
        </div>
      </header>
      {open && (
        <div className="learning-composer-body" id="learning-composer-body">
          <textarea
            ref={inputRef}
            aria-label="Tutor question"
            value={question}
            onChange={(event) => onQuestionChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                if (!busy && !(scope === 'active-file' && !selection)) onAction('next-step');
              }
            }}
            placeholder={placeholder}
            rows={1}
          />
          {busy && <TutorProcessing tick={progressTick} />}
          <footer>
            <span title={selection?.filePath ?? undefined}>{contextLabel} · Enter to ask · Shift+Enter for a new line</span>
            <div>
              <button type="button" className="secondary-button" disabled={busy || hintLevel >= 3 || (scope === 'active-file' && !selection)} onClick={onStuck} title={stuckHints[Math.min(hintLevel, 3)]!.title}><Lightbulb size={13} />{stuckHints[Math.min(hintLevel, 3)]!.label}</button>
              {response && onRecordLesson && (
                <button type="button" className="secondary-button" disabled={busy} onClick={onRecordLesson}><Save size={13} />Record lesson</button>
              )}
              <button type="button" className="primary-button" disabled={busy || (scope === 'active-file' && !selection)} onClick={() => onAction('next-step')}>
                {busy ? <LoaderCircle className="spin" size={13} /> : <Send size={13} />}
                <span>{busy ? 'Working...' : response ? 'Ask' : 'Ask tutor'}</span>
              </button>
            </div>
          </footer>
        </div>
      )}
    </div>
  );
}

function formatSelectionRange(selection: LearningSelectionPreview, selected: boolean): string {
  if (!selected) return `Line ${selection.startLine}`;
  return selection.startLine === selection.endLine
    ? `L${selection.startLine}:${selection.startColumn}-${selection.endColumn}`
    : `L${selection.startLine}:${selection.startColumn}-L${selection.endLine}:${selection.endColumn}`;
}

function ProgressContent({ progress }: { progress: LearningProgress | null }): ReactNode {
  const concepts = progress?.concepts ?? [];
  if (!concepts.length) {
    return <div className="learning-empty"><span><GraduationCap size={20} /></span><strong>No learning evidence yet</strong><p>Progress appears after you explain code, check your work, or investigate an error.</p></div>;
  }
  return (
    <div className="learning-progress-list">
      {concepts.map((concept) => (
        <article key={concept.id} className="learning-progress-item">
          <div className="learning-progress-head"><div><strong>{concept.name}</strong><small>{concept.category}</small></div><span className={`learning-mastery ${concept.mastery}`}>{masteryLabel(concept.mastery)}</span></div>
          <div className="learning-score" aria-label={`${concept.score} percent mastery signal`}><span style={{ width: `${concept.score}%` }} /></div>
          <p>{concept.nextStep}</p>
          <small>{concept.evidenceCount} evidence item{concept.evidenceCount === 1 ? '' : 's'}</small>
        </article>
      ))}
    </div>
  );
}

function GitContent({ info }: { info: GitFileInfo | null }): ReactNode {
  if (!info) return <div className="learning-empty"><LoaderCircle className="spin" size={18} /><strong>Reading Git status</strong></div>;
  return (
    <div className="learning-git">
      <div className="learning-git-head"><div><GitBranch size={15} /><span>{info.isRepository ? `Working tree: ${info.status}` : 'This project is not a Git repository'}</span></div></div>
      {info.entries.length > 0 ? (
        <ol className="learning-history">
          {info.entries.map((entry) => <li key={entry.hash}><div><code>{entry.shortHash}</code><span>{entry.subject}</span></div><small>{entry.author} · {formatDate(entry.date)}</small></li>)}
        </ol>
      ) : <div className="learning-empty compact"><GitBranch size={18} /><strong>No file history</strong><p>{info.isRepository ? 'This file has no commits yet.' : 'Initialise Git to see file history and blame-style context.'}</p></div>}
    </div>
  );
}

function LearningSection({
  title,
  className = '',
  collapsible = false,
  defaultOpen = true,
  children,
}: {
  title: string;
  className?: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
}): ReactNode {
  const [open, setOpen] = useState(defaultOpen);
  if (!collapsible) return <section className={`learning-section ${className}`}><h3>{title}</h3>{children}</section>;
  return (
    <section className={`learning-section ${className} ${open ? 'open' : 'collapsed'}`}>
      <button type="button" className="learning-section-toggle" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <span className="learning-section-title">{title}</span>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {open && <div className="learning-section-body">{children}</div>}
    </section>
  );
}

function masteryLabel(mastery: LearningMastery): string {
  return mastery.replace('-', ' ').replace(/\b\w/g, (value) => value.toUpperCase());
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : value;
}


function TutorProcessing({ tick }: { tick: number }): ReactNode {
  const messages = [
    'Reading your project context...',
    'Finding the most useful next step...',
    'Why do programmers prefer dark mode? Light attracts bugs.',
    'Turning the project scan into an answer...',
    'A byte walks into a bar. The bartender asks: parity or no parity?',
    'Still working — the answer is on its way.',
  ];
  return (
    <div className="learning-composer-processing" role="status" aria-live="polite">
      <LoaderCircle className="spin" size={15} />
      <div>
        <span>{messages[tick % messages.length]}</span>
        <small>{tick * 3.5}s elapsed</small>
      </div>
    </div>
  );
}

function TutorQuestion({ question }: { question: string }): ReactNode {
  return (
    <article className="learning-chat-question" aria-label="Your tutor question">
      <small>You</small>
      <p>{question}</p>
    </article>
  );
}
