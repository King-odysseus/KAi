import { ARTIFACT_PATHS, type ArtifactKind, type BoardCard, type TeamPart } from '@kai/contracts';

/**
 * Turning a board card into the brief one agent works from. This is what replaces "split one large prompt": the
 * card already carries its story, its acceptance criteria, the artifacts it reads and its design node, so the brief
 * is assembled from facts rather than re-guessed by a model.
 *
 * The last rule in the brief is the important one. An agent that cannot finish marks the card blocked and says what
 * it needs; it never marks its own work done, because `board.ts` decides that from a passing check.
 */

/** The role a card of each kind is worked by, so a backend card does not go to a frontend agent. */
export function roleForCard(card: Pick<BoardCard, 'kind'>): TeamPart['role'] {
  if (card.kind === 'component' || card.kind === 'page' || card.kind === 'flow') return 'frontend';
  return 'backend';
}

/** The artifacts a card reads, as a labelled block. Missing ones are named, not silently dropped. */
export function briefArtifacts(card: Pick<BoardCard, 'needsArtifacts'>, artifacts: Partial<Record<ArtifactKind, string>>): string {
  return card.needsArtifacts.map((kind) => {
    const text = artifacts[kind];
    return `${kind.toUpperCase()} (${ARTIFACT_PATHS[kind]}):\n${text?.trim() ? text.trim() : '— not written yet; ask for it rather than inventing it.'}`;
  }).join('\n\n');
}

/** The whole brief for one card: what to build, how it is judged, what it reads, and when to stop. */
export function boardCardPrompt(card: BoardCard, artifacts: Partial<Record<ArtifactKind, string>>): string {
  const parts: string[] = [
    `You are one agent working exactly one card on the project board. Do not work on any other card.`,
    '',
    `CARD ${card.id} — ${card.title} (${card.kind})`,
    card.story.trim() ? `STORY:\n${card.story.trim()}` : '',
    card.acceptance.length > 0
      ? `ACCEPTANCE CRITERIA (these are what the card is closed on):\n${card.acceptance.map((item) => `- ${item}`).join('\n')}`
      : 'ACCEPTANCE CRITERIA: none recorded on the card; say so rather than deciding them yourself.',
    card.prompt.trim() ? `NOTES FROM THE PLANNER:\n${card.prompt.trim()}` : '',
    card.needsArtifacts.length > 0 ? `WHAT THIS CARD IS BUILT FROM:\n${briefArtifacts(card, artifacts)}` : '',
    card.designRef ? `DESIGN: this card is the open-pencil node "${card.designRef}". Match it; do not redesign it.` : '',
    card.check?.screenshots.length
      ? `SCREENSHOTS FROM THE LAST CHECK (read them before changing the screen):\n${card.check.screenshots.map((shot) => `- ${shot}`).join('\n')}`
      : '',
    '',
    'WHEN YOU STOP:',
    '- When the acceptance criteria hold, finish and report the files you changed. Do not move the card yourself.',
    '- If you cannot finish, say exactly what is missing and stop. The card is marked blocked with that reason.',
    '- Never claim the work is verified. A passing check run against the current files decides that, not you.',
  ];
  return parts.filter(Boolean).join('\n');
}

/**
 * The plan part one card becomes, so the existing assignment and workflow machinery can carry it. A card's fields
 * are wider than a part's, so each is trimmed to the length a part allows rather than failing validation later.
 */
export function boardCardPart(card: BoardCard, artifacts: Partial<Record<ArtifactKind, string>>): TeamPart {
  return {
    id: card.id.slice(0, 40),
    title: card.title.slice(0, 120),
    role: roleForCard(card),
    prompt: boardCardPrompt(card, artifacts).slice(0, 6_000),
    dependsOn: card.dependsOn.slice(0, 12).map((id) => id.slice(0, 40)),
    paths: [],
  };
}
