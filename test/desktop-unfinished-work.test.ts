import { describe, expect, it } from 'vitest';
import { announcesUnfinishedWork } from '../apps/desktop/src/main/direct-provider-runtime';

describe('a reply that only announces work', () => {
  it('is recognised, so the run is nudged to do it instead of ending', () => {
    expect(announcesUnfinishedWork('I\'ll complete the three pending tasks now. Let me investigate the current state of the nav and em-dash usage.')).toBe(true);
    expect(announcesUnfinishedWork('Let me read the files.')).toBe(true);
    expect(announcesUnfinishedWork('Done with the audit.\n\nNow I will edit the nav.')).toBe(true);
    // Cut off mid-sentence: the model stopped before it did anything.
    expect(announcesUnfinishedWork('I have the architecture and stack.\n\nI now have')).toBe(true);
  });

  it('is recognised even when the promise closes a long reply', () => {
    // The reply that stalled a real run: a long read-up that ends by promising to build. A length limit used to
    // skip exactly this shape, so no nudge was ever sent and the run ended with the task untouched.
    const readUp = `I read the brief, the stack notes and the tokens. ${'The board is clear. '.repeat(40)}`;
    expect(announcesUnfinishedWork(`${readUp}\n\nI'll stop reading and start building. Let me pull the exact content of the files I need to write correct code (data model, env vars, deps, tokens, board task IDs), then scaffold immediately.`)).toBe(true);
  });

  it('leaves a reply that asks the person something alone, even when it promises what comes next', () => {
    // The exact ending of a real run. It reads as a promise ("I will push") and the pattern took it for one, so the
    // model was told the work was not done and pushed to carry on — instead of the question ever being put to the
    // person, who could not tell what it was waiting for.
    expect(announcesUnfinishedWork('The branch is committed locally. Tell me the remote and I will push.')).toBe(false);
    expect(announcesUnfinishedWork('I need one thing from you: which remote should I push to? All the tests pass now.')).toBe(false);
    expect(announcesUnfinishedWork('Let me know which account to use. I will then finish the deploy.')).toBe(false);
    expect(announcesUnfinishedWork('Do you want me to change the selected link colour too? I will wait here.')).toBe(false);
  });

  it('does not read a polite sign-off as a promise', () => {
    expect(announcesUnfinishedWork('The nav link is in and the em dashes are gone. Let me know if you want anything else.')).toBe(false);
    expect(announcesUnfinishedWork('All three changes are in place. Let me know if you need more.')).toBe(false);
  });

  it('leaves a real answer, a question, and an empty reply alone', () => {
    expect(announcesUnfinishedWork('')).toBe(false);
    expect(announcesUnfinishedWork('I added the Home link and removed the em dashes. Everything builds.')).toBe(false);
    expect(announcesUnfinishedWork('Do you want me to change the selected link colour too?')).toBe(false);
    expect(announcesUnfinishedWork('Let me know if you want anything else.\n\nAll three changes are in place.')).toBe(false);
    expect(announcesUnfinishedWork(`I'll summarise. ${'The build passed. '.repeat(60)}`)).toBe(false);
  });
});
