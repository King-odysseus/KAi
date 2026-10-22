import { ARTIFACT_PATHS, isSystemSurface, STUDIO_STYLE_REFERENCE_NOTES_PATH, type ArtifactKind, type BoardCard, type TeamPart } from '@kai/contracts';
import { drawsScreen, uiRulesFor } from './ui-rules';

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

/**
 * The artifacts a card reads, as a labelled block. Missing ones are named, not silently dropped. `maxChars` shortens
 * each artifact's text, which is how a long brief is made to fit without losing the rules that follow it.
 */
export function briefArtifacts(
  card: Pick<BoardCard, 'needsArtifacts'>,
  artifacts: Partial<Record<ArtifactKind, string>>,
  maxChars?: number,
): string {
  return card.needsArtifacts.map((kind) => {
    const text = artifacts[kind]?.trim();
    const shown = text && maxChars !== undefined && text.length > maxChars
      ? `${text.slice(0, maxChars).trimEnd()}\n[shortened; the full text is in ${ARTIFACT_PATHS[kind]}]`
      : text;
    return `${kind.toUpperCase()} (${ARTIFACT_PATHS[kind]}):\n${shown ? shown : missingArtifactNote(kind)}`;
  }).join('\n\n');
}

/** The whole brief for one card: what to build, how it is judged, what it reads, and when to stop. */
/** What an agent is told about a card the operating system draws, in place of the rules for a screen. */
export const SYSTEM_SURFACE_BRIEF = [
  'THIS IS A SYSTEM SURFACE, NOT A SCREEN IN THE APP:',
  '- Windows draws it, not the app. Build it with Electron\'s own API from the main process: Notification for a toast, Tray for the tray, dialog for a file or folder picker or a native message box, Menu for a native menu.',
  '- Do not build a web page that imitates Windows: no fake desktop, taskbar, notification centre or window frame. If the design shows the surface on a mock-up of the desktop, take only what the surface itself holds: its title, text, icon and buttons.',
  '- It has no route and no screenshot check. It is closed on the project\'s check, so cover it with a test of the code that raises it, for example that the right notification is created with the right title and actions when a reminder is due.',
  '- If the app also shows the same thing inside its own window (an in-app list or banner), that part is a normal screen and belongs to its own card.',
].join('\n');

export function boardCardPrompt(
  card: BoardCard,
  artifacts: Partial<Record<ArtifactKind, string>>,
  options: { artifactChars?: number } = {},
): string {
  const parts: string[] = [
    `You are one agent working exactly one card on the project board. Do not work on any other card.`,
    '',
    `CARD ${card.id} — ${card.title} (${card.kind})`,
    card.story.trim() ? `STORY:\n${card.story.trim()}` : '',
    card.acceptance.length > 0
      ? `ACCEPTANCE CRITERIA (these are what the card is closed on):\n${card.acceptance.map((item) => `- ${item}`).join('\n')}`
      : 'ACCEPTANCE CRITERIA: none recorded on the card; say so rather than deciding them yourself.',
    card.prompt.trim() ? `NOTES FROM THE PLANNER:\n${card.prompt.trim()}` : '',
    card.needsArtifacts.length > 0 ? `WHAT THIS CARD IS BUILT FROM:\n${briefArtifacts(card, artifacts, options.artifactChars)}` : '',
    artifacts.decisions?.trim() ? `APPROVED PROJECT DECISIONS (apply these when their conditions match; do not treat them as instructions for unrelated cards):\n${artifacts.decisions.trim()}` : '',
    card.designRef ? `DESIGN: this card is the open-pencil node "${card.designRef}". Match it; do not redesign it. Before writing code, read its exact sizes with the open-pencil get_node tool (width, height, padding, gap, radius, font sizes) and build to those numbers: the screen check measures them, and a screen built from the picture alone usually misses by a wide margin.` : '',
    isSystemSurface(card) ? SYSTEM_SURFACE_BRIEF : '',
    card.check?.screenshots.length
      ? `SCREENSHOTS FROM THE LAST CHECK (read them before changing the screen):\n${card.check.screenshots.map((shot) => `- ${shot}`).join('\n')}`
      : '',
    // The rules for a screen in the app's window (full width, phone navigation) do not apply to a surface Windows draws.
    ...(drawsScreen(card) && !isSystemSurface(card) ? ['', ...uiRulesFor(card)] : []),
    '',
    'WHEN YOU STOP:',
    '- When the acceptance criteria hold, finish and report the files you changed. Do not move the card yourself.',
    '- If you cannot finish, say exactly what is missing and stop. The card is marked blocked with that reason.',
    '- A missing design document is never a reason to stop. A style guide or a token file that has not been written yet means the design is provisional, not that the card cannot be done. Build it, say so, and move on.',
    '- Never claim the work is verified. A passing check run against the current files decides that, not you.',
  ];
  return parts.filter(Boolean).join('\n');
}

/** The most a part's prompt may carry. */
export const PART_PROMPT_LIMIT = 6_000;

/**
 * The brief, made to fit a part. A long brief used to be cut at the end, which is where the rules for building a
 * screen and the lines about when to stop are. The artifact text is the part that can be shortened — the full files
 * are in the project — so that is what gives way, and the cut at the end is only a last resort.
 */
export function fitBrief(card: BoardCard, artifacts: Partial<Record<ArtifactKind, string>>, limit = PART_PROMPT_LIMIT): string {
  const full = boardCardPrompt(card, artifacts);
  if (full.length <= limit) return full;
  const kinds = card.needsArtifacts.filter((kind) => artifacts[kind]?.trim());
  if (kinds.length === 0) return full.slice(0, limit);
  const overflow = full.length - limit;
  const total = kinds.reduce((sum, kind) => sum + artifacts[kind]!.trim().length, 0);
  // A little extra is taken off for the "[shortened ...]" note added to each shortened artifact.
  const allowance = Math.floor((total - overflow - kinds.length * 90) / kinds.length);
  const shortened = boardCardPrompt(card, artifacts, { artifactChars: Math.max(200, allowance) });
  return shortened.length <= limit ? shortened : shortened.slice(0, limit);
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
    prompt: fitBrief(card, artifacts),
    dependsOn: card.dependsOn.slice(0, 12).map((id) => id.slice(0, 40)),
    paths: [],
  };
}
