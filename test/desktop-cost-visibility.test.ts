import { describe, expect, it } from 'vitest';
import { createDefaultCrewConfig } from '@kai/contracts';
import { composerLimitPolicy, crewLimitPolicy } from '../apps/desktop/src/renderer/src/cost-visibility';

const limits = createDefaultCrewConfig('claude', 'codex').limits;

describe('cost visibility', () => {
  it('explains ask, finish and unlimited Crew policies accurately', () => {
    expect(crewLimitPolicy({ ...limits, maxUsd: 4, onLimit: 'ask' })).toContain('asks you to Continue or Finish');
    expect(crewLimitPolicy({ ...limits, maxMinutes: 30, onLimit: 'finish' })).toContain('finishes with accepted work');
    expect(crewLimitPolicy({ ...limits, maxUsd: 0, maxMinutes: 0 })).toContain('No cost or time limit is set');
  });

  it('describes the budget that applies to each composer route', () => {
    expect(composerLimitPolicy(true, 'direct')).toContain('block the next request');
    expect(composerLimitPolicy(true, 'proxy')).toContain('not measured');
    expect(composerLimitPolicy(false, 'direct')).toBeNull();
  });
});
