/**
 * What a finished run teaches C1. The brain used to hear that a session started and ended, never what happened in it,
 * so the Review queue stayed empty and Overwatch had nothing to judge. This turns a run that changed the project into
 * a short plain-language account that goes to the draft queue, where Overwatch and the user decide what is worth
 * keeping. Nothing here talks to the daemon; the caller does, so the wording is testable on its own.
 */

export interface RunLessonInput {
  /** What the user (or Autopilot) asked for. */
  prompt: string;
  /** The agent's closing message. */
  output: string;
  status: 'completed' | 'failed';
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
 * A lesson for the run, or null when there is nothing worth filing: a run that failed or was cancelled, one that
 * changed no files (a question and an answer), or one too short to say anything. Quiet by design, because every
 * draft costs somebody a decision.
 */
export function composeRunLesson(input: RunLessonInput): RunLesson | null {
  if (input.status !== 'completed') return null;
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

  // C1 titles a draft with the first line, so that line is the task on its own and the rest is the account.
  const title = oneLine(input.prompt, 100);
  const summary = `${title}

Task: ${prompt} Result: ${result} Changed ${input.files.length} file${input.files.length === 1 ? '' : 's'}: ${shown}${more}. ${verdict}`;
  return { summary: summary.slice(0, SUMMARY_LIMIT), files: [...input.files] };
}
