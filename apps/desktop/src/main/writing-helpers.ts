import type { ParallelSession } from './parallel-session';

/**
 * Helper agents that write code, run side by side.
 *
 * A read-only helper cannot hurt anything, so any number of them share the project. A helper that edits files is
 * different: two of them in one folder overwrite each other. So a round of writing helpers gives each its own copy of
 * the project (the same copies Autopilot's cards use), checks each copy, merges the copies into the project, and runs a
 * helper again on its own when its changes clashed with another's. The model that asked sees what each one changed.
 */

/** Writing helpers one round runs together. Read-only helpers have their own, higher limit; these also build and check. */
export const MAX_WRITING_HELPERS_AT_ONCE = 8;
const TAIL_CHARS = 2_500;

export interface HelperRunResult {
  answer: string;
  costUsd: number;
  provider?: string;
  model?: string;
}

export interface WritingTask {
  /** Names the helper's copy and its line in the result. */
  id: string;
  prompt: string;
  model: string | undefined;
}

export interface WritingHelperPorts {
  /** Separate copies of the project, or null when it is not a git repository with a commit. */
  prepare(): Promise<ParallelSession | null>;
  /** One helper run. `folder` is the copy it works in; undefined is the project itself. */
  run(prompt: string, model: string | undefined, folder: string | undefined): Promise<HelperRunResult>;
  /** The project's check command run in a folder; null when the project has none. */
  check(folder: string, signal: AbortSignal): Promise<{ passed: boolean; output: string } | null>;
}

export interface WritingHelperOutcome {
  id: string;
  answer: string;
  costUsd: number;
  provider?: string;
  model?: string;
  /** Files the helper changed, as paths from the repository root. Empty when it changed nothing, or cannot be told. */
  files: string[];
  /** The check run in the helper's own copy: after the helper's last turn. */
  check: 'passed' | 'failed' | 'not run';
  checkOutput: string;
  /** Whether the helper's changes are in the project now. */
  applied: boolean;
  /** The helper clashed with another and ran again on its own, on top of the merged work. */
  reran: boolean;
  error?: string;
}

export interface WritingBatchResult {
  outcomes: WritingHelperOutcome[];
  /** One line for the person or the model when the batch did not go as asked, such as copies being unavailable. */
  notice: string | null;
}

interface Draft {
  id: string;
  run?: HelperRunResult;
  costUsd: number;
  commit?: string;
  files: string[];
  check: WritingHelperOutcome['check'];
  checkOutput: string;
  error?: string;
}

/** Runs `work` for every item, at most `limit` at a time. `work` must not throw. */
async function pool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) await work(item);
    }
  });
  await Promise.all(lanes);
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The failure handed back to a helper whose copy did not pass the check. */
export function checkFailurePrompt(prompt: string, output: string): string {
  return `${prompt}\n\nYour changes were checked in your own copy of the project and the check failed. Fix the cause; do not weaken or skip the check. Output:\n${output.slice(-TAIL_CHARS)}`;
}

/** The prompt for a helper whose changes clashed with another's, so it builds on the merged work instead of replacing it. */
export function clashPrompt(prompt: string, files: readonly string[]): string {
  const named = files.length > 0 ? ` (${files.slice(0, 8).join(', ')})` : '';
  return `${prompt}\n\nAnother helper changed some of the same files${named} while you worked, and their work is in the project now. Look at those files first and make your change on top of theirs instead of replacing it.`;
}

/**
 * Runs a round of writing helpers. Never throws: a helper that fails comes back as an outcome with `error`, so one bad
 * helper does not take the others' work with it.
 */
export async function runWritingHelpers(
  tasks: readonly WritingTask[],
  ports: WritingHelperPorts,
  signal: AbortSignal,
  limit: number = MAX_WRITING_HELPERS_AT_ONCE,
): Promise<WritingBatchResult> {
  const session = await ports.prepare().catch(() => null);
  if (!session) return runOneAtATime(tasks, ports);

  const drafts = new Map<string, Draft>();
  const clashed = new Map<string, string[]>();
  let notice: string | null = null;
  try {
    await pool(tasks, limit, async (task) => {
      const draft: Draft = { id: task.id, costUsd: 0, files: [], check: 'not run', checkOutput: '' };
      drafts.set(task.id, draft);
      try {
        const folder = await session.checkout(task.id);
        let run = await ports.run(task.prompt, task.model, folder);
        draft.costUsd += run.costUsd;
        let check = await ports.check(folder, signal).catch(() => null);
        if (check && !check.passed) {
          // One more turn with the failure, here in the copy, before anything is merged: cheaper than hearing it
          // from the project's own check after the merge.
          run = await ports.run(checkFailurePrompt(task.prompt, check.output), task.model, folder);
          draft.costUsd += run.costUsd;
          check = await ports.check(folder, signal).catch(() => null);
        }
        draft.run = run;
        if (check) {
          draft.check = check.passed ? 'passed' : 'failed';
          draft.checkOutput = check.passed ? '' : check.output.slice(-TAIL_CHARS);
        }
        draft.commit = await session.commit(task.id, `Helper: ${task.prompt}`.slice(0, 120));
        draft.files = await session.filesChanged(draft.commit).catch(() => []);
      } catch (error) {
        draft.error = message(error);
      }
    });

    const merging = tasks.flatMap((task) => {
      const draft = drafts.get(task.id);
      return draft?.commit && draft.files.length > 0 && !draft.error ? [{ stepId: task.id, commit: draft.commit }] : [];
    });
    if (merging.length > 0) {
      try {
        const merged = await session.integrate(merging);
        for (const conflict of merged.conflicts) clashed.set(conflict.stepId, conflict.files);
        if (merged.skipped.length > 0) {
          notice = `${merged.skipped.length} file${merged.skipped.length === 1 ? ' was' : 's were'} changed in the project while the helpers worked, so the project's version was kept: ${merged.skipped.slice(0, 5).join(', ')}.`;
        }
      } catch (error) {
        notice = `The helpers' work could not be merged (${message(error)}); each runs again on its own.`;
        for (const entry of merging) clashed.set(entry.stepId, []);
      }
    }
  } finally {
    await session.dispose().catch(() => undefined);
  }

  const outcomes: WritingHelperOutcome[] = [];
  for (const task of tasks) {
    const draft = drafts.get(task.id);
    if (!draft) continue;
    const base = {
      id: task.id,
      files: draft.files,
      check: draft.check,
      checkOutput: draft.checkOutput,
      costUsd: draft.costUsd,
      ...(draft.run?.provider ? { provider: draft.run.provider } : {}),
      ...(draft.run?.model ? { model: draft.run.model } : {}),
    };
    if (draft.error || !draft.run) {
      outcomes.push({ ...base, answer: '', applied: false, reran: false, error: draft.error ?? 'The helper did not finish.' });
      continue;
    }
    const files = clashed.get(task.id);
    if (!files) {
      outcomes.push({ ...base, answer: draft.run.answer, applied: true, reran: false });
      continue;
    }
    // Clashed: runs again on its own, in the project, now that the other helpers' work is there.
    if (signal.aborted) {
      outcomes.push({ ...base, answer: draft.run.answer, applied: false, reran: false, error: 'Stopped before this helper could run again on top of the merged work.' });
      continue;
    }
    try {
      const again = await ports.run(clashPrompt(task.prompt, files), task.model, undefined);
      outcomes.push({ ...base, costUsd: draft.costUsd + again.costUsd, answer: again.answer, applied: true, reran: true, check: 'not run', checkOutput: '' });
    } catch (error) {
      outcomes.push({ ...base, answer: draft.run.answer, applied: false, reran: true, error: message(error) });
    }
  }
  return { outcomes, notice };
}

/** No copies to be had: the helpers share the project, so they run in turn rather than over each other's edits. */
async function runOneAtATime(tasks: readonly WritingTask[], ports: WritingHelperPorts): Promise<WritingBatchResult> {
  const outcomes: WritingHelperOutcome[] = [];
  for (const task of tasks) {
    try {
      const run = await ports.run(task.prompt, task.model, undefined);
      outcomes.push({
        id: task.id, answer: run.answer, costUsd: run.costUsd, files: [], check: 'not run', checkOutput: '', applied: true, reran: false,
        ...(run.provider ? { provider: run.provider } : {}),
        ...(run.model ? { model: run.model } : {}),
      });
    } catch (error) {
      outcomes.push({ id: task.id, answer: '', costUsd: 0, files: [], check: 'not run', checkOutput: '', applied: false, reran: false, error: message(error) });
    }
  }
  return {
    outcomes,
    notice: 'The helpers ran one after another, in the project: working side by side needs a git project with at least one commit.',
  };
}

/** What one writing helper reports back to the model that asked for it. */
export function describeOutcome(outcome: WritingHelperOutcome): Record<string, unknown> {
  if (outcome.error) {
    return { error: outcome.error, applied: false, changed_files: outcome.files };
  }
  return {
    answer: outcome.answer,
    applied: outcome.applied,
    changed_files: outcome.files,
    check: outcome.check === 'failed'
      ? `failed in the helper's copy and not fixed: ${outcome.checkOutput.slice(-800)}`
      : outcome.check === 'passed' ? 'passed in the helper\'s copy' : 'not run',
    ...(outcome.reran ? { note: 'This helper changed some of the same files as another, so it ran again on top of the merged work.' } : {}),
  };
}
