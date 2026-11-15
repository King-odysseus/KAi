/** One question from the start interview and what the person answered. An empty answer means "you decide". */
export interface InterviewAnswer {
  topic: string;
  question: string;
  answer: string;
}

const GOAL_LIMIT = 4_000;
const KEEP_GOING = 'keep going through every phase';
const STOP_EACH = 'stop after each phase';

/**
 * The goal with the person's answers written under it, so every agent sees what was settled and what was left to them.
 * The goal is never cut to make room: if the answers do not fit, the last of them are dropped and the goal stays whole.
 */
export function compileBrief(goal: string, answers: readonly InterviewAnswer[]): string {
  const lines = answers.map((item) => (item.answer.trim()
    ? `- ${item.question} ${item.answer.trim()}`
    : `- ${item.question} Left to the crew to decide.`));
  if (lines.length === 0) return goal;
  const header = '\n\nWhat the person settled before the crew planned:\n';
  const room = GOAL_LIMIT - goal.length - header.length;
  if (room < 40) return goal;
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > room) break;
    kept.push(line);
    used += line.length + 1;
  }
  return kept.length === 0 ? goal : `${goal}${header}${kept.join('\n')}`;
}

/** Whether the person chose to have the crew carry on through every phase: true, false, or undefined when they did not say. */
export function keepGoingFrom(answers: readonly InterviewAnswer[]): boolean | undefined {
  const answer = answers.find((item) => item.topic === 'autonomy')?.answer.trim().toLowerCase() ?? '';
  if (answer.includes(KEEP_GOING)) return true;
  if (answer.includes(STOP_EACH)) return false;
  return undefined;
}
