/**
 * What a blocked card is waiting for, in the words of what the person has to do about it.
 *
 * Autopilot parks a card it cannot finish and carries on with the rest, which is right — one card that cannot pass
 * should not stop the board. But the note it leaves reads "Autopilot gave up after 3 attempts. The last attempt ended
 * with an error: …", which says what happened to the machine and nothing about what is being asked of the reader. The
 * person is then left with a wall of blocked cards and no idea which of them need them, or for what.
 *
 * This turns that reason into the one line the person needs: what is missing, and what would clear it.
 */

export type BlockedNeed =
  | 'your-approval'
  | 'a-value'
  | 'a-fix'
  | 'a-provider'
  | 'your-decision'
  | 'a-look';

export interface BlockedExplanation {
  need: BlockedNeed;
  /** One line, addressed to the person, saying what would get this card moving again. */
  ask: string;
}

/**
 * Ordered, because the first match is the one that applies: a permission failure that also mentions a file is still a
 * permission failure, and saying "look at the file" would send the reader to the wrong place.
 */
const PATTERNS: ReadonlyArray<{ need: BlockedNeed; match: RegExp; ask: string }> = [
  {
    need: 'your-approval',
    match: /\b(approv|permission|denied|not allowed|forbidden|401|403)\b/i,
    ask: 'It was stopped for approval. Allow the action it asked for, then put this card back in the queue.',
  },
  {
    need: 'a-provider',
    match: /\b(rate limit|quota|429|credit|billing|api key|credential|unauthori[sz]ed|sign.?in)\b/i,
    ask: 'The provider refused the request. Check the API key, the credit, or the rate limit for the model this card uses.',
  },
  {
    need: 'a-value',
    match: /\b(env|environment variable|secret|token|missing|not set|undefined is not|configur)\b/i,
    ask: 'Something it needs has no value yet. Supply the missing setting or secret, then put this card back in the queue.',
  },
  {
    need: 'a-fix',
    match: /\b(check|test|fail|assert|exit \d|typecheck|build)\b/i,
    ask: 'Its check keeps failing. Read the failure on the card and either fix the cause or correct the check.',
  },
  {
    need: 'your-decision',
    match: /\b(ambiguous|two ways|which|decide|choice|unclear|spec|acceptance)\b/i,
    ask: 'It could not decide between options. Say which one you want, then put this card back in the queue.',
  },
];

/** `reason` is the note the board holds for the parked card. */
export function explainBlocked(reason: string): BlockedExplanation {
  const said = reason.trim();
  for (const pattern of PATTERNS) {
    if (pattern.match.test(said)) return { need: pattern.need, ask: pattern.ask };
  }
  // Nothing recognised: hand back the reason itself rather than inventing a cause. A wrong guess here sends the reader
  // to fix something that was never broken.
  return {
    need: 'a-look',
    ask: said
      ? `Autopilot could not finish this and the reason is on the card: ${said.length > 300 ? `${said.slice(0, 299)}…` : said}`
      : 'Autopilot could not finish this card and left no reason.',
  };
}

/** The cards that need the person, with what each is waiting for. Cards blocked by hand are left out: those are theirs already. */
export function needsAttention<T extends { status: string; notes: string }>(cards: readonly T[]): Array<T & BlockedExplanation> {
  return cards
    .filter((card) => card.status === 'blocked' && card.notes.startsWith('Autopilot gave up'))
    .map((card) => ({ ...card, ...explainBlocked(card.notes) }));
}
