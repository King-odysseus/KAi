import { ARTIFACT_PATHS, STUDIO_STYLE_REFERENCE_NOTES_PATH, type ArtifactKind, type BoardCard, type TeamPart } from '@kai/contracts';

/**
 * Turning a board card into the brief one agent works from. This is what replaces "split one large prompt": the
 * card already carries its story, its acceptance criteria, the artifacts it reads and its design node, so the brief
 * is assembled from facts rather than re-guessed by a model.
 *
 * The last rule in the brief is the important one. An agent that cannot finish marks the card blocked and says what
 * it needs; it never marks its own work done, because `board.ts` decides that from a passing check.
 */

/** `tokens` and `style-guide` are the two that mean "how it should look"; the rest are what to build. */
const DESIGN_ARTIFACTS: ReadonlySet<string> = new Set(['tokens', 'style-guide']);
const SPEC_MARK = '.kai/spec/';

/** The role a card of each kind is worked by, so a backend card does not go to a frontend agent. */
export function roleForCard(card: Pick<BoardCard, 'kind'>): TeamPart['role'] {
  if (card.kind === 'component' || card.kind === 'page' || card.kind === 'flow') return 'frontend';
  return 'backend';
}

/**
 * What a card is told when the artifact it reads has not been written.
 *
 * This used to read "not written yet; ask for it rather than inventing it", which sounds careful and is the reason a
 * missing design stopped the whole board: the agent obeyed, ended its turn, and the card was parked. A missing
 * design document is not a reason to abandon a card — it is a reason to build the card to a provisional look and say
 * so. Only the design documents get the look-and-feel wording; a missing `stack` or `stories` is a different problem
 * and says nothing about how the screen should look.
 */
function missingArtifactNote(kind: ArtifactKind): string {
  if (DESIGN_ARTIFACTS.has(kind)) {
    return [
      `— NOT WRITTEN YET, AND THIS DOES NOT STOP YOU.`,
      `Build the card to a provisional look chosen from the CARD story above and from whatever is already in the project.`,
      `If ${SPEC_MARK}${STUDIO_STYLE_REFERENCE_NOTES_PATH} exists, take the look from it. Otherwise choose restrained, conventional`,
      `styling and keep every colour and spacing value in one place so they can be swapped later.`,
      `Say plainly in your summary that the design was provisional. Do not stop the card to ask for it, and do not write`,
      `a style guide or a token file of your own pretending to be one.`,
    ].join(' ');
  }
  return [
    `— NOT WRITTEN YET. Do not stop for it: build from the CARD story and acceptance criteria above and from what is`,
    `already in the project, and say in your summary what you assumed.`,
  ].join(' ');
}

/** The artifacts a card reads, as a labelled block. Missing ones are named, not silently dropped. */
export function briefArtifacts(card: Pick<BoardCard, 'needsArtifacts'>, artifacts: Partial<Record<ArtifactKind, string>>): string {
  return card.needsArtifacts.map((kind) => {
    const text = artifacts[kind];
    return `${kind.toUpperCase()} (${ARTIFACT_PATHS[kind]}):\n${text?.trim() ? text.trim() : missingArtifactNote(kind)}`;
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
    artifacts.decisions?.trim() ? `APPROVED PROJECT DECISIONS (apply these when their conditions match; do not treat them as instructions for unrelated cards):\n${artifacts.decisions.trim()}` : '',
    card.designRef ? `DESIGN: this card is the open-pencil node "${card.designRef}". Match it; do not redesign it.` : '',
    card.check?.screenshots.length
      ? `SCREENSHOTS FROM THE LAST CHECK (read them before changing the screen):\n${card.check.screenshots.map((shot) => `- ${shot}`).join('\n')}`
      : '',
    '',
    'WHEN YOU STOP:',
    '- When the acceptance criteria hold, finish and report the files you changed. Do not move the card yourself.',
    '- If you cannot finish, say exactly what is missing and stop. The card is marked blocked with that reason.',
    '- A missing design document is never a reason to stop. A style guide or a token file that has not been written yet means the design is provisional, not that the card cannot be done. Build it, say so, and move on.',
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
