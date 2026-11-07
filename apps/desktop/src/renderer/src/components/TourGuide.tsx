import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Switch } from './ui/Switch';
import { Check, ChevronLeft, ChevronRight, GraduationCap, RotateCcw, X } from 'lucide-react';
import { TOUR_LESSONS, lessonFor, markLessonDone, resetTour, shouldAutoStart, turnTourOff, type TourProgress } from '../tour-lessons';
import type { ViewId } from '../types';
import { UiButton } from './UiButton';


interface Spot {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * The guided tour. A small hint card walks through the lesson for the screen you are on (Back, Next, Skip, and Turn
 * tour off), ringing the part of the screen each step is about; the lessons list reaches every screen's lesson. The
 * card never blocks the page: the ring ignores the pointer and the card sits in a corner.
 */
export function TourGuide({ view, progress, suspended, listOpen, onProgress, onCloseList, onNavigate }: {
  view: ViewId;
  progress: TourProgress;
  /** True while something else (the setup wizard) has the user's attention. */
  suspended: boolean;
  listOpen: boolean;
  onProgress: (next: TourProgress) => void;
  onCloseList: () => void;
  onNavigate: (view: ViewId) => void;
}): ReactNode {
  const [running, setRunning] = useState<{ view: ViewId; step: number } | null>(null);
  const [spot, setSpot] = useState<Spot | null>(null);
  const lastAutoView = useRef<ViewId | null>(null);

  // A lesson starts by itself the first time a screen is opened, unless the tour is off or the wizard is open.
  useEffect(() => {
    if (running && running.view !== view) setRunning(null);
    if (suspended) return;
    if (lastAutoView.current === view) return;
    lastAutoView.current = view;
    if (shouldAutoStart(progress, view, suspended)) setRunning({ view, step: 0 });
  }, [view, progress, suspended, running]);

  // Opening a screen again after the tour was turned back on should be able to start its lesson again.
  useEffect(() => {
    if (!progress.enabled) lastAutoView.current = null;
  }, [progress.enabled]);

  const lesson = running ? lessonFor(running.view) : undefined;
  const step = lesson && running ? lesson.steps[running.step] : undefined;

  const measure = useCallback(() => {
    if (!step?.target) {
      setSpot(null);
      return;
    }
    let element: Element | null = null;
    try {
      element = document.querySelector(step.target);
    } catch {
      element = null;
    }
    if (!element) {
      setSpot(null);
      return;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      setSpot(null);
      return;
    }
    setSpot({ top: rect.top - 4, left: rect.left - 4, width: rect.width + 8, height: rect.height + 8 });
  }, [step]);

  // Keep the ring on its target while the window resizes or scrolls, and find a target that appears a moment late.
  useEffect(() => {
    measure();
    const timer = window.setInterval(measure, 600);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [measure]);

  useEffect(() => {
    if (!running && !listOpen) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (listOpen) onCloseList();
      else finish();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function finish(): void {
    if (running) onProgress(markLessonDone(progress, running.view));
    setRunning(null);
  }

  function next(): void {
    if (!running || !lesson) return;
    if (running.step + 1 >= lesson.steps.length) finish();
    else setRunning({ ...running, step: running.step + 1 });
  }

  function turnOff(): void {
    onProgress(turnTourOff(running ? markLessonDone(progress, running.view) : progress));
    setRunning(null);
  }

  function openLesson(target: ViewId): void {
    onCloseList();
    lastAutoView.current = target;
    onNavigate(target);
    setRunning({ view: target, step: 0 });
  }

  // The card sits opposite its target, so it never covers the control it is explaining.
  const cardAtTop = spot !== null && spot.top > window.innerHeight * 0.45;

  const doneCount = TOUR_LESSONS.filter((item) => progress.done.includes(item.view)).length;

  return (
    <>
      {running && lesson && step && (
        <>
          {spot && <div className="tour-spot" style={{ top: spot.top, left: spot.left, width: spot.width, height: spot.height }} aria-hidden="true" />}
          <aside className={`tour-card${cardAtTop ? ' top' : ''}`} role="dialog" aria-label={`Guided tour: ${lesson.title}`} aria-live="polite">
            <header>
              <span className="tour-kicker"><GraduationCap size={13} /> {lesson.title} · {running.step + 1} of {lesson.steps.length}</span>
              <UiButton type="button" className="tour-close" onClick={finish} aria-label="Skip this lesson" title="Skip this lesson"><X size={14} /></UiButton>
            </header>
            <h3>{step.title}</h3>
            <p>{step.body}</p>
            <footer>
              <UiButton type="button" className="tour-link" onClick={turnOff} title="Stop the tour on every screen. The lessons stay in the list.">Turn tour off</UiButton>
              <span className="tour-buttons">
                <UiButton type="button" className="secondary-button" onClick={finish}>Skip</UiButton>
                {running.step > 0 && (
                  <UiButton type="button" className="secondary-button" onClick={() => setRunning({ ...running, step: running.step - 1 })}><ChevronLeft size={13} /> Back</UiButton>
                )}
                <UiButton type="button" className="primary-button" onClick={next}>
                  {running.step + 1 >= lesson.steps.length ? <><Check size={13} /> Done</> : <>Next <ChevronRight size={13} /></>}
                </UiButton>
              </span>
            </footer>
          </aside>
        </>
      )}

      {listOpen && (
        <>
          <UiButton type="button" className="tour-scrim" aria-label="Close the lessons list" onClick={onCloseList} />
          <section className="tour-list" role="dialog" aria-label="Lessons">
            <header>
              <strong><GraduationCap size={15} /> Lessons</strong>
              <span className="studio-note">{doneCount} of {TOUR_LESSONS.length} seen</span>
              <UiButton type="button" className="tour-close" onClick={onCloseList} aria-label="Close"><X size={14} /></UiButton>
            </header>
            <label className="toggle-row">
              <span><strong>Start lessons by themselves</strong><small>Each screen explains itself the first time you open it</small></span>
              <Switch checked={progress.enabled} onChange={(event) => onProgress(event.target.checked ? { ...progress, enabled: true } : turnTourOff(progress))} />
            </label>
            <ul>
              {TOUR_LESSONS.map((item) => {
                const seen = progress.done.includes(item.view);
                return (
                  <li key={item.view}>
                    <UiButton type="button" className={view === item.view ? 'current' : undefined} onClick={() => openLesson(item.view)}>
                      <span className={`tour-tick${seen ? ' seen' : ''}`} aria-hidden="true">{seen ? <Check size={12} /> : null}</span>
                      <span className="tour-lesson-text"><strong>{item.title}</strong><small>{item.summary}</small></span>
                      <span className="studio-note">{item.steps.length} steps</span>
                    </UiButton>
                  </li>
                );
              })}
            </ul>
            <footer>
              <UiButton type="button" className="secondary-button" onClick={() => { onProgress(resetTour()); lastAutoView.current = null; }}><RotateCcw size={13} /> Start over</UiButton>
            </footer>
          </section>
        </>
      )}
    </>
  );
}
