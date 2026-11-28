/**
 * Notices a run that is stuck although no two of its calls are alike. A model can edit, run the tests, get the same
 * failures, edit differently and run them again for as long as nobody looks: the repeat guard only sees identical calls.
 * What stays the same is how the check fails, so that is what is counted.
 */
import { createHash } from 'node:crypto';

/** The same failure this many times is put to the person. */
export const SAME_FAILURE_LIMIT = 4;
/** The model is told one time earlier, so it has a chance to change approach by itself. */
export const SAME_FAILURE_WARNING_AT = SAME_FAILURE_LIMIT - 1;

const CHECK_TOOL = /^(?:run_command|diagnostics)$|^mcp_kai[-_]terminal_terminal_run$/;
const FAILURE_LINE = /✗|✘|×|✕|\bFAIL(?:ED)?\b|\bfailed\b|\bfailures?\b|\berror\b|Error:|\bexpected\b|\breceived\b|Traceback|\bnot ok\b|TS\d{4}/i;

export type CheckVerdict =
  | { kind: 'ok' }
  | { kind: 'warn'; notice: string }
  | { kind: 'stuck'; notice: string };

/**
 * What a failure looks like with everything that differs from one run to the next taken out: colours, timings, clock
 * times and line positions. Undefined when the result is not a failed check.
 */
export function failureSignature(name: string, output: unknown): string | undefined {
  if (!CHECK_TOOL.test(name) || !output || typeof output !== 'object') return undefined;
  const record = output as Record<string, unknown>;
  const failed = record.timedOut === true
    || (typeof record.exitCode === 'number' && record.exitCode !== 0)
    || record.ok === false;
  if (!failed) return undefined;
  const text = [record.stdout, record.stderr, record.output, record.error]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const named = lines.filter((line) => FAILURE_LINE.test(line));
  const kept = (named.length ? named : lines.slice(-20)).map((line) => line
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\b/g, '#')
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|seconds?)\b/gi, '#')
    .replace(/:\d+(?::\d+)?\b/g, ':#'));
  // A set, in order: runners report the same failures in whatever order they finish.
  const value = [...new Set(kept)].sort().join('\n');
  return createHash('sha256').update(`${record.timedOut === true ? 'timeout\n' : ''}${value}`).digest('hex');
}

export class CheckProgress {
  private readonly failures = new Map<string, { count: number; command: string }>();

  observe(name: string, input: unknown, output: unknown): CheckVerdict {
    if (!CHECK_TOOL.test(name)) return { kind: 'ok' };
    const command = commandOf(name, input);
    const signature = failureSignature(name, output);
    if (!signature) {
      // This command passes now, so what it failed with before is behind the run.
      for (const [key, seen] of this.failures) if (seen.command === command) this.failures.delete(key);
      return { kind: 'ok' };
    }
    const count = (this.failures.get(signature)?.count ?? 0) + 1;
    this.failures.set(signature, { count, command });
    if (count >= SAME_FAILURE_LIMIT) {
      return { kind: 'stuck', notice: `The same check has now failed the same way ${count} times, whatever was changed in between.` };
    }
    if (count === SAME_FAILURE_WARNING_AT) {
      return {
        kind: 'warn',
        notice: `This check has failed the same way ${count} times. Changing the same thing again will not help: read the failure closely, check your assumption about how the code behaves, and try a different approach, or say plainly what you cannot make work.`,
      };
    }
    return { kind: 'ok' };
  }

  /** The person chose to carry on: the counting starts again. */
  reset(): void {
    this.failures.clear();
  }
}

function commandOf(name: string, input: unknown): string {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const command = typeof record.command === 'string' ? record.command : typeof record.path === 'string' ? record.path : '';
  // The same command, with or without first changing into the project.
  return `${name} ${command.replace(/^\s*cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*/, '').replace(/\s+/g, ' ').trim()}`;
}

const runs = new WeakMap<object, CheckProgress>();
export function checkProgress(runtime: object): CheckProgress {
  let progress = runs.get(runtime);
  if (!progress) { progress = new CheckProgress(); runs.set(runtime, progress); }
  return progress;
}
