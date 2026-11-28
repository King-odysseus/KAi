import { describe, expect, it } from 'vitest';
import { diagnoseRun, diagnosisLine } from '../apps/desktop/src/main/run-doctor';

/**
 * A failed run surfaces as whatever string the runtime produced: a raw stderr tail, an exit code, "the provider
 * returned no output". The cause is usually knowable, and naming it is the difference between giving up and fixing
 * it. The last test here is the one that must never regress: the run's own code reads these sentences to tell a
 * cancelled run from a failed one.
 */

const failed = (error: string, events: Array<Record<string, unknown>> = []) => diagnoseRun({ status: 'failed', error, events });

describe('diagnosing a failed run', () => {
  it('names a model that thought its budget away', () => {
    const diagnosis = failed('The provider returned no output (finish_reason: length; reasoning used the whole output budget).');
    expect(diagnosis?.cause).toBe('reasoning-budget');
    expect(diagnosis?.advice).toContain('output limit');
  });

  it('names a reply that was cut off', () => {
    expect(failed('The model was truncated mid-sentence (stop_reason: max_tokens).')?.cause).toBe('output-truncated');
  });

  it('names a conversation that outgrew its context', () => {
    expect(failed('This model\'s maximum context length is 128000 tokens, however you requested 140000.')?.cause).toBe('context-exhausted');
  });

  it('names a command that is not installed, from the tool that could not run it', () => {
    const diagnosis = failed('The turn ended with an error.', [
      { type: 'tool.call', name: 'run_command', status: 'failed', output: { exitCode: 127, stderr: "'vite' is not recognized as an internal or external command" } },
    ]);
    expect(diagnosis?.cause).toBe('command-missing');
    expect(diagnosis?.summary).toContain('run_command');
  });

  it('names a tool the run was not allowed to use', () => {
    const diagnosis = failed('The turn ended with an error.', [
      { type: 'tool.call', name: 'replace_in_file', status: 'failed', output: { error: 'The user denied this project change.' } },
    ]);
    expect(diagnosis?.cause).toBe('tool-denied');
  });

  it('names a refused key and a spent limit, which need different answers', () => {
    expect(failed('Request failed with status 401: invalid api key')?.cause).toBe('not-signed-in');
    expect(failed('429 rate limit reached for this model')?.cause).toBe('provider-limit');
  });

  it('names a queued Mac request', () => {
    expect(failed('The Mac did not answer within 240 minutes. The request was not sent again.')?.cause).toBe('gateway-queued');
  });

  it('names a Mac gateway memory shortage', () => {
    expect(failed('The Mac cannot take this request yet (503: insufficient memory). It was tried 4 times. Send "continue" to try again.')?.cause).toBe('gateway-memory');
  });

  it('names a full Mac model queue separately from a provider rate limit', () => {
    expect(failed('The Mac\'s queue is still full (model_queue_full) after 3 hours. Send "continue" to try again.')?.cause).toBe('gateway-queue-full');
  });

  it('does not diagnose gateway causes from tool output when another failure ended the run', () => {
    const diagnosis = diagnoseRun({
      status: 'failed',
      error: 'The run failed because the build assertion did not match.',
      events: [{ type: 'tool.call', name: 'run_command', status: 'completed', output: { stdout: 'Fixture line 503: request queued for later.' } }],
    });
    expect(diagnosis).toBeNull();
  });

  it('falls back to the exit code when that is all there is', () => {
    const diagnosis = failed('Codex exited with code 7.');
    expect(diagnosis?.cause).toBe('cli-exit');
    expect(diagnosis?.summary).toContain('exit code 7');
  });

  it('says nothing rather than guessing', () => {
    expect(failed('Something went wrong.')).toBeNull();
    expect(failed('')).toBeNull();
    // A run that finished is never diagnosed: whatever it says stands.
    expect(diagnoseRun({ status: 'completed', error: '429 rate limit reached' })).toBeNull();
  });

  it('never uses the words that mark a run as cancelled', () => {
    // runConversationAgent and the lesson filer read the run's text for these words to tell a cancelled run from a
    // failed one. A diagnosis that contained one would turn a failure into a cancellation.
    const errors = [
      'produced only reasoning and no reply',
      'finish_reason: length',
      'maximum context length exceeded',
      'Codex exited with code 1',
      '429 rate limit reached',
      'invalid api key',
    ];
    for (const error of errors) {
      const diagnosis = failed(error);
      if (!diagnosis) continue;
      expect(diagnosisLine(diagnosis)).not.toMatch(/cancel|abort|interrupt|stopped/i);
    }
  });
});
