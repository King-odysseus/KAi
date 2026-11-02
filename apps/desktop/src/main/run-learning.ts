/**
 * What a finished run teaches C1. The brain used to hear that a session started and ended, never what happened in it,
 * so the Review queue stayed empty and Overwatch had nothing to judge. This turns a run that changed the project into
 * a short plain-language account that goes to the draft queue, where Overwatch and the user decide what is worth
 * keeping. Nothing here talks to the daemon; the caller does, so the wording is testable on its own.
 */

export interface RunLessonInput {
  /** Stable conversation goal identity, when this run was attached to one. */
  taskId?: string;
  taskOutcome?: string;
  /** What the user (or Autopilot) asked for. */
  prompt: string;
  /** The agent's closing message. */
  output: string;
  status: 'completed' | 'failed';
  /** Why it failed, when it did. The failure is the part most worth remembering. */
  error?: string;
  /** Project-relative paths the run changed, as Git or the checkpoint saw them. */
  files: readonly string[];
  /** The checks the run, or the app after it, ran. */
  checks: ReadonlyArray<{ command: string; passed: boolean | null }>;
}

export interface RunLesson {
  summary: string;
  files: string[];
}

const MIN_PROMPT_CHARS = 12;
const MIN_OUTPUT_CHARS = 40;
const SUMMARY_LIMIT = 1_500;
const FILES_LISTED = 8;

function oneLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
}

/**
 * A lesson for the run, or null when there is nothing worth filing: one that changed no files (a question and an
 * answer), or one too short to say anything. Quiet by design, because every draft costs somebody a decision.
 *
 * A run that failed is filed too, and deliberately. It used to be dropped, which left the brain holding only the runs
 * that went smoothly — the half with nothing to teach. The run that hit a real error is the one that names the file,
 * the symptom and the cause, and it is exactly what should be recognised the next time a project does the same thing.
 */
export function composeRunLesson(input: RunLessonInput): RunLesson | null {
  // Stopping a run teaches nothing: the person changed their mind, the code did not fail. Only a run that ended on its
  // own failure is worth a draft, or the queue would fill with the times somebody pressed Stop.
  if (input.status === 'failed' && /cancell?ed|abort|interrupted|stopped/i.test(input.error ?? '')) return null;
  if (input.files.length === 0) return null;
  const prompt = oneLine(input.prompt, 240);
  const result = oneLine(input.output, 700);
  if (prompt.length < MIN_PROMPT_CHARS || result.length < MIN_OUTPUT_CHARS) return null;

  const shown = input.files.slice(0, FILES_LISTED).join(', ');
  const more = input.files.length > FILES_LISTED ? ` and ${input.files.length - FILES_LISTED} more` : '';
  const checked = input.checks.filter((check) => check.passed !== null);
  const verdict = checked.length === 0
    ? 'No check was run.'
    : checked.every((check) => check.passed)
      ? `Checks passed: ${checked.map((check) => oneLine(check.command, 80)).join('; ')}.`
      : `Checks failed: ${checked.filter((check) => !check.passed).map((check) => oneLine(check.command, 80)).join('; ')}.`;

  // The outcome leads, because that is what a later reader needs to recognise: a failure reads differently from a
  // completion, and the error text is what makes it findable.
  const outcome = input.status === 'completed'
    ? 'Result:'
    : `Did not finish: ${oneLine(input.error ?? 'the run failed', 240)} Result:`;

  // C1 titles a draft with the first line, so that line is the task on its own and the rest is the account.
  const title = oneLine(input.prompt, 100);
  const summary = `${title}

Task: ${prompt} ${outcome} ${result} Changed ${input.files.length} file${input.files.length === 1 ? '' : 's'}: ${shown}${more}. ${verdict}`;
  return { summary: summary.slice(0, SUMMARY_LIMIT), files: [...input.files] };
}
