import { describe, expect, it } from 'vitest';
import { ACCESS_LEVELS, EXPERIENCE_PROFILES, appSettingsV1Schema, autonomyModeSchema, createDefaultSettings, experienceProfile, migrateSettings } from '../packages/contracts/src';

describe('experience level', () => {
  it('describes every access level the app offers, in order from safest', () => {
    expect(ACCESS_LEVELS.map((level) => level.value)).toEqual(['plan', 'ask', 'autoEdit', 'full', 'custom']);
    expect([...autonomyModeSchema.options].sort()).toEqual(ACCESS_LEVELS.map((level) => level.value).sort());
    for (const level of ACCESS_LEVELS) expect(level.description.length).toBeGreaterThan(20);
  });

  it('gives a beginner the safest defaults and the plainest review', () => {
    expect(EXPERIENCE_PROFILES.beginner).toMatchObject({ autonomy: 'ask', reviewMode: 'novice', explainAccess: true });
    expect(EXPERIENCE_PROFILES.expert.explainAccess).toBe(false);
  });

  it('reads a missing level as intermediate', () => {
    expect(experienceProfile(undefined)).toBe(EXPERIENCE_PROFILES.intermediate);
  });

  it('starts a fresh install as a beginner but leaves saved settings as they were', () => {
    const fresh = createDefaultSettings();
    expect(fresh.experienceLevel).toBe('beginner');
    const { experienceLevel: _omitted, ...saved } = fresh;
    expect(appSettingsV1Schema.parse(saved).experienceLevel).toBe('intermediate');
    expect(migrateSettings(saved).experienceLevel).toBe('intermediate');
  });
});
