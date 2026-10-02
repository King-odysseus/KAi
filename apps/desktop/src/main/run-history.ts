import type { RunScore } from '@kai/contracts';

/**
 * What KAI has already tried here, said at the start of the next run.
 *
 * KAI writes down what every run did and reads almost none of it back, so each task starts as naive as the first
 * one. This is the read: a few lines about the runs that touched the same files — when, how many files, and how
 * they ended — so an agent knows whether it is walking into something already tried, and whether the last attempt
 * worked.
 *
 * Deliberately small and factual. No model writes it (a template cannot make things up, and a model summarising
 * your own history can), only runs with a recorded outcome are used, and nothing at all is said when there is
 * nothing to say. It describes runs, never their prose.
 */

/** Enough to notice a pattern, few enough to stay out of the way. */
const MAX_RUNS = 3;
const MAX_FILES_NAMED = 3;

function nameFiles(files: readonly string[]): string {
  const named = files.slice(0, MAX_FILES_NAMED);
  const rest = files.length - named.length;
  return rest > 0 ? `${named.join(', ')} and ${rest} more` : named.join(', ');
}

/** "today", "yesterday", or a short date, measured against the run that is starting. */
export function dayLabel(iso: string, now: number): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'earlier';
  const startOfDay = (value: Date): number => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOfDay(new Date(now)) - startOfDay(at)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function runLine(run: RunScore, now: number): string {
  const files = run.files?.length ? `changed ${nameFiles(run.files)}` : 'changed nothing KAI recorded';
  const check = run.checkPassed === null ? 'no check ran' : run.checkPassed ? 'the check passed' : 'the check failed';
  const ending = run.completed ? null : 'the run failed';
  return `- ${dayLabel(run.at, now)}: ${files} — ${[check, ending].filter(Boolean).join(', ')}.`;
}

/** True when the newest run on these files ended badly, which is the one thing worth calling out. */
function endedBadly(run: RunScore): boolean {
  return !run.completed || run.checkPassed === false;
}

/**
 * The lines for the history section, or null when this project has no runs worth mentioning.
 *
 * Runs are chosen by the files in play when there are any: a run that touched the same file is worth knowing about,
 * and one that touched something else is not. With no files to go on — a task starting from nothing — the project's
 * recent runs are still worth a line, since the last thing that happened here is usually why the person is back.
 */
export function buildHistoryNote(input: {
  runs: readonly RunScore[];
  /** The files this run is about: what the conversation touched, plus anything selected. */
  files: readonly string[];
  projectId: string;
  now: number;
}): string[] | null {
  const forProject = input.runs.filter((run) => run.projectId === input.projectId);
  if (forProject.length === 0) return null;

  const wanted = new Set(input.files.filter(Boolean));
  const relevant = (wanted.size > 0
    ? forProject.filter((run) => (run.files ?? []).some((file) => wanted.has(file)))
    : forProject
  ).sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
  if (relevant.length === 0) return null;

  const newest = relevant.slice(0, MAX_RUNS);
  const lines = newest.map((run) => runLine(run, input.now));
  if (endedBadly(newest[0]!)) {
    lines.push('The most recent of those did not finish cleanly — find out why before repeating its approach.');
  }
  return lines;
}
