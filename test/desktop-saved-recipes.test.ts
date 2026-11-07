import { describe, expect, it } from 'vitest';
import { MAX_SAVED_RECIPES, projectPreferencesV1Schema, savedRecipeSchema } from '@kai/contracts';

const recipe = {
  id: 'saved_ab12cd34',
  intent: 'build',
  label: 'Fix a flaky test',
  description: 'Fix the flaky test, then run it ten times',
  starter: 'Fix the flaky test and prove it with repeated runs:',
  skills: ['test-author'],
  createdAt: '2026-11-07T12:00:00.000Z',
};

describe('saved recipes in project preferences', () => {
  it('are stored with the other per-project choices', () => {
    const parsed = projectPreferencesV1Schema.parse({ schemaVersion: 1, projectId: 'p1', recipes: [recipe] });
    expect(parsed.recipes?.[0]?.label).toBe('Fix a flaky test');
  });

  it('are optional, so preferences written before they existed still load', () => {
    expect(projectPreferencesV1Schema.parse({ schemaVersion: 1, projectId: 'p1' }).recipes).toBeUndefined();
  });

  it('cannot take the id of a built-in recipe or sit behind a selector that has no recipes', () => {
    expect(savedRecipeSchema.safeParse({ ...recipe, id: 'feature' }).success).toBe(false);
    expect(savedRecipeSchema.safeParse({ ...recipe, intent: 'auto' }).success).toBe(false);
  });

  it('are limited in number and in size', () => {
    const many = Array.from({ length: MAX_SAVED_RECIPES + 1 }, (_, index) => ({ ...recipe, id: `saved_ab12cd${String(index).padStart(2, '0')}` }));
    expect(projectPreferencesV1Schema.safeParse({ schemaVersion: 1, projectId: 'p1', recipes: many }).success).toBe(false);
    expect(savedRecipeSchema.safeParse({ ...recipe, starter: 'x'.repeat(4_001) }).success).toBe(false);
    expect(savedRecipeSchema.safeParse({ ...recipe, label: ' ' }).success).toBe(false);
  });
});
