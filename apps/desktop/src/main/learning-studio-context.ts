import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ARTIFACT_PATHS, studioArtifactsSchema, studioBoardSchema, type ArtifactKind, type BoardCard, type LearningTutorRequest } from '@kai/contracts';

const MAX_CARD_CHARS = 3_000;
const MAX_ARTIFACT_CHARS = 2_000;
const MAX_CONTEXT_CHARS = 9_000;
const DEFAULT_ARTIFACTS: ArtifactKind[] = ['brief', 'stories', 'acceptance'];

/** Reads only the Studio evidence relevant to this question. The board and catalog stay authoritative on disk. */
export async function loadLearningStudioContext(projectRoot: string, request: LearningTutorRequest): Promise<string | null> {
  const specRoot = path.join(projectRoot, '.kai', 'spec');
  const [boardRaw, catalogRaw] = await Promise.all([
    fs.readFile(path.join(specRoot, 'board.json'), 'utf8').catch(() => ''),
    fs.readFile(path.join(specRoot, 'artifacts.json'), 'utf8').catch(() => ''),
  ]);
  const board = parseBoard(boardRaw);
  const catalog = parseCatalog(catalogRaw);
  const query = [request.question, request.filePath, request.selectedText?.slice(0, 500)].filter(Boolean).join(' ').toLowerCase();
  const terms = [...new Set(query.match(/[a-z][a-z0-9_-]{3,}/g) ?? [])].filter((term) => !['what', 'this', 'that', 'with', 'from', 'code', 'file', 'please', 'help'].includes(term)).slice(0, 15);
  const selected = request.studioCardId ? board?.cards.find((card) => card.id === request.studioCardId) : null;
  const ranked = (board?.cards ?? []).map((card) => ({ card, score: cardScore(card, terms, request) }))
    .filter(({ score }) => score > 0).sort((a, b) => b.score - a.score);
  const card = selected ?? ranked[0]?.card ?? (request.action === 'next-step' ? board?.cards.find((item) => item.status === 'inProgress' || item.status === 'ready') : null);
  const parts: string[] = [];
  if (card) {
    const dependencyNames = card.dependsOn.map((id) => board?.cards.find((item) => item.id === id)).filter((item): item is BoardCard => Boolean(item));
    // The files earlier runs of this card touched. They are the concrete answer to "how does this file relate to the
    // board", so the tutor can name a file to open instead of describing the work in the abstract.
    const cardFiles = [...new Set(card.runs.flatMap((run) => run.files))].slice(0, 12);
    const checkedOut = card.dependsOn.filter((id) => board?.cards.find((item) => item.id === id)?.status !== 'done');
    const details = [
      `Studio card: ${card.title} (${card.id}; ${card.kind}; ${card.status})`,
      card.story && `Story: ${card.story}`,
      card.acceptance.length && `Acceptance: ${card.acceptance.join('; ')}`,
      card.acceptance.length && `Acceptance evidence: ${card.acceptance.map((criterion) => {
        const evidence = card.check?.acceptanceEvidence?.find((item) => item.criterion === criterion);
        return `${criterion} — ${evidence?.status ?? 'not checked'}${evidence?.evidence ? ` (${evidence.evidence})` : ''}`;
      }).join('; ')}`,
      card.checks.length && `Checks: ${card.checks.join('; ')}`,
      card.route && `Route: ${card.route}`,
      cardFiles.length && `Files this card touches: ${cardFiles.join(', ')}`,
      card.needsArtifacts.length && `Reads artifacts: ${card.needsArtifacts.join(', ')}`,
      dependencyNames.length && `Dependencies: ${dependencyNames.map((item) => `${item.title} (${item.status})`).join('; ')}`,
      checkedOut.length && `Not yet done, so this card cannot start: ${checkedOut.join('; ')}`,
      card.stale && `STALE CARD: ${card.staleReason ?? 'A dependency changed.'}`,
      card.notes && `Notes: ${card.notes}`,
    ].filter(Boolean).join('\n').slice(0, MAX_CARD_CHARS);
    // The card's first line in board.json, so a citation of the board lands on the card rather than the whole file.
    const boardLines = boardRaw.split('\n');
    const cardLine = boardLines.findIndex((value) => value.includes(`"id": "${card.id}"`)) + 1;
    parts.push(cardLine > 1
      ? `${details}\nFile: .kai/spec/board.json\n${cardLine}: ${boardLines[cardLine - 1]}`
      : `${details}\nFile: .kai/spec/board.json\n1: {`);
  }
  const artifactKinds = new Set<ArtifactKind>(card ? [...card.needsArtifacts, ...DEFAULT_ARTIFACTS] : []);
  if (!card && terms.length) {
    for (const kind of DEFAULT_ARTIFACTS) if (terms.some((term) => kind.includes(term))) artifactKinds.add(kind);
  }
  for (const kind of [...artifactKinds].slice(0, 4)) {
    const relative = ARTIFACT_PATHS[kind];
    const content = await fs.readFile(path.join(projectRoot, relative), 'utf8').catch(() => '');
    if (!content.trim()) continue;
    const entry = catalog?.artifacts.find((item) => item.kind === kind);
    const lines = content.slice(0, MAX_ARTIFACT_CHARS).split('\n').map((line, index) => `${index + 1}: ${line}`).join('\n');
    parts.push(`File: ${relative}\nStatus: ${entry?.stale ? `STALE — ${entry.staleReason ?? 'A dependency changed.'}` : 'current or untracked'}\n${lines}${content.length > MAX_ARTIFACT_CHARS ? '\n[truncated]' : ''}`);
  }
  if (!parts.length) return null;
  return `Project Studio evidence. Cite the supplied board or artifact file in sourceNotes when using it. Treat stale content as provisional and tell the learner why.\n\n${parts.join('\n\n')}`.slice(0, MAX_CONTEXT_CHARS);
}

function cardScore(card: BoardCard, terms: string[], request: LearningTutorRequest): number {
  if (!terms.length) return 0;
  const title = card.title.toLowerCase();
  const body = [card.story, ...card.acceptance, card.prompt, ...card.runs.flatMap((run) => run.files)].join(' ').toLowerCase();
  const score = terms.reduce((sum, term) => sum + (title.includes(term) ? 4 : 0) + (body.includes(term) ? 1 : 0), 0);
  return score + (request.filePath && card.runs.some((run) => run.files.includes(request.filePath!)) ? 8 : 0);
}

function parseBoard(raw: string): ReturnType<typeof studioBoardSchema.parse> | null {
  try { return studioBoardSchema.parse(JSON.parse(raw)); } catch { return null; }
}

function parseCatalog(raw: string): ReturnType<typeof studioArtifactsSchema.parse> | null {
  try { return studioArtifactsSchema.parse(JSON.parse(raw)); } catch { return null; }
}
