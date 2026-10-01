import { describe, expect, it } from 'vitest';
import { navigation } from '../apps/desktop/src/renderer/src/components/Chrome';
import {
  DEFAULT_TOUR_PROGRESS,
  TOUR_LESSONS,
  lessonFor,
  markLessonDone,
  parseTourProgress,
  resetTour,
  shouldAutoStart,
  turnTourOff,
} from '../apps/desktop/src/renderer/src/tour-lessons';

describe('guided tour lessons', () => {
  it('has a lesson for every screen in the navigation, and no lesson for a screen that does not exist', () => {
    const screens = navigation.map((item) => item.id).sort();
    expect(TOUR_LESSONS.map((lesson) => lesson.view).sort()).toEqual(screens);
  });

  it('gives every lesson a title, a summary and steps that each say something', () => {
    for (const lesson of TOUR_LESSONS) {
      expect(lesson.title.trim()).not.toBe('');
      expect(lesson.summary.trim()).not.toBe('');
      expect(lesson.steps.length).toBeGreaterThanOrEqual(2);
      for (const step of lesson.steps) {
        expect(step.title.trim()).not.toBe('');
        expect(step.body.trim().length).toBeGreaterThan(30);
      }
    }
  });

  it('keeps each hint short enough to read at a glance', () => {
    for (const lesson of TOUR_LESSONS) {
      for (const step of lesson.steps) expect(step.body.length).toBeLessThan(420);
    }
  });

  it('uses selectors that are valid CSS, so a step never throws while looking for its target', () => {
    const probe = { querySelector: (selector: string) => selector } as unknown as Document;
    for (const lesson of TOUR_LESSONS) {
      for (const step of lesson.steps) {
        if (step.target) expect(() => probe.querySelector(step.target!)).not.toThrow();
        if (step.target) expect(step.target).toMatch(/^[.#\w\-\s>:[\]="'*,]+$/);
      }
    }
  });
});

describe('guided tour progress', () => {
  it('starts on by default, with nothing seen', () => {
    expect(parseTourProgress(null)).toEqual({ enabled: true, done: [] });
    expect(DEFAULT_TOUR_PROGRESS.enabled).toBe(true);
  });

  it('survives a corrupt, old or hand-edited value', () => {
    expect(parseTourProgress('not json')).toEqual({ enabled: true, done: [] });
    expect(parseTourProgress('{"enabled":false,"done":["studio","studio","nowhere",7]}')).toEqual({ enabled: false, done: ['studio'] });
    expect(parseTourProgress('{"done":"studio"}')).toEqual({ enabled: true, done: [] });
  });

  it('starts a lesson by itself only when the tour is on, nothing else has attention, and it is unseen', () => {
    const fresh = { enabled: true, done: [] };
    expect(shouldAutoStart(fresh, 'studio', false)).toBe(true);
    expect(shouldAutoStart(fresh, 'studio', true)).toBe(false);
    expect(shouldAutoStart(markLessonDone(fresh, 'studio'), 'studio', false)).toBe(false);
    expect(shouldAutoStart(turnTourOff(fresh), 'studio', false)).toBe(false);
  });

  it('turns off everywhere with one switch, and keeps what was seen', () => {
    const progress = markLessonDone({ enabled: true, done: [] }, 'workspace');
    const off = turnTourOff(progress);
    expect(off).toEqual({ enabled: false, done: ['workspace'] });
    for (const lesson of TOUR_LESSONS) expect(shouldAutoStart(off, lesson.view, false)).toBe(false);
  });

  it('marks a lesson seen once, and starting over clears everything and turns it back on', () => {
    const once = markLessonDone({ enabled: true, done: [] }, 'git');
    expect(markLessonDone(once, 'git')).toBe(once);
    expect(resetTour()).toEqual({ enabled: true, done: [] });
  });

  it('finds a lesson by screen', () => {
    expect(lessonFor('settings')?.title).toBe('Settings');
  });
});
