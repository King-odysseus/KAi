import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  AGENTS_FILE,
  ARTIFACT_PATHS,
  STUDIO_STATUS_PATH,
  readyCards,
  type BoardCard,
  type BoardStatus,
  type StudioArtifacts,
  type StudioBoard,
} from '@kai/contracts';
import { resolveInside } from './project-files';
import { SPEC_ROOT } from './spec-store';

/**
 * The two files that let an agent or a person pick a project up cold: `.kai/spec/status.md` (what is done, what is
 * moving, what is next) and `AGENTS.md` in the project root (where to read and how to work the board).
 *
 * Both are written by code from the board and the catalog, never by a model, so they are always true. `status.md`
 * is rewritten whenever the board changes and keeps no history on purpose: it is a snapshot, not a document.
 * `AGENTS.md` is only ever overwritten when it still carries KAI's marker, because a file the user wrote is theirs.
 */

export const AGENTS_MARKER = '<!-- kai:agents -->';

const STATUS_TITLES: Record<BoardStatus, string> = {
  inProgress: 'In progress',
  review: 'In review',
  blocked: 'Blocked',
  ready: 'Ready next',
  backlog: 'Backlog',
  done: 'Done',
};
const STATUS_ORDER: BoardStatus[] = ['inProgress', 'review', 'blocked', 'ready', 'backlog', 'done'];

function who(card: BoardCard): string {
  if (card.movedBy === 'user') return 'you';
  if (card.movedBy === 'check') return 'the check';
  if (card.movedBy === 'agent') return card.claimedBy ? `agent ${card.claimedBy}` : 'an agent';
  return '';
}

function cardLine(card: BoardCard): string {
  const parts = [`**${card.title}** (${card.kind})`];
  const mover = who(card);
  if (mover && card.movedAt) parts.push(`moved by ${mover} on ${card.movedAt.slice(0, 16).replace('T', ' ')}`);
  if (card.stale) parts.push(`stale: ${card.staleReason ?? 'something it reads changed'}`);
  if (card.notes.trim() && (card.status === 'blocked' || card.status === 'review')) parts.push(`note: ${card.notes.trim().replace(/\s+/g, ' ').slice(0, 200)}`);
  return `- ${parts.join(' · ')}`;
}

/** The status snapshot. Pure, so the same board always produces the same text apart from the timestamp. */
export function statusMarkdown(board: StudioBoard, catalog: StudioArtifacts, at: string): string {
  const total = board.cards.length;
  const done = board.cards.filter((card) => card.status === 'done').length;
  const ready = readyCards(board);
  const sections: string[] = [
    '# Project status',
    `_Written by KAI on ${at.slice(0, 16).replace('T', ' ')}. It is rewritten whenever the board changes, so do not edit it by hand._`,
    total === 0 ? 'The board has no cards yet.' : `**${done} of ${total} cards done.**`,
  ];
  const next = ready[0];
  sections.push('## Next step', next ? `Start with **${next.title}**. Claim it with \`claim_task\` before working on it.` : total === 0 ? 'Build the board from the stories.' : 'Nothing is ready: finish or unblock the cards in progress, in review or blocked.');
  for (const status of STATUS_ORDER) {
    const cards = board.cards.filter((card) => card.status === status);
    if (cards.length === 0) continue;
    sections.push(`## ${STATUS_TITLES[status]} (${cards.length})`, cards.map(cardLine).join('\n'));
  }
  const stale = catalog.artifacts.filter((entry) => entry.stale);
  if (stale.length > 0) {
    sections.push('## Stale artifacts', stale.map((entry) => `- ${entry.kind}: ${entry.staleReason ?? 'something it reads changed'}`).join('\n'));
  }
  return `${sections.join('\n\n')}\n`;
}

/** The agent instructions. It points at the files that exist rather than listing ones that do not. */
export function agentsMarkdown(catalog: StudioArtifacts): string {
  const written = catalog.artifacts.map((entry) => entry.kind);
  const reading = written.map((kind) => `- \`${ARTIFACT_PATHS[kind]}\``);
  return [
    AGENTS_MARKER,
    '# Working on this project',
    'This project was planned in the KAI Project Studio. Everything you need to continue is written down in `.kai/spec`, so read it before you change anything.',
    '## Read first',
    `- \`.kai/spec/${STUDIO_STATUS_PATH}\` for what is done, what is in progress and what to do next`,
    ...reading,
    '## How to work',
    '- Take one card at a time from the board. If the `kai-project` tools are available, use `get_board`, then `claim_task` before you start and `submit_output` when you finish.',
    '- Never mark a card done yourself. A card reaches done only through a passing check, so hand it over for review instead.',
    '- Follow `.kai/spec/conventions.md` for naming, layout, tests and commands, and respect the decisions in `.kai/spec/decisions.md`: do not reverse one without saying why.',
    '- If the brief or an artifact is wrong or missing something, say so in your summary instead of quietly working around it.',
    '',
    '_This file is maintained by KAI while it carries the first line above. Delete that line to take it over._',
  ].join('\n') + '\n';
}

async function writeIfChanged(target: string, content: string): Promise<boolean> {
  try {
    if ((await fs.readFile(target, 'utf8')) === content) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
  return true;
}

/**
 * Writes both files. `status.md` always; `AGENTS.md` only once the catalog has artifacts to point at, and never
 * over a file the user wrote. Returns what it wrote so a caller can report it.
 */
export async function writeHandoffFiles(
  root: string,
  board: StudioBoard,
  catalog: StudioArtifacts,
  at: string,
): Promise<{ status: string; agents: string | null }> {
  const statusTarget = await resolveInside(root, path.join(SPEC_ROOT, STUDIO_STATUS_PATH));
  // The timestamp would make every write differ, so a snapshot that changed nothing keeps its old time.
  const previous = await fs.readFile(statusTarget, 'utf8').catch(() => null);
  const fresh = statusMarkdown(board, catalog, at);
  const body = (text: string): string => text.split('\n').filter((line) => !line.startsWith('_Written by KAI on')).join('\n');
  if (previous === null || body(previous) !== body(fresh)) await writeIfChanged(statusTarget, fresh);

  let agents: string | null = null;
  if (catalog.artifacts.length > 0) {
    const agentsTarget = await resolveInside(root, AGENTS_FILE);
    const existing = await fs.readFile(agentsTarget, 'utf8').catch(() => null);
    if (existing === null || existing.startsWith(AGENTS_MARKER)) {
      if (await writeIfChanged(agentsTarget, agentsMarkdown(catalog))) agents = AGENTS_FILE;
    }
  }
  return { status: `${SPEC_ROOT}/${STUDIO_STATUS_PATH}`, agents };
}
