/** The first line of a commit says what was done; the lines under it list the tasks. Drafted, never committed unseen. */
export function draftCommitMessage(built: readonly string[]): string {
  if (built.length === 0) return 'Crew changes';
  const subject = `${built[0]}${built.length > 1 ? `, and ${built.length - 1} more` : ''}`;
  const clipped = subject.length > 72 ? `${subject.slice(0, 71).trimEnd()}…` : subject;
  return `${clipped}\n\n${built.map((title) => `- ${title}`).join('\n')}`;
}
