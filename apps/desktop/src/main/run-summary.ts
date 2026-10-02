/**
 * What a run did, in plain words, when the model did not say so itself.
 *
 * A run that ends without a closing message used to leave the conversation with commands and then silence: the work
 * is visible in the activity list, but nothing states what it added up to, so the reader has to reconstruct it. KAI
 * already knows — the files changed, the checks, whether anything failed — so it says so.
 *
 * Written from the facts, never from the model, so it cannot be wrong about them. It is only used when the model has
 * not spoken for itself: its own account is better when there is one.
 */

export interface RunOutcome {
  status: 'completed' | 'failed';
  /** Project-relative paths the run changed. */
  files: readonly string[];
  checks: ReadonlyArray<{ command: string; passed: boolean | null }>;
  /** Why it failed, when it did. */
  error?: string;
}

/** How many files to name before summarising the rest as a count. */
const FILES_NAMED = 5;

function listOf(files: readonly string[]): string {
  const named = files.slice(0, FILES_NAMED);
  const rest = files.length - named.length;
  return rest > 0 ? `${named.join(', ')} and ${rest} more` : named.join(', ');
}

function checkVerdict(checks: RunOutcome['checks']): string {
  const ran = checks.filter((check) => check.passed !== null);
  if (ran.length === 0) return 'No check was run.';
  const failed = ran.filter((check) => !check.passed);
  if (failed.length === 0) return `Checks passed: ${ran.map((check) => check.command).join(', ')}.`;
  return `Checks failed: ${failed.map((check) => check.command).join(', ')}.`;
}

export function describeRunOutcome(outcome: RunOutcome): string {
  const headline = outcome.status === 'completed' ? 'The run finished.' : 'The run stopped before it finished.';
  const why = outcome.status === 'failed' && outcome.error ? ` ${outcome.error}` : '';

  const changed = outcome.files.length === 0
    ? 'It changed no files.'
    : `It changed ${outcome.files.length} file${outcome.files.length === 1 ? '' : 's'}: ${listOf(outcome.files)}.`;

  return `${headline}${why} ${changed} ${checkVerdict(outcome.checks)}`;
}
