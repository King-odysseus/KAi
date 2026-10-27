import { helperLimitOf, type HelperChoice, type ResponseStyle } from '@kai/contracts';

/**
 * How KAI's agents are expected to work a task, as distinct from what they are allowed to do (that is
 * `execution-rules.ts`). Nothing here grants or restricts a permission; it is the difference between an agent that
 * reads the file it is about to change and one that guesses, and between a reply that says "done" and one that says
 * what was done, what was checked, and what is left.
 *
 * Kept as one fixed, short briefing — not a per-task instruction the composer writes — so it reads the same for
 * every agent and every run and does not grow with the conversation.
 */
/**
 * The wording the reply should have. It changes how the agent talks, never what it is allowed to do, and it applies
 * to the agent's own words only: code, commands and tool output stay exactly as they are.
 */
export function responseStyleBriefing(style: ResponseStyle = 'plain'): string {
  const rules: Record<ResponseStyle, string[]> = {
    plain: [
      'Write for someone who is not an engineer. Lead with one sentence that says what happened or what you found.',
      'Use short sentences and everyday words. If you must use a technical term, say what it means in a few plain words the first time.',
      'Say what you did, why it matters, and what the person needs to do next, if anything. Do not list file paths unless they are needed.',
      'Never pad. If the answer is one sentence, give one sentence.',
    ],
    concise: [
      'Give the answer or the result first, then stop. No background, no recap of what you were asked, no closing offers.',
    ],
    detailed: [
      'Explain what you did and why, step by step, including what you checked and what you ruled out. Name the files and commands involved.',
    ],
    technical: [
      'Use precise engineering language and assume the reader knows the codebase. Name files, symbols and commands exactly.',
    ],
  };
  return ['# How to write your reply', ...rules[style].map((rule) => '- ' + rule), '- This is about your wording only; code, commands and tool output stay exactly as they are.'].join('\n');
}

/**
 * How the agent is told to use helper agents on this run, from the composer's Agents choice.
 *
 * Whether to use helpers used to be left to the agent alone, and an agent left alone mostly does not: a model tends to
 * do a job itself unless it is told that splitting it is wanted. So "auto" says when it is wanted (a large job with
 * separate parts), and a number says how many to use. Only the wording differs between an API run and a CLI run; a
 * limit on an API run is also enforced where the helpers are started.
 */
export function helpersBriefing(choice: HelperChoice | undefined, execution: 'api' | 'cli'): string {
  const how = execution === 'api'
    ? 'Start a helper with the `task` tool, set write to true for a part that writes code, and make several `task` calls in the same turn so they run at once. Give each helper everything it needs and name the files it owns: it cannot see this conversation.'
    : 'Start helpers as sub-agents (the Task tool, where you have one) in the same turn so they run at once. Give each one everything it needs and name the files it owns.';
  const limit = helperLimitOf(choice);
  if (limit === 0) {
    return ['# Helpers', '- Do all the work yourself. Do not start helpers or sub-agents on this job.'].join('\n');
  }
  if (limit === null) {
    return [
      '# Helpers',
      '- When the job is large and has separate parts that do not depend on each other (different files or modules, a feature and its tests, research and building), split it and start helpers for those parts at once, then check their work together before you finish.',
      '- Do a small job, or one whose parts depend on each other, yourself. Never give two helpers the same file.',
      `- ${how}`,
    ].join('\n');
  }
  return [
    '# Helpers',
    `- Use ${limit} helper agents at once on this job, and keep them all busy until the work runs out.`,
    `- List every separate part of the job that does not depend on another, and start a helper for each in the same turn. There can be more parts than ${limit}: the extra helpers wait their turn and start as soon as one of the ${limit} finishes, so list them all rather than stopping at ${limit}.`,
    '- If the job has fewer parts than that, use as many as it has and say so in one line. Never give two helpers the same file.',
    `- ${how}`,
    '- Check the helpers\' work together before you finish.',
  ].join('\n');
}

export function workingMethodBriefing(): string {
  return [
    '# Working method',
    "1. Look before you change. Read the file, or the relevant part of it, before editing — don't guess at its current content from memory or from what a similar file usually looks like.",
    '2. Say what you are about to do before a stretch of several tool calls, in one short sentence, so the work is legible as it happens rather than only at the end.',
    '3. Verify before declaring something done. Run the check that exists for the change you made; if none exists, say so rather than reporting a guess as a fact.',
    '4. Finish with: what changed (files/commands), what was verified (and its result), and what is left, if anything. Skip sections that do not apply rather than padding them out.',
    '5. Tell source from rough work before you stage anything. Screenshots, logs, build output and scratch captures belong in the repository only when its own conventions already keep them there; otherwise leave them local and extend the ignore file. When the repository already answers a question — its ignore rules, its folder layout, what it tracks — act on that answer instead of asking it.',
  ].join('\n');
}
