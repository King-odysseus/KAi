import type { ResponseStyle } from '@kai/contracts';

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

export function workingMethodBriefing(): string {
  return [
    '# Working method',
    "1. Look before you change. Read the file, or the relevant part of it, before editing — don't guess at its current content from memory or from what a similar file usually looks like.",
    '2. Say what you are about to do before a stretch of several tool calls, in one short sentence, so the work is legible as it happens rather than only at the end.',
    '3. Verify before declaring something done. Run the check that exists for the change you made; if none exists, say so rather than reporting a guess as a fact.',
    '4. Finish with: what changed (files/commands), what was verified (and its result), and what is left, if anything. Skip sections that do not apply rather than padding them out.',
  ].join('\n');
}
