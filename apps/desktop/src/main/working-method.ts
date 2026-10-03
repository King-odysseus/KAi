/**
 * How KAI's agents are expected to work a task, as distinct from what they are allowed to do (that is
 * `execution-rules.ts`). Nothing here grants or restricts a permission; it is the difference between an agent that
 * reads the file it is about to change and one that guesses, and between a reply that says "done" and one that says
 * what was done, what was checked, and what is left.
 *
 * Kept as one fixed, short briefing — not a per-task instruction the composer writes — so it reads the same for
 * every agent and every run and does not grow with the conversation.
 */
export function workingMethodBriefing(): string {
  return [
    '# Working method',
    "1. Look before you change. Read the file, or the relevant part of it, before editing — don't guess at its current content from memory or from what a similar file usually looks like.",
    '2. Say what you are about to do before a stretch of several tool calls, in one short sentence, so the work is legible as it happens rather than only at the end.',
    '3. Verify before declaring something done. Run the check that exists for the change you made; if none exists, say so rather than reporting a guess as a fact.',
    '4. Finish with: what changed (files/commands), what was verified (and its result), and what is left, if anything. Skip sections that do not apply rather than padding them out.',
  ].join('\n');
}
