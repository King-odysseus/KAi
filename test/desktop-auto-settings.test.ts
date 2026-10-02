import { describe, expect, it } from 'vitest';
import {
  AUTO_WORKING_AUTONOMY,
  autoSettingsKey,
  buildAutoStartRequest,
  defaultAutoSettings,
  readAutoSettings,
  writeAutoSettings,
  type AutoSettingsStorage,
} from '../apps/desktop/src/renderer/src/components/auto-settings';

/**
 * Auto's tuning used to live in the panel's own state, which was fine while the panel was also the button that
 * started the run. The composer starts it now, so both sides read one store — and a stored value from an older build
 * must not be trusted into a request.
 */
function memoryStorage(seed: Record<string, string> = {}): AutoSettingsStorage & { values: Map<string, string> } {
  const values = new Map(Object.entries(seed));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe('auto settings', () => {
  it('starts from what Auto is meant to do out of the box', () => {
    const settings = defaultAutoSettings();
    expect(settings.checkCommand).toBe('');
    // No turn cap and no spend cap: a long productive run is not cut off by a round number, and money is the
    // person's call rather than a default.
    expect(settings.maxTurns).toBe(0);
    expect(settings.maxCostUsd).toBe(0);
    expect(settings.maxHours).toBe(12);
  });

  it('remembers what was set, per project', () => {
    const storage = memoryStorage();
    writeAutoSettings('p1', { ...defaultAutoSettings(), checkCommand: 'npm test', maxTurns: 12 }, storage);
    expect(readAutoSettings('p1', storage)).toMatchObject({ checkCommand: 'npm test', maxTurns: 12 });
    // Another project is another task: it must not inherit this one's check.
    expect(readAutoSettings('p2', storage).checkCommand).toBe('');
    expect(storage.values.has(autoSettingsKey('p1'))).toBe(true);
  });

  it('falls back rather than trusting a stored value from an older build', () => {
    const storage = memoryStorage({
      [autoSettingsKey('p1')]: JSON.stringify({
        checkCommand: 42,
        apiFallback: 'yes',
        maxTurns: -5,
        maxHours: 9_999,
        maxCostUsd: 'lots',
        minGapSeconds: 1e9,
      }),
    });
    expect(readAutoSettings('p1', storage)).toEqual(defaultAutoSettings());

    const unreadable = memoryStorage({ [autoSettingsKey('p1')]: 'not json' });
    expect(readAutoSettings('p1', unreadable)).toEqual(defaultAutoSettings());
  });

  it('builds the request the composer sends, under the composer own choices', () => {
    const request = buildAutoStartRequest({
      projectId: 'p1',
      conversationId: 'conv-1',
      prompt: '  Go through every page and check it.  ',
      settings: { ...defaultAutoSettings(), checkCommand: ' npm test ', maxTurns: 7, minGapSeconds: 2 },
      execution: 'api',
      agent: 'claude',
      route: 'direct',
      autonomy: 'autoEdit',
      model: 'claude-sonnet-5-5',
      skills: ['open-pencil'],
      selectedPaths: ['src/app.tsx'],
    });
    expect(request).toEqual({
      conversationId: 'conv-1',
      projectId: 'p1',
      prompt: 'Go through every page and check it.',
      execution: 'api',
      agent: 'claude',
      route: 'direct',
      autonomy: 'autoEdit',
      model: 'claude-sonnet-5-5',
      checkCommand: 'npm test',
      maxTurns: 7,
      maxCostUsd: 0,
      maxHours: 12,
      apiFallback: true,
      minGapSeconds: 2,
      skills: ['open-pencil'],
      selectedPaths: ['src/app.tsx'],
    });
  });

  it('leaves out what the composer has nothing for, rather than sending empties', () => {
    const request = buildAutoStartRequest({
      projectId: 'p1',
      prompt: 'Fix the tests',
      settings: defaultAutoSettings(),
      execution: 'cli',
      agent: 'codex',
      route: 'direct',
      autonomy: 'full',
    });
    expect(request).not.toHaveProperty('conversationId');
    expect(request).not.toHaveProperty('model');
    expect(request).not.toHaveProperty('skills');
    expect(request.checkCommand).toBe('');
  });

  it('refuses a level that would stop to ask, since nobody is there to answer', () => {
    expect(AUTO_WORKING_AUTONOMY.has('autoEdit')).toBe(true);
    expect(AUTO_WORKING_AUTONOMY.has('full')).toBe(true);
    for (const level of ['plan', 'ask', 'custom'] as const) {
      expect(AUTO_WORKING_AUTONOMY.has(level)).toBe(false);
    }
  });
});
