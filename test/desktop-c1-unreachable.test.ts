import { describe, expect, it } from 'vitest';
import { looksUnreachable } from '../apps/desktop/src/main/ipc';

/**
 * This decides whether KAI restarts the brain, so both directions matter. Restarting on a refusal would throw away
 * whatever the daemon was in the middle of saying; *not* restarting on a dead endpoint is the bug this exists to fix —
 * the daemon had stopped answering without ever exiting, so the restart policy never heard about it and every recall
 * and every draft silently failed against a closed port.
 */
describe('deciding whether the brain could be reached', () => {
  it('recognises the ways a closed port fails, since that is the case worth restarting', () => {
    const failures = [
      new Error('fetch failed'),
      new Error('connect ECONNREFUSED 127.0.0.1:9877'),
      new Error('socket hang up'),
      new Error('connect ETIMEDOUT 127.0.0.1:9877'),
      'ERROR: ECONNRESET',
    ];
    for (const failure of failures) {
      expect(looksUnreachable(failure), String(failure)).toBe(true);
    }
  });

  it('leaves the daemon alone when it answered, however unhappily', () => {
    // Each of these is the daemon talking, so restarting it would lose the answer rather than fix anything.
    const refusals = [
      new Error('Cognitive1 returned 401 Unauthorized'),
      new Error('The brain rejected the entry: too similar to an existing one'),
      new Error('Cognitive1 operation brain-drafts failed: 500'),
      undefined,
      null,
      '',
    ];
    for (const failure of refusals) {
      expect(looksUnreachable(failure), String(failure)).toBe(false);
    }
  });
});
