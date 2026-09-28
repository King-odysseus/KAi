import { z } from 'zod';
import { ARTIFACT_KINDS, artifactKindSchema, boardStatusSchema, readyCards, type ArtifactKind, type BoardCard } from '@kai/contracts';
import type { StudioArtifacts } from './artifacts';
import type { StudioBoardStore } from './board';
import type { SpecStore } from './spec-store';

/**
 * The `kai-project` server: the studio's artifacts and board, offered to any agent that speaks MCP. It exists so a
 * Claude, Codex, Qwen or Gemini session works the same board as a KAI one, under the same rules.
 *
 * Every tool goes through `spec-store.ts` and `board.ts`; nothing here writes a file itself. That is what makes the
 * promise true — an outside agent gets no shortcut past the checks, and in particular cannot mark a card `done`
 * that has not passed, because `board.move` refuses it before this module sees the answer.
 */

export interface KaiProjectPorts {
  /** The project the server was started for. One process, one project. */
  projectId: string;
  projectRoot(): Promise<string>;
  spec: SpecStore;
  artifacts: StudioArtifacts;
  board: StudioBoardStore;
  now(): string;
}

export interface KaiProjectTool {
  name: string;
  description: string;
  /** The tool's input as a Zod raw shape, which is what the MCP SDK takes. */
  input: z.ZodRawShape;
  run(input: Record<string, unknown>): Promise<unknown>;
}

const cardIdField = z.string().min(1).max(120).describe('The board card id, from get_board.');
const agentField = z.string().min(1).max(120).describe('Your own name, so the card records who held it.');

export function createKaiProjectTools(ports: KaiProjectPorts): KaiProjectTool[] {
  const boardSummary = (card: BoardCard) => ({
    id: card.id,
    title: card.title,
    kind: card.kind,
    status: card.status,
    dependsOn: card.dependsOn,
    needsArtifacts: card.needsArtifacts,
    designRef: card.designRef,
    stale: card.stale,
    claimedBy: card.claimedBy,
    runCount: card.runs.length,
  });

  return [
    {
      name: 'list_artifacts',
      description:
        'List the studio artifacts under .kai/spec with their version, who wrote them and whether they are stale. Read one with read_artifact.',
      input: {},
      run: async () => {
        const catalog = await ports.artifacts.read(ports.projectId);
        return {
          project: ports.projectId,
          artifacts: catalog.artifacts.map((entry) => ({
            kind: entry.kind,
            path: entry.path,
            version: entry.version,
            updatedAt: entry.updatedAt,
            generatedBy: entry.generatedBy,
            dependsOn: entry.dependsOn,
            stale: entry.stale,
            staleReason: entry.staleReason,
          })),
        };
      },
    },
    {
      name: 'read_artifact',
      description:
        'Read one artifact by kind (brief, prd, stories, stack, flows, style-guide, tokens), or any other file under .kai/spec by its spec-relative path.',
      input: {
        kind: artifactKindSchema.optional().describe('An artifact kind, for the files the studio manages.'),
        path: z.string().min(1).max(300).optional().describe('A path relative to .kai/spec, for anything else.'),
      },
      run: async (input) => {
        const kind = input.kind as ArtifactKind | undefined;
        const relative = input.path as string | undefined;
        if (!kind && !relative) throw new Error(`Name a kind (${ARTIFACT_KINDS.join(', ')}) or a path.`);
        if (kind && relative) throw new Error('Name either a kind or a path, not both.');
        const content = kind
          ? await ports.artifacts.readText(ports.projectId, kind)
          : await ports.spec.read(await ports.projectRoot(), specRelative(relative!));
        if (content === null) throw new Error(`There is no ${kind ?? relative} yet.`);
        return { path: kind ?? `.kai/spec/${relative}`, content };
      },
    },
    {
      name: 'get_board',
      description:
        'Read the board: every card with its status, dependencies and whether it is stale. Claim a ready card with claim_task before working it.',
      input: {},
      run: async () => {
        const board = await ports.board.read(ports.projectId);
        return {
          project: ports.projectId,
          cards: board.cards.map(boardSummary),
          ready: readyCards(board).map((card) => card.id),
          // The card's own brief, so an agent knows what to do without a second round trip.
          briefs: Object.fromEntries(
            readyCards(board).map((card) => [card.id, { title: card.title, story: card.story, acceptance: card.acceptance, prompt: card.prompt, route: card.route }]),
          ),
        };
      },
    },
    {
      name: 'claim_task',
      description: 'Take a ready card so no other agent works it. The card moves to inProgress and records you as its holder.',
      input: { cardId: cardIdField, agent: agentField },
      run: async (input) => boardSummary(await ports.board.claim(ports.projectId, input.cardId as string, input.agent as string)),
    },
    {
      name: 'move_task',
      description:
        'Move a card to another status. The same rules apply as inside KAI: moving to ready needs its dependencies done, and moving to done needs a passing check whose files still match the tree — so done will be refused until a check is recorded.',
      input: {
        cardId: cardIdField,
        status: boardStatusSchema,
        note: z.string().max(4_000).optional().describe('Why, when blocking or handing over.'),
      },
      run: async (input) =>
        boardSummary(
          await ports.board.move(ports.projectId, input.cardId as string, input.status as BoardCard['status'], (input.note as string) ?? ''),
        ),
    },
    {
      name: 'submit_output',
      description:
        'Record a finished turn against the card you hold: what you changed and a summary. The card goes to review for the user, or to blocked when you could not finish. It never goes to done — only a passing check does that.',
      input: {
        cardId: cardIdField,
        agent: agentField,
        model: z.string().max(120).optional(),
        summary: z.string().max(4_000).describe('What you did, and anything the reviewer needs to know.'),
        files: z.array(z.string().max(300)).max(200).default([]).describe('The files you changed, project-relative.'),
        outcome: z.enum(['review', 'blocked']).default('review').describe('review when the work is done but unchecked; blocked when you could not finish.'),
      },
      run: async (input) => {
        const cardId = input.cardId as string;
        const agent = input.agent as string;
        const summary = input.summary as string;
        const files = (input.files as string[]) ?? [];
        const outcome = (input.outcome as 'review' | 'blocked') ?? 'review';
        const held = await ports.board.read(ports.projectId);
        const card = held.cards.find((candidate) => candidate.id === cardId);
        if (!card) throw new Error(`No card ${cardId} on the board.`);
        // Submitting without claiming would let a card skip the board's queue; the claim is the lock.
        if (card.status !== 'inProgress' || card.claimedBy !== agent) {
          throw new Error(`Card ${cardId} is not held by ${agent}; claim it with claim_task before submitting output.`);
        }
        await ports.board.recordRun(ports.projectId, cardId, { agent, model: (input.model as string) ?? null, at: ports.now(), files });
        return boardSummary(await ports.board.move(ports.projectId, cardId, outcome, summary));
      },
    },
  ];
}

/** The spec store takes spec-relative paths and rejects an absolute one; a `..` segment would still leave the root. */
function specRelative(relative: string): string {
  const segments = relative.split(/[\\/]+/);
  if (segments.some((segment) => segment === '..')) throw new Error('A spec path may not climb out of .kai/spec.');
  return segments.filter((segment) => segment !== '' && segment !== '.').join('/');
}
