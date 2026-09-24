import {
  BookOpen,
  BrainCircuit,
  CheckCircle2,
  Code2,
  FileCode2,
  GitBranch,
  GraduationCap,
  Lightbulb,
  ListChecks,
  LibraryBig,
  LoaderCircle,
  PanelRightClose,
  Play,
  Save,
  Send,
  Settings,
  Sparkles,
  WandSparkles,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import type {
  GitFileInfo,
  LearningAction,
  LearningAssistance,
  LearningEvaluationResult,
  LearningMastery,
  LearningProgress,
  LearningReadiness,
  TeachingDraft,
  TeachingDraftGenerateInput,
  TeachingLibrary,
  TeachingLibraryEntryInput,
  TeachingLibrarySaveInput,
} from '@kai/contracts';
import { TeachingLibraryPanel } from './TeachingLibraryPanel';

interface LearningPanelProps {
  progress: LearningProgress | null;
  readiness: LearningReadiness | null;
  result: LearningEvaluationResult | null;
  gitInfo: GitFileInfo | null;
  busy: LearningAction | 'record' | null;
  formatting: boolean;
  error: string | null;
  question: string;
  onQuestionChange: (value: string) => void;
  onAction: (action: LearningAction) => void;
  onPreferences: (assistance: LearningAssistance, inlineSuggestions: boolean) => void;
  onInsertSuggestion: () => void;
  onRecordLesson: () => void;
  onFormat: () => void;
  teachingLibrary: TeachingLibrary | null;
  teachingBusy: string | null;
  onSaveTeachingEntry: (input: TeachingLibrarySaveInput) => Promise<void>;
  onDeleteTeachingEntry: (input: TeachingLibraryEntryInput) => Promise<void>;
  onResetTeachingEntry: (input: TeachingLibraryEntryInput) => Promise<void>;
  onGenerateTeachingDraft: (input: TeachingDraftGenerateInput) => Promise<TeachingDraft>;
  onOpenSettings: () => void;
  onClose: () => void;
}

const assistanceOptions: Array<{ id: LearningAssistance; label: string }> = [
  { id: 'learn', label: 'Learn' },
  { id: 'guided', label: 'Guided' },
  { id: 'pair', label: 'Pair' },
  { id: 'copilot', label: 'Copilot' },
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

export function LearningPanel({
  progress,
  readiness,
  result,
  gitInfo,
  busy,
  formatting,
  error,
  question,
  onQuestionChange,
  onAction,
  onPreferences,
  onInsertSuggestion,
  onRecordLesson,
  onFormat,
  teachingLibrary,
  teachingBusy,
  onSaveTeachingEntry,
  onDeleteTeachingEntry,
  onResetTeachingEntry,
  onGenerateTeachingDraft,
  onOpenSettings,
  onClose,
}: LearningPanelProps): ReactNode {
  const [tab, setTab] = useState<'tutor' | 'progress' | 'teaching' | 'git'>('tutor');
  const assistance = progress?.preferences.assistance ?? 'guided';
  const inlineSuggestions = progress?.preferences.inlineSuggestions ?? false;
  const response = result?.response ?? null;
  const concepts = progress?.concepts ?? [];
  const overallScore = useMemo(() => concepts.length
    ? Math.round(concepts.reduce((total, concept) => total + concept.score, 0) / concepts.length)
    : 0, [concepts]);

  return (
    <aside className="learning-panel" aria-label="Learning tutor">
      <div className="learning-panel-head">
        <div className="learning-title">
          <span className="learning-mark"><GraduationCap size={16} /></span>
          <div><strong>Learning Mode</strong><small>{overallScore}% local mastery signal</small></div>
        </div>
        <button type="button" className="icon-button compact" aria-label="Close learning tutor" title="Close learning tutor" onClick={onClose}>
          <PanelRightClose size={14} />
        </button>
      </div>

      <div className="learning-assistance" role="group" aria-label="Assistance level">
        {assistanceOptions.map((option) => (
          <button
            key={option.id}
            type="button"
            className={assistance === option.id ? 'active' : ''}
            aria-pressed={assistance === option.id}
            onClick={() => onPreferences(option.id, option.id === 'copilot' ? inlineSuggestions : false)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <label className="learning-inline-toggle">
        <input
          type="checkbox"
          checked={assistance === 'copilot' && inlineSuggestions}
          disabled={assistance !== 'copilot'}
          onChange={(event) => onPreferences(assistance, event.target.checked)}
        />
        <span>Inline suggestions</span>
      </label>

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

      <div className="learning-actions">
        {actionOptions.map((option) => (
          <button
            key={option.id}
            type="button"
            disabled={!readiness?.ready || Boolean(busy) || (option.id === 'complete' && assistance !== 'copilot')}
            onClick={() => onAction(option.id)}
            title={option.label}
          >
            {busy === option.id ? <LoaderCircle className="spin" size={14} /> : option.icon}
            <span>{option.label}</span>
          </button>
        ))}
      </div>

      <div className="learning-tabs" role="tablist" aria-label="Learning panel views">
        <button type="button" className={tab === 'tutor' ? 'active' : ''} role="tab" aria-selected={tab === 'tutor'} onClick={() => setTab('tutor')}><BookOpen size={13} />Tutor</button>
        <button type="button" className={tab === 'progress' ? 'active' : ''} role="tab" aria-selected={tab === 'progress'} onClick={() => setTab('progress')}><GraduationCap size={13} />Progress</button>
        <button type="button" className={tab === 'teaching' ? 'active' : ''} role="tab" aria-selected={tab === 'teaching'} onClick={() => setTab('teaching')}><LibraryBig size={13} />Teaching</button>
        <button type="button" className={tab === 'git' ? 'active' : ''} role="tab" aria-selected={tab === 'git'} onClick={() => setTab('git')}><GitBranch size={13} />Git</button>
      </div>

      <div className="learning-scroll">
        {error && <div className="learning-error" role="alert">{error}</div>}
        {tab === 'tutor' && (
          <TutorContent
            response={response}
            question={question}
            busy={Boolean(busy)}
            onQuestionChange={onQuestionChange}
            onAction={onAction}
            onInsertSuggestion={onInsertSuggestion}
            onRecordLesson={onRecordLesson}
          />
        )}
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
        {tab === 'git' && <GitContent info={gitInfo} formatting={formatting} onFormat={onFormat} />}
      </div>
    </aside>
  );
}

function TutorContent({
  response,
  question,
  busy,
  onQuestionChange,
  onAction,
  onInsertSuggestion,
  onRecordLesson,
}: {
  response: LearningEvaluationResult['response'] | null;
  question: string;
  busy: boolean;
  onQuestionChange: (value: string) => void;
  onAction: (action: LearningAction) => void;
  onInsertSuggestion: () => void;
  onRecordLesson: () => void;
}): ReactNode {
  if (!response) {
    return (
      <div className="learning-empty">
        <span><Sparkles size={20} /></span>
        <strong>Start with a small question</strong>
        <p>Ask about the selection, request a hint, or check the code you have written.</p>
        <textarea value={question} onChange={(event) => onQuestionChange(event.target.value)} placeholder="What are you trying to understand?" rows={3} />
        <button type="button" className="primary-button" disabled={busy} onClick={() => onAction('next-step')}><Send size={13} />Ask tutor</button>
      </div>
    );
  }
  return (
    <div className="learning-response">
      <header>
        <span className="learning-mastery introduced">Tutor response</span>
        <h2>{response.title}</h2>
      </header>
      <LearningSection title="Recap">{response.recap}</LearningSection>
      <LearningSection title="Purpose">{response.purpose}</LearningSection>
      <LearningSection title={response.analogy.title} className="analogy">
        <p>{response.analogy.explanation}</p>
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
      <LearningSection title="Teaching steps">
        <ol className="learning-steps">
          {response.steps.map((step, index) => <li key={`${step.title}-${index}`}><strong>{step.title}</strong><span>{step.explanation}</span></li>)}
        </ol>
      </LearningSection>
      {response.codePreview.trim() && (
        <LearningSection title="Code preview"><pre className="learning-code"><code>{response.codePreview}</code></pre></LearningSection>
      )}
      {response.lineByLine.length > 0 && (
        <LearningSection title="Line by line">
          <div className="learning-lines">
            {response.lineByLine.map((item, index) => <div key={`${item.line}-${index}`}><code>{item.line}</code><span>{item.explanation}</span></div>)}
          </div>
        </LearningSection>
      )}
      {response.checks.length > 0 && (
        <LearningSection title="Check your understanding">
          <ul className="learning-checks">{response.checks.map((check, index) => <li key={`${check}-${index}`}><CheckCircle2 size={13} />{check}</li>)}</ul>
        </LearningSection>
      )}
      {response.concepts.length > 0 && (
        <LearningSection title="Concepts">
          <div className="learning-concept-chips">{response.concepts.map((concept) => <span key={`${concept.category}-${concept.name}`} className={`learning-mastery ${concept.mastery}`}>{concept.name}</span>)}</div>
        </LearningSection>
      )}
      {response.followUpQuestion && <div className="learning-question"><Lightbulb size={14} /><span>{response.followUpQuestion}</span></div>}
      <div className="learning-question-box">
        <textarea value={question} onChange={(event) => onQuestionChange(event.target.value)} placeholder="Answer the tutor or ask a follow-up" rows={3} />
        <div className="learning-question-actions">
          <button type="button" className="secondary-button" onClick={onRecordLesson}><Save size={13} />Record lesson</button>
          <button type="button" className="primary-button" disabled={busy} onClick={() => onAction('next-step')}><Send size={13} />Ask</button>
        </div>
      </div>
      {response.suggestion && (
        <div className="learning-suggestion">
          <div><Sparkles size={14} /><strong>Suggested change</strong></div>
          <p>{response.suggestion.explanation}</p>
          <pre><code>{response.suggestion.code}</code></pre>
          <div className="learning-question-actions">
            <button type="button" className="primary-button" onClick={onInsertSuggestion}><WandSparkles size={13} />Insert suggestion</button>
          </div>
        </div>
      )}
      {response.sourceNotes.length > 0 && (
        <LearningSection title="Sources">
          <ul className="learning-sources">{response.sourceNotes.map((source, index) => <li key={`${source.label}-${index}`}>{source.url ? <a href={source.url} target="_blank" rel="noreferrer">{source.label}</a> : source.label}</li>)}</ul>
        </LearningSection>
      )}
    </div>
  );
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

function GitContent({ info, formatting, onFormat }: { info: GitFileInfo | null; formatting: boolean; onFormat: () => void }): ReactNode {
  if (!info) return <div className="learning-empty"><LoaderCircle className="spin" size={18} /><strong>Reading Git status</strong></div>;
  return (
    <div className="learning-git">
      <div className="learning-git-head"><div><GitBranch size={15} /><span>{info.isRepository ? `Working tree: ${info.status}` : 'This project is not a Git repository'}</span></div><button type="button" className="secondary-button" disabled={formatting} onClick={onFormat}>{formatting ? <LoaderCircle className="spin" size={13} /> : <Code2 size={13} />}Format</button></div>
      {info.entries.length > 0 ? (
        <ol className="learning-history">
          {info.entries.map((entry) => <li key={entry.hash}><div><code>{entry.shortHash}</code><span>{entry.subject}</span></div><small>{entry.author} · {formatDate(entry.date)}</small></li>)}
        </ol>
      ) : <div className="learning-empty compact"><GitBranch size={18} /><strong>No file history</strong><p>{info.isRepository ? 'This file has no commits yet.' : 'Initialise Git to see file history and blame-style context.'}</p></div>}
    </div>
  );
}

function LearningSection({ title, className = '', children }: { title: string; className?: string; children: ReactNode }): ReactNode {
  return <section className={`learning-section ${className}`}><h3>{title}</h3>{children}</section>;
}

function masteryLabel(mastery: LearningMastery): string {
  return mastery.replace('-', ' ').replace(/\b\w/g, (value) => value.toUpperCase());
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : value;
}
