import { describe, expect, it } from 'vitest';
import { leadIdeaScanCandidates, rankRelevantLeadIdeaCode } from '../apps/desktop/src/renderer/src/components/lead-idea-code-search';

describe('Lead idea code search', () => {
  it('uses file contents to select relevant code and excludes unrelated alphabetical candidates', () => {
    const idea = 'Add a calendar booking reminder';
    const matches = rankRelevantLeadIdeaCode(idea, [
      { path: 'src/a-auth.ts', size: 120, content: 'function login() {}' },
      { path: 'src/z-booking.ts', size: 140, content: 'function scheduleReminder() { return calendarBooking; }' },
      { path: 'src/m-calendar.ts', size: 160, content: 'export function renderCalendar() {}' },
    ]);
    expect(matches.map((file) => file.path)).toEqual(['src/z-booking.ts', 'src/m-calendar.ts']);
  });

  it('reports no matches as an empty result instead of falling back to filenames', () => {
    expect(rankRelevantLeadIdeaCode('Add a telemetry dashboard', [
      { path: 'src/a.ts', size: 100, content: 'function login() {}' },
      { path: 'src/z.ts', size: 100, content: 'function logout() {}' },
    ])).toEqual([]);
  });

  it('bounds reads by size and ranks likely paths before nonmatching alphabetical names', () => {
    const candidates = [
      { path: 'src/a.ts', size: 2_000 },
      { path: 'src/z-calendar.ts', size: 10_000 },
      { path: 'src/huge-calendar.ts', size: 90_000 },
    ];
    expect(leadIdeaScanCandidates('calendar reminder', candidates).map((file) => file.path)).toEqual(['src/z-calendar.ts', 'src/a.ts']);
  });
});
