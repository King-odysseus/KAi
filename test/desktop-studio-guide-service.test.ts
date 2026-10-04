import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ARTIFACT_KINDS,
  boardCardSchema,
  createStudioArtifacts,
  createStudioBoard,
  createStudioDesign,
  interviewStateSchema,
  type ArtifactEntry,
  type BoardCard,
  type StudioBoard,
} from '../packages/contracts/src';
import { SpecStore } from '../apps/desktop/src/main/spec-store';
import { STUDIO_GUIDE_PATH } from '../apps/desktop/src/main/studio-guide';
import { DesktopGuideService, type GuidePorts } from '../apps/desktop/src/main/studio-guide-service';

const NOW = '2026-10-04T12:00:00.000Z';
let root = '';

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-guide-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function boardCard(over: Partial<BoardCard> = {}): BoardCard {
  return boardCardSchema.parse({ id: 'c1', title: 'Sign up', kind: 'backend', createdAt: NOW, updatedAt: NOW, ...over });
}

function artifact(kind: ArtifactEntry['kind']): ArtifactEntry {
  return { kind, path: `.kai/spec/${kind}.md`, version: 1, updatedAt: NOW, generatedBy: 'model', dependsOn: [], stale: false, staleReason: null };
}

/**
 * A project that has passed everything up to the board, so a test can move one card and watch what the guide does
 * about it rather than walking a whole project through the studio first.
 */
function harness(options: { cards?: BoardCard[]; interview?: boolean; artifacts?: number } = {}) {
  let calls = 0;
  const board: StudioBoard = { ...createStudioBoard(), cards: options.cards ?? [] };
  const artifacts = {
    ...createStudioArtifacts(),
    artifacts: (options.artifacts === undefined ? ARTIFACT_KINDS.length : options.artifacts) === ARTIFACT_KINDS.length
      ? ARTIFACT_KINDS.map(artifact)
      : ARTIFACT_KINDS.slice(0, options.artifacts).map(artifact),
  };
  const interview = interviewStateSchema.parse({
    projectId: 'p1',
    idea: 'A booking site for a two-chair barber shop',
    goal: 'Bookings',
    assumptions: [],
    rounds: [],
    status: options.interview === false ? 'asking' : 'done',
    briefPath: null,
    linkedProjectId: null,
    archivedAt: null,
    updatedAt: NOW,
  });
  const ports: GuidePorts = {
    settings: async () => ({ promptGuide: {} }) as never,
    requester: {
      structuredRequest: async (_connection, _names, _prompt, _schemaName, _schema, parse) => {
        calls += 1;
        return parse(JSON.stringify({ headline: 'Where you are', explanation: `Explanation ${calls}.` }));
      },
    },
    spec: new SpecStore(),
    projectRoot: async () => root,
    interview: async () => (options.interview === false ? null : interview),
    artifacts: async () => artifacts,
    board: async () => board,
    design: async () => createStudioDesign(),
    now: () => NOW,
  };
  return { service: new DesktopGuideService(ports), board, calls: () => calls, root };
}

describe('the Senior Dev service', () => {
  it('reads the steps without calling the provider, so the board strip stays free', async () => {
    const h = harness({ cards: [
      boardCard({ id: 'a', status: 'done' }),
      boardCard({ id: 'b', status: 'blocked', movedBy: 'agent', notes: 'The run failed: the agent exited.' }),
      boardCard({ id: 'c', status: 'backlog' }),
    ] });

    const view = await h.service.read('p1');

    expect(h.calls()).toBe(0);
    expect(view.currentStepId).toBe('work');
    const work = view.steps.find((step) => step.id === 'work');
    expect(work?.state).toBe('blocked');
    expect(work?.action).toBe('requeue-blocked');
    // The cached explanation is the only thing `read` will show, and there is none yet.
    expect(view.narrative).toBeNull();
  });

  it('pays for one explanation per situation, not one per look', async () => {
    const h = harness({ cards: [boardCard({ id: 'a', status: 'ready' })] });

    const first = await h.service.explain('p1');
    const second = await h.service.explain('p1');

    expect(h.calls()).toBe(1);
    expect(first.narrative?.explanation).toBe('Explanation 1.');
    expect(second.narrative?.explanation).toBe('Explanation 1.');
    expect(second.narrativeAt).toBe(NOW);
  });

  it('does not rewrite the words because cards moved', async () => {
    const h = harness({ cards: [
      boardCard({ id: 'a', status: 'done' }),
      boardCard({ id: 'b', status: 'ready' }),
      boardCard({ id: 'c', status: 'ready' }),
    ] });
    await h.service.explain('p1');

    // Three more cards finish. The guide has nothing new to say about the step they are on.
    h.board.cards[1]!.status = 'done';
    h.board.cards[2]!.status = 'inProgress';
    await h.service.explain('p1');

    expect(h.calls()).toBe(1);
  });

  it('rewrites when a card starts needing a person', async () => {
    const h = harness({ cards: [boardCard({ id: 'a', status: 'done' }), boardCard({ id: 'b', status: 'ready' })] });
    await h.service.explain('p1');

    // An agent gives up on a card: the step is the same, but it is now stuck on the reader.
    h.board.cards[1]!.status = 'blocked';
    h.board.cards[1]!.movedBy = 'agent';
    const stuck = await h.service.explain('p1');

    expect(h.calls()).toBe(2);
    expect(stuck.steps.find((step) => step.id === 'work')?.state).toBe('blocked');
  });

  it('remembers what has been done on disk, so a later look does not start the history again', async () => {
    const h = harness({ cards: [boardCard({ id: 'a', status: 'ready' })] });
    await h.service.read('p1');

    const file = path.join(h.root, '.kai', 'spec', STUDIO_GUIDE_PATH);
    const written = JSON.parse(fs.readFileSync(file, 'utf8')) as { history: Array<{ stepId: string }> };
    // Everything up to the board was already behind this project, and the guide records that it was.
    expect(written.history.map((entry) => entry.stepId)).toEqual(['describe', 'questions', 'brief', 'artifacts', 'board']);

    // A second read on a fresh service over the same folder finds the history rather than rewriting it.
    const again = await h.service.read('p1');
    expect(again.history).toHaveLength(5);
  });

  it('counts the project it is actually looking at', async () => {
    const h = harness({
      cards: [
        boardCard({ id: 'a', kind: 'page', route: '', status: 'blocked', movedBy: 'agent' }),
        boardCard({ id: 'b', status: 'done' }),
      ],
      artifacts: 3,
    });

    const view = await h.service.read('p1');

    // Three of the catalog written, so the artifacts step is where the project is, and the detail says so.
    expect(view.currentStepId).toBe('artifacts');
    expect(view.steps.find((step) => step.id === 'artifacts')?.detail).toContain(`3 of ${ARTIFACT_KINDS.length}`);
  });
});
