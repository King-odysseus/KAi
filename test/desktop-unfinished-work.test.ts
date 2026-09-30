import { describe, expect, it } from 'vitest';
import { announcesUnfinishedWork } from '../apps/desktop/src/main/direct-provider-runtime';

describe('a reply that only announces work', () => {
  it('is recognised, so the run is nudged to do it instead of ending', () => {
    expect(announcesUnfinishedWork('I\'ll complete the three pending tasks now. Let me investigate the current state of the nav and em-dash usage.')).toBe(true);
    expect(announcesUnfinishedWork('Let me read the files.')).toBe(true);
    expect(announcesUnfinishedWork('Done with the audit.\n\nNow I will edit the nav.')).toBe(true);
  });

  it('leaves a real answer, a question, and an empty reply alone', () => {
    expect(announcesUnfinishedWork('')).toBe(false);
    expect(announcesUnfinishedWork('I added the Home link and removed the em dashes. Everything builds.')).toBe(false);
    expect(announcesUnfinishedWork('Do you want me to change the selected link colour too?')).toBe(false);
    expect(announcesUnfinishedWork('Let me know if you want anything else.\n\nAll three changes are in place.')).toBe(false);
    expect(announcesUnfinishedWork(`I'll summarise. ${'The build passed. '.repeat(60)}`)).toBe(false);
  });
});
