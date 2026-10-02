/**
 * Why a run failed, in one plain sentence, when KAI can tell.
 *
 * A failed run surfaces as whatever string the runtime happened to produce — "the provider returned no output", a
 * raw stderr tail, an exit code — and the cause is usually knowable from that text and the run's own events. The
 * difference between "something went wrong" and "the model spent its whole output budget thinking; raise the output
 * limit" is the difference between a person giving up and a person fixing it.
 *
 * Rules rather than a model, on purpose: a diagnosis that costs a round trip and may be wrong is worse than none,
 * and the failures that actually happen are recognisable. When nothing matches, KAI says nothing rather than
 * guessing, and the raw error is left to speak for itself.
 *
 * None of these sentences may contain "cancel", "abort", "interrupted" or "stopped": the run's own code reads those
 * words to tell a cancelled run from a failed one, and a diagnosis is not allowed to change that reading.
 */

export type RunCause =
  | 'reasoning-budget'
  | 'context-exhausted'
  | 'output-truncated'
  | 'command-missing'
  | 'tool-denied'
  | 'not-signed-in'
  | 'provider-limit'
  | 'cli-exit';

export interface RunDiagnosis {
  cause: RunCause;
  /** One sentence naming the cause. */
  summary: string;
  /** What to do about it, when there is something worth doing. */
  advice: string | null;
}

/** As little of an event as a diagnosis needs. */
export interface RunDoctorEvent {
  type?: string;
  name?: string;
  status?: string;
  message?: string;
  input?: unknown;
  output?: unknown;
}

export interface RunDoctorInput {
  status: 'completed' | 'failed';
  error?: string | null;
  events?: readonly RunDoctorEvent[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Everything worth reading, as one string: the error, the events' messages, and what failed tools reported. */
function evidence(input: RunDoctorInput): string {
  const parts: string[] = [];
  if (input.error) parts.push(input.error);
  for (const event of input.events ?? []) {
    if (event.message) parts.push(event.message);
    const output = asRecord(event.output);
    if (typeof event.output === 'string') parts.push(event.output);
    for (const key of ['error', 'message', 'stderr', 'stdout']) {
      const value = output?.[key];
      if (typeof value === 'string') parts.push(value);
    }
  }
  return parts.join('\n');
}

/** A tool the run called that ended badly, which is where a missing command or a refusal shows up. */
function failedTool(input: RunDoctorInput): { name: string; text: string } | null {
  for (const event of input.events ?? []) {
    if (event.type !== 'tool.call' || event.status !== 'failed') continue;
    const output = asRecord(event.output);
    const text = [
      typeof event.output === 'string' ? event.output : '',
      ...[output?.error, output?.message, output?.stderr].filter((value): value is string => typeof value === 'string'),
    ].join('\n');
    return { name: event.name ?? 'a tool', text };
  }
  return null;
}

export function diagnoseRun(input: RunDoctorInput): RunDiagnosis | null {
  // A run that finished is not diagnosed: whatever it says stands.
  if (input.status !== 'failed') return null;
  const text = evidence(input);
  if (!text.trim()) return null;

  if (/produced only reasoning|whole output budget|reasoning used the/i.test(text)) {
    return {
      cause: 'reasoning-budget',
      summary: 'The model spent its whole output budget thinking and never wrote an answer.',
      advice: 'Raise the output limit for this model, or pick one that does not reason.',
    };
  }
  if (/max_tokens|truncated|cut off|finish_reason:?\s*length|length limit/i.test(text)) {
    return {
      cause: 'output-truncated',
      summary: 'The model was cut off partway through its reply, more than once.',
      advice: 'Raise the output limit for this model, or break the task into smaller ones.',
    };
  }
  if (/context (?:window|length)|too many tokens|maximum context|context_length_exceeded|exceeds the context/i.test(text)) {
    return {
      cause: 'context-exhausted',
      summary: 'The conversation no longer fits the model\'s context window.',
      advice: 'Let KAI summarise the conversation, or continue in a new one.',
    };
  }
  const tool = failedTool(input);
  if (tool && /command not found|not recognized|no such file or directory|enoent|cannot find the path|is not installed/i.test(`${tool.text}\n${text}`)) {
    return {
      cause: 'command-missing',
      summary: `A command the run needed is not installed: ${tool.name}.`,
      advice: 'Install it, or tell the run to use one the project already has.',
    };
  }
  if (tool && /not allowed|denied|refused by policy|unknown project tool|permission/i.test(tool.text)) {
    return {
      cause: 'tool-denied',
      summary: `The run was refused permission to use ${tool.name}.`,
      advice: 'Raise the access level for this conversation, or approve it when asked.',
    };
  }
  if (/unauthorized|invalid api key|api key|not signed in|sign in|not logged in|authenticat|401/i.test(text)) {
    return {
      cause: 'not-signed-in',
      summary: 'The agent or provider refused the request as unauthenticated.',
      advice: 'Sign the agent in from Settings, or check the connection\'s key.',
    };
  }
  if (/rate limit|usage limit|quota|out of credit|insufficient|429|overloaded/i.test(text)) {
    return {
      cause: 'provider-limit',
      summary: 'The provider refused the request as over its limit.',
      advice: 'Wait for the limit to lift, or run this on another provider.',
    };
  }
  const exit = /exited with code (\d+)/i.exec(text);
  if (exit) {
    return {
      cause: 'cli-exit',
      summary: `The agent's own command line ended with exit code ${exit[1]}.`,
      advice: 'The last lines it printed are in the run\'s output above.',
    };
  }
  return null;
}

/** The diagnosis as one line to sit under the run's closing words. */
export function diagnosisLine(diagnosis: RunDiagnosis): string {
  return [diagnosis.summary, diagnosis.advice].filter(Boolean).join(' ');
}
