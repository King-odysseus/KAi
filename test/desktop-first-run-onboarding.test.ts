import { describe, expect, it } from 'vitest';
import { FIRST_RUN_PROJECT_TYPES, firstRunIdea } from '../apps/desktop/src/renderer/src/first-run-onboarding';
import { TOUR_LESSONS } from '../apps/desktop/src/renderer/src/tour-lessons';

describe('first-run project onboarding', () => {
  it('offers common project types and includes the selected type in the interview idea', () => {
    expect(FIRST_RUN_PROJECT_TYPES).toContain('Web app');
    expect(FIRST_RUN_PROJECT_TYPES).toContain('Other');
    expect(firstRunIdea('API or service', '  A tiny invoicing API  ')).toBe('Project type: API or service\n\nA tiny invoicing API');
  });

  it('guides newcomers through project type, interview recap and the board', () => {
    const studio = TOUR_LESSONS.find((lesson) => lesson.view === 'studio');
    expect(studio?.steps.some((step) => step.target === '[data-tour="first-run-project-type"]')).toBe(true);
    expect(studio?.steps.some((step) => step.target === '.studio-interview-recap')).toBe(true);
    expect(studio?.steps.some((step) => step.title === 'Land on the board')).toBe(true);
  });
});
