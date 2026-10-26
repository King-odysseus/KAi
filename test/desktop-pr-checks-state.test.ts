import { describe, expect, it } from 'vitest';
import { rollUpChecksState } from '../apps/desktop/src/main/git-tools';

describe('rollUpChecksState', () => {
  it('reports none for a pull request with no checks', () => {
    expect(rollUpChecksState([])).toBe('none');
  });

  it('reports passing when every check run succeeded', () => {
    expect(rollUpChecksState([
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { status: 'COMPLETED', conclusion: 'NEUTRAL' },
    ])).toBe('passing');
  });

  it('reports failing when any check run failed, even if others passed', () => {
    expect(rollUpChecksState([
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { status: 'COMPLETED', conclusion: 'FAILURE' },
    ])).toBe('failing');
  });

  it('reports pending while a check is still running', () => {
    expect(rollUpChecksState([
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { status: 'IN_PROGRESS', conclusion: null },
    ])).toBe('pending');
  });

  it('failing wins over pending when a run both failed and another is still in progress', () => {
    expect(rollUpChecksState([
      { status: 'COMPLETED', conclusion: 'FAILURE' },
      { status: 'QUEUED', conclusion: null },
    ])).toBe('failing');
  });

  it('reads the older commit-status shape, not just check runs', () => {
    expect(rollUpChecksState([{ state: 'SUCCESS' }])).toBe('passing');
    expect(rollUpChecksState([{ state: 'PENDING' }])).toBe('pending');
    expect(rollUpChecksState([{ state: 'ERROR' }])).toBe('failing');
  });
});
