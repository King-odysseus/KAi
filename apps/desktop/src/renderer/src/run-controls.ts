/**
 * Which of Stop, Pause and Resume have something to act on.
 *
 * The composer draws Stop and Resume whenever a run is paused, waiting on an answer, or parked by Auto for the
 * person — not only while a turn is in flight. The handlers behind those buttons asked for a running turn instead,
 * so in every parked state the buttons were on screen and did nothing. Both sides now read the same rules.
 */
export interface RunControlState {
  /** A turn is in flight. */
  running: boolean;
  /** The person paused the run. */
  paused: boolean;
  /** Auto has parked the run until the person answers or presses Resume. */
  autoWaiting: boolean;
  /** An approval or a question is waiting for the person. */
  awaitingApproval: boolean;
}

/** Stop ends whatever is still alive, including a run that is only waiting on the person. */
export function canStopRun(state: RunControlState): boolean {
  return state.running || state.paused || state.autoWaiting || state.awaitingApproval;
}

/** Resume picks up a run the person paused or Auto parked; a turn in flight has nothing to resume. */
export function canResumeRun(state: RunControlState): boolean {
  return state.paused || state.autoWaiting;
}

/** Pause only makes sense for a turn that is actually going and is not already held. */
export function canPauseRun(state: RunControlState): boolean {
  return state.running && !state.paused && !state.autoWaiting && !state.awaitingApproval;
}

/**
 * How long Stop waits for Auto to finish unwinding before moving on. Auto's own stop only answers once its whole loop
 * has ended, and ending the run itself does not depend on that answer.
 */
export const AUTO_STOP_WAIT_MS = 4_000;

/** How long after Stop a run may stay alive before the person is told it did not stop and shown the way out. */
export const STOP_STILL_RUNNING_MS = 10_000;

/** What the composer says while a steered message waits for the run to take it. */
export function steerWaitingNotice(runHeld: boolean): string {
  return runHeld
    ? 'The run is paused, so it takes this message when you resume it. Stop ends the run instead.'
    : 'Waiting for the active model to take this message.';
}
