/**
 * A self-paced schedule lets the run decide when to look again: a build that is still going wants a check in ten
 * minutes, a quiet repository in half a day. The run ends its reply with `NEXT_CHECK: <minutes>` to pick a gap, or
 * `NEXT_CHECK: stop` when there is nothing left to watch. The scheduler honours it inside a floor and a ceiling the
 * person set, so an agent can never wake itself every minute or never wake again by accident.
 */
export const SELF_PACED_MIN_MINUTES = 15;

export type NextCheck = { kind: 'minutes'; minutes: number } | { kind: 'stop' };

/** Added to the end of a self-paced schedule's prompt. */
export function selfPacedInstruction(maxMinutes: number): string {
  return [
    '',
    '---',
    'This task repeats on a schedule that you pace. When you have finished this pass, end your reply with exactly one final line:',
    `NEXT_CHECK: <minutes>   (a whole number from ${SELF_PACED_MIN_MINUTES} to ${maxMinutes}: how long to wait before looking again)`,
    'or',
    'NEXT_CHECK: stop        (only when the task is fully done and there is nothing left to watch)',
    'Choose a short wait while something is still changing and a long one while it is quiet.',
  ].join('\n');
}

/** Reads the last `NEXT_CHECK:` line of a run's output, or undefined when the run did not give one. */
export function parseNextCheck(output: string): NextCheck | undefined {
  const matches = [...output.matchAll(/^[ \t>*_`-]*NEXT_CHECK:[ \t]*([^\r\n]*)$/gim)];
  const value = matches.at(-1)?.[1]?.trim().toLowerCase().replace(/[*_`]/g, '');
  if (!value) return undefined;
  if (/^stop\b/.test(value)) return { kind: 'stop' };
  const minutes = /^(\d{1,6})\b/.exec(value);
  return minutes ? { kind: 'minutes', minutes: Number(minutes[1]) } : undefined;
}

/** The gap to wait: the run's choice held inside the person's bounds, else the schedule's own default. */
export function nextGapMinutes(check: NextCheck | undefined, defaultMinutes: number, maxMinutes: number): number {
  const ceiling = Math.max(SELF_PACED_MIN_MINUTES, maxMinutes);
  const wanted = check?.kind === 'minutes' ? check.minutes : defaultMinutes;
  return Math.min(ceiling, Math.max(SELF_PACED_MIN_MINUTES, Math.round(wanted)));
}
