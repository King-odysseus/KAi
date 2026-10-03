import { beforeEach, describe, expect, it } from 'vitest';
import { clearInterjections, hasInterjections, interject, setInterjectionActive, steeringInstruction, takeDeliveredInterjections, takeInterjection } from '../apps/desktop/src/main/interjections';

const A = 'conv-a';
const B = 'conv-b';

/**
 * The queue a message waits in until the run reaches its next turn. It is small, but the things it must never do are
 * what make it worth pinning: hand the same message over twice, hand one to the wrong run, or keep one so long that a
 * later run answers a question nobody is asking any more.
 */
describe('messages waiting for a run in progress', () => {
  it('frames a steer as immediate work followed by resuming the original task', () => {
    const instruction = steeringInstruction('check the execution rules');
    expect(instruction).toContain('handle it first: check the execution rules');
    expect(instruction).toContain('resume the original task');
    expect(instruction).toContain('Do not treat this interruption as a cancellation');
  });
  beforeEach(() => {
    clearInterjections(A);
    clearInterjections(B);
    takeDeliveredInterjections(A);
    takeDeliveredInterjections(B);
    setInterjectionActive(A, true);
    setInterjectionActive(B, true);
  });

  it('hands a message over once, then nothing', () => {
    interject(A, 'what are you doing?');
    expect(takeInterjection(A)).toBe('what are you doing?');
    expect(takeInterjection(A)).toBeNull();
    expect(hasInterjections(A)).toBe(false);
  });

  it('answers them in the order they were said', () => {
    interject(A, 'first');
    interject(A, 'second');
    expect(takeInterjection(A)).toBe('first');
    expect(takeInterjection(A)).toBe('second');
  });

  it('keeps one conversation out of another', () => {
    interject(A, 'for A');
    interject(B, 'for B');
    expect(takeInterjection(B)).toBe('for B');
    expect(takeInterjection(A)).toBe('for A');
  });

  it('ignores an empty or whitespace message rather than handing one over', () => {
    interject(A, '   ');
    interject(A, '');
    expect(takeInterjection(A)).toBeNull();
  });

  it('drops what is left when a run ends, so the next run does not inherit it', () => {
    interject(A, 'too late');
    clearInterjections(A);
    expect(takeInterjection(A)).toBeNull();
  });

  it('confirms only when the active model takes the message', async () => {
    const delivered = interject(A, 'please adjust');
    expect(takeInterjection(A)).toBe('please adjust');
    await expect(delivered).resolves.toBe(true);
    expect(takeDeliveredInterjections(A)).toEqual(['please adjust']);
    expect(takeDeliveredInterjections(A)).toEqual([]);
  });

  it('reports an undelivered message when a run ends first', async () => {
    const delivered = interject(A, 'please adjust');
    clearInterjections(A);
    await expect(delivered).resolves.toBe(false);
    await expect(interject(A, 'too late')).resolves.toBe(false);
  });
});
