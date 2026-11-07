import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PERSONAS,
  defaultRecipe,
  isAutoLikeIntent,
  isKnownStarter,
  personaFor,
  recipesFor,
} from '../apps/desktop/src/renderer/src/components/personas';

/**
 * The composer's selectors and recipes. The table is the contract between the UI and the skills on disk: a recipe
 * that names a skill which does not exist is a button that silently loads nothing.
 */

describe('composer personas', () => {
  it('offers one selector per job, with unique ids and labels', () => {
    const ids = PERSONAS.map((persona) => persona.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['ask', 'plan', 'build', 'review', 'test', 'audit', 'operate', 'learn', 'equalizer', 'auto']);
  });

  it('runs exactly the working selectors through Auto', () => {
    expect(PERSONAS.filter((persona) => isAutoLikeIntent(persona.id)).map((persona) => persona.id))
      .toEqual(['test', 'audit', 'operate', 'auto']);
  });

  it('gives every recipe an id unique inside its selector, and a default', () => {
    for (const persona of PERSONAS) {
      if (!persona.recipes) continue;
      const ids = persona.recipes.map((recipe) => recipe.id);
      expect(new Set(ids).size, `${persona.id} has a repeated recipe id`).toBe(ids.length);
      expect(defaultRecipe(persona)?.id).toBe(ids[0]);
    }
  });

  it('names only skills that exist on disk', () => {
    const root = path.resolve('.agents/skills');
    const named = new Set(PERSONAS.flatMap((persona) => persona.recipes?.flatMap((recipe) => recipe.skills) ?? []));
    for (const skill of named) {
      expect(existsSync(path.join(root, skill, 'SKILL.md')), `missing skill: ${skill}`).toBe(true);
    }
  });

  it('offers licence and legal-compliance checks as Audit recipes', () => {
    const recipes = personaFor('audit').recipes ?? [];
    expect(recipes.find((recipe) => recipe.id === 'licences')?.skills).toEqual(['license-attribution-checker']);
    expect(recipes.find((recipe) => recipe.id === 'compliance')?.skills).toEqual(['legal-compliance-checker']);
  });

  it('only treats a composer-known starter as replaceable', () => {
    expect(isKnownStarter('')).toBe(true);
    expect(isKnownStarter('  ')).toBe(true);
    expect(isKnownStarter(personaFor('build').starter)).toBe(true);
    expect(isKnownStarter(personaFor('audit').recipes?.[0]?.starter ?? '')).toBe(true);
    expect(isKnownStarter('Build a login form with rate limiting')).toBe(false);
  });
});

describe('saved recipes', () => {
  const saved = [
    { id: 'saved_ab12cd34', intent: 'build', label: 'Fix a flaky test', description: 'x', starter: 'Fix the flaky test:', skills: ['test-author'] },
    { id: 'saved_ef56ab78', intent: 'review', label: 'Quick look', description: 'y', starter: 'Look:', skills: [] },
  ];

  it('adds the ones for a selector after its built-in recipes, and leaves the default alone', () => {
    const build = personaFor('build');
    const offered = recipesFor(build, saved);
    expect(offered.slice(0, build.recipes!.length).map((recipe) => recipe.id)).toEqual(build.recipes!.map((recipe) => recipe.id));
    expect(offered.at(-1)).toMatchObject({ id: 'saved_ab12cd34', label: 'Fix a flaky test', skills: ['test-author'] });
    expect(offered[0]?.id).toBe(build.recipes![0]!.id);
    expect(offered.some((recipe) => recipe.id === 'saved_ef56ab78')).toBe(false);
  });

  it('offers just the built-in recipes when nothing is saved, and none for a selector without recipes', () => {
    expect(recipesFor(personaFor('test'), [])).toEqual(personaFor('test').recipes);
    expect(recipesFor(personaFor('auto'), saved)).toEqual([]);
  });

  it('only names skills that exist, as every built-in recipe does', () => {
    // A saved recipe copies the skill names of the recipe it was made under, so it cannot name a skill that is not there.
    const root = path.resolve('.agents/skills');
    for (const recipe of recipesFor(personaFor('build'), saved)) {
      if (recipe.id.startsWith('saved_')) continue;
      for (const skill of recipe.skills) expect(existsSync(path.join(root, skill, 'SKILL.md'))).toBe(true);
    }
  });
});
