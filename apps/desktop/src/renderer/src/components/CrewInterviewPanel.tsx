import { ArrowLeft, Play } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { CREW_INTERVIEW_TEMPLATES, CREW_INTERVIEW_TOPICS, type CrewInterview, type CrewInterviewItem } from '@kai/contracts';
import type { InterviewAnswer } from '../crew-brief';
import { UiButton } from './UiButton';
import { UiTextInput } from './UiTextInput';

/**
 * The few questions before a crew plans. It shows what the Lead understood, asks only what it could not tell, says why
 * it is asking, and lists what it chose not to ask with the reason and a way to ask anyway. Nothing is skipped quietly,
 * and every question can be left to the crew.
 */
export function CrewInterviewPanel({ interview, busy, onStart, onSkip, onBack }: {
  interview: CrewInterview;
  busy: boolean;
  onStart: (answers: InterviewAnswer[]) => void;
  onSkip: () => void;
  onBack: () => void;
}): ReactNode {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [added, setAdded] = useState<CrewInterviewItem[]>([]);
  const items = [...interview.items, ...added];
  const left = interview.left.filter((item) => !added.some((extra) => extra.topic === item.topic));

  function askAnyway(topic: CrewInterviewItem['topic']): void {
    const template = CREW_INTERVIEW_TEMPLATES[topic];
    setAdded((current) => [...current, { id: `extra-${topic}`, topic, question: template.question, why: template.why, options: template.options }]);
  }

  return (
    <section className="ops-panel crew-interview" aria-label="Before the crew plans">
      <h2>Before the crew plans</h2>
      {interview.summary && <p className="crew-interview-summary"><strong>What I understood:</strong> {interview.summary}</p>}
      {interview.phases.length > 0 && (
        <p className="tasks-tab-help">It has {interview.phases.length} {interview.phases.length === 1 ? 'part' : 'parts'}: {interview.phases.slice(0, 6).join(' · ')}{interview.phases.length > 6 ? ' …' : ''}</p>
      )}
      {interview.usedFiles.length > 0 && <small className="crew-empty">Read: {interview.usedFiles.join(', ')}</small>}

      <ol className="crew-question-list">
        {items.map((item) => (
          <li key={item.id} className="crew-question">
            <strong>{item.question}</strong>
            {item.why && <small>{item.why}</small>}
            <div className="command-chip-row" role="group" aria-label={`Answers to: ${item.question}`}>
              {item.options.map((option) => (
                <UiButton key={option} type="button" className={answers[item.id] === option ? 'active' : undefined} aria-pressed={answers[item.id] === option} onClick={() => setAnswers((current) => ({ ...current, [item.id]: option }))}>{option}</UiButton>
              ))}
              <UiButton type="button" className={!answers[item.id] ? 'active' : undefined} aria-pressed={!answers[item.id]} onClick={() => setAnswers((current) => ({ ...current, [item.id]: '' }))} title="Let the crew decide this one">You decide</UiButton>
            </div>
            <UiTextInput
              value={item.options.includes(answers[item.id] ?? '') ? '' : (answers[item.id] ?? '')}
              onChange={(event) => setAnswers((current) => ({ ...current, [item.id]: event.target.value }))}
              placeholder="Or say it in your own words"
              aria-label={`Your own answer to: ${item.question}`}
              maxLength={300}
            />
          </li>
        ))}
      </ol>

      {left.length > 0 && (
        <div className="crew-interview-left">
          <strong>Not asking about</strong>
          <ul className="crew-list">
            {left.map((item) => (
              <li key={item.topic}>
                <span><strong>{CREW_INTERVIEW_TOPICS[item.topic]}.</strong> {item.reason || 'The Lead did not think it mattered here.'}</span>
                <UiButton type="button" className="composer-text-button" onClick={() => askAnyway(item.topic)}>Ask me anyway</UiButton>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="studio-actions">
        <UiButton type="button" className="primary-button" disabled={busy} onClick={() => onStart(items.map((item) => ({ topic: item.topic, question: item.question, answer: (answers[item.id] ?? '').trim() })))}>
          <Play size={14} /> Start crew
        </UiButton>
        <UiButton type="button" className="secondary-button" disabled={busy} onClick={onSkip}>Just plan it</UiButton>
        <UiButton type="button" className="composer-text-button" disabled={busy} onClick={onBack}><ArrowLeft size={13} /> Back</UiButton>
      </div>
    </section>
  );
}
