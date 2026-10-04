import { describe, expect, it } from 'vitest';
import {
  boardCardSchema,
  cardsFromDraft,
  createDefaultSettings,
  type AgentCapability,
  type AgentRunRequest,
  type AgentRunResult,
  type ArtifactKind,
  type BoardCard,
  type CardRun,
  type ConversationRecord,
  type StudioBoard,
  type TeamPart,
} from '../packages/contracts/src';
import { boardCardPart, boardCardPrompt, briefArtifacts, roleForCard } from '../apps/desktop/src/main/board-brief';
import { DesktopTeamPlanner, type TeamPlannerPorts } from '../apps/desktop/src/main/team-planner';

const ALL = ['claude', 'codex', 'qwen', 'gemini', 'kimi'] as const;
const NAME_OF: Record<(typeof ALL)[number], string> = { claude: 'Claude', codex: 'Codex', qwen: 'Qwen Code', gemini: 'Gemini CLI', kimi: 'Kimi Code' };
const AT = '2026-09-28T12:00:00.000Z';

function card(id: string, kind: BoardCard['kind'], extra: Partial<BoardCard> = {}): BoardCard {
  return boardCardSchema.parse({
    id,
    title: `${id} card`,
    kind,
    story: `As a visitor I want ${id}.`,
    acceptance: [`${id} works`, `${id} is tested`],
    needsArtifacts: ['brief', 'prd', 'stories'],
    createdAt: AT,
    updatedAt: AT,
    ...extra,
  });
}

function board(cards: BoardCard[]): StudioBoard {
  return { schemaVersion: 1, cards };
}

const ARTIFACTS: Partial<Record<ArtifactKind, string>> = { brief: '# Brief', prd: '# PRD', stories: '# Stories' };

describe('board briefs', () => {
  it('sends each kind of card to the agent that works it', () => {
    expect(roleForCard({ kind: 'component' })).toBe('frontend');
    expect(roleForCard({ kind: 'page' })).toBe('frontend');
    expect(roleForCard({ kind: 'flow' })).toBe('frontend');
    expect(roleForCard({ kind: 'backend' })).toBe('backend');
    expect(roleForCard({ kind: 'chore' })).toBe('backend');
  });

  it('names an artifact the card needs but nobody has written, rather than dropping it', () => {
    const text = briefArtifacts(card('sign-in', 'page'), { brief: '# Brief' });

    expect(text).toContain('BRIEF');
    expect(text).toContain('# Brief');
    expect(text).toContain('PRD');
    // The sentence is shouted on purpose: a missing document used to read as "ask for it rather than inventing it",
    // which agents obeyed by stopping, and a card that stops on a missing design is a card that never gets built.
    expect(text).toContain('NOT WRITTEN YET');
  });

  it('carries the story, the acceptance criteria, the design node and the last screenshots', () => {
    const prompt = boardCardPrompt(card('sign-in', 'page', {
      designRef: 'node-12',
      route: '/sign-in',
      check: { runId: 'visual-only', at: AT, visual: 'failed', screenshots: ['board/sign-in/2026-09-28/phone-light.png'] },
    }), ARTIFACTS);

    expect(prompt).toContain('CARD sign-in — sign-in card (page)');
    expect(prompt).toContain('As a visitor I want sign-in.');
    expect(prompt).toContain('- sign-in works');
    expect(prompt).toContain('open-pencil node "node-12"');
    expect(prompt).toContain('board/sign-in/2026-09-28/phone-light.png');
  });

  it('tells the agent it does not decide that the work is verified', () => {
    const prompt = boardCardPrompt(card('sign-in', 'page'), ARTIFACTS);

    expect(prompt).toContain('WHEN YOU STOP');
    expect(prompt).toContain('Do not move the card yourself');
    expect(prompt).toContain('Never claim the work is verified');
  });

  it('trims a card to the widths a plan part allows', () => {
    const long = card('sign-in', 'page', { title: 'x'.repeat(180), prompt: 'y'.repeat(9_000), dependsOn: Array.from({ length: 20 }, (_, index) => `dep-${index}`) });
    const part = boardCardPart(long, ARTIFACTS);

    expect(part.id.length).toBeLessThanOrEqual(40);
    expect(part.title.length).toBeLessThanOrEqual(120);
    expect(part.prompt.length).toBeLessThanOrEqual(6_000);
    expect(part.dependsOn.length).toBeLessThanOrEqual(12);
    expect(part.role).toBe('frontend');
    // Every part must satisfy the schema it will be validated against later.
    expect(() => boardPartSchemaCheck(part)).not.toThrow();
  });
});

/** The parts a plan is validated against; the test asserts a card's part really fits. */
function boardPartSchemaCheck(part: TeamPart): void {
  expect(part.prompt.trim().length).toBeGreaterThan(0);
  expect(part.title.trim().length).toBeGreaterThan(0);
  expect(part.dependsOn.every((id) => id.length <= 40)).toBe(true);
}

function capability(id: (typeof ALL)[number]): AgentCapability {
  return {
    id,
    displayName: NAME_OF[id],
    available: true,
    state: 'ready',
    command: id,
    signInCommand: id,
    installUrl: 'https://example.com',
    supportsRoutes: ['direct', 'proxy'],
    supportsAutonomy: ['plan', 'ask', 'autoEdit', 'full'],
  } as AgentCapability;
}

interface Harness {
  planner: DesktopTeamPlanner;
  requests: AgentRunRequest[];
  runs: CardRun[];
  moves: Array<{ cardId: string; status: string; note: string }>;
  claims: string[];
  defaultAgent: string;
}

function planner(cards: BoardCard[], options: { replies?: AgentRunResult[]; extra?: Partial<TeamPlannerPorts> } = {}): Harness {
  const requests: AgentRunRequest[] = [];
  const runs: CardRun[] = [];
  const moves: Array<{ cardId: string; status: string; note: string }> = [];
  const claims: string[] = [];
  const settings = createDefaultSettings();
  // The board is the source of truth, so a claim or a move really takes the card out of the next read.
  let live = [...cards];
  const patch = (cardId: string, change: Partial<BoardCard>): BoardCard => {
    const found = live.find((item) => item.id === cardId);
    const next = boardCardSchema.parse({ ...(found ?? card(cardId, 'chore')), ...change, updatedAt: AT });
    live = live.map((item) => (item.id === cardId ? next : item));
    return next;
  };
  let reply = 0;
  const ports: TeamPlannerPorts = {
    settings: async () => settings,
    agentCapabilities: async () => ALL.map((id) => capability(id)),
    directApi: async () => ({ available: true, displayName: 'KAI API' }),
    proxyReady: async () => true,
    createConversation: async (projectId, title) => ({ id: 'conversation', projectId, title } as ConversationRecord),
    runAgent: async (request) => {
      requests.push(request);
      return options.replies?.[reply++] ?? { conversation: {} as ConversationRecord, status: 'completed', output: 'done' };
    },
    startWorkflow: async () => { throw new Error('A board plan is not started from here.'); },
    board: async () => board(live),
    artifactsFor: async () => ARTIFACTS,
    claimCard: async (_projectId, cardId, agent) => {
      claims.push(`${cardId}:${agent}`);
      return patch(cardId, { claimedBy: agent, status: 'inProgress' });
    },
    recordCardRun: async (_projectId, cardId, run) => {
      runs.push(run);
      return patch(cardId, { runs: [run] });
    },
    moveCard: async (_projectId, cardId, status, note) => {
      moves.push({ cardId, status, note: note ?? '' });
      return patch(cardId, { status, claimedBy: null });
    },
    changedFilesFor: async () => ['src/sign-in.tsx'],
    ...options.extra,
  };
  return { planner: new DesktopTeamPlanner(ports), requests, runs, moves, claims, defaultAgent: settings.defaultAgent };
}

describe('planning from the board', () => {
  it('makes one part per ready card from the card itself, with no orchestrator call', async () => {
    const { planner: service, requests } = planner([
      card('sign-in', 'page', { status: 'ready' }),
      card('auth-api', 'backend', { status: 'ready' }),
      card('later', 'chore'),
    ]);

    const draft = await service.planFromBoard('p1');

    expect(requests).toHaveLength(0);
    expect(draft.source).toBe('board');
    expect(draft.parts.map((part) => part.id)).toEqual(['sign-in', 'auth-api']);
    expect(draft.parts.every((part) => part.prompt.includes('CARD'))).toBe(true);
    expect(draft.warnings.join(' ')).toContain('only moved to done by the board');
  });

  it('leaves a card whose dependency is not done where it is', async () => {
    const { planner: service } = planner([
      card('auth-api', 'backend', { status: 'ready' }),
      card('sign-in', 'page', { status: 'ready', dependsOn: ['auth-api'] }),
    ]);

    const draft = await service.planFromBoard('p1');

    expect(draft.parts.map((part) => part.id)).toEqual(['auth-api']);
  });

  it('refuses to plan when nothing is ready', async () => {
    const { planner: service } = planner([card('later', 'chore')]);

    await expect(service.planFromBoard('p1')).rejects.toThrow('No card is ready');
  });

  it('refuses when the planner has no board behind it', async () => {
    const { planner: service } = planner([card('sign-in', 'page', { status: 'ready' })], { extra: { board: undefined } });

    await expect(service.planFromBoard('p1')).rejects.toThrow('board is not available');
  });
});

describe('working the board', () => {
  it('claims the next ready card, runs it, records what it changed, and stops at review', async () => {
    const { planner: service, requests, runs, moves, claims, defaultAgent } = planner([card('sign-in', 'page', { status: 'ready' })]);

    const worked = await service.workBoard('p1', 7);

    expect(claims).toEqual([`sign-in:${NAME_OF[defaultAgent as (typeof ALL)[number]]}`]);
    expect(requests[0]!.agent).toBe(defaultAgent);
    expect(requests[0]!.prompt).toContain('CARD sign-in — sign-in card (page)');
    expect(runs[0]).toMatchObject({ agent: defaultAgent, files: ['src/sign-in.tsx'] });
    expect(moves[0]).toMatchObject({ cardId: 'sign-in', status: 'review' });
    expect(worked[0]!.status).toBe('review');
    expect(worked.some((item) => item.status === 'done')).toBe(false);
  });

  it('blocks the card with the failure when the run fails, and never calls it done', async () => {
    const { planner: service, moves } = planner([card('sign-in', 'page', { status: 'ready' })], {
      replies: [{ conversation: {} as ConversationRecord, status: 'failed', output: '', error: 'The CLI exited 1.' }],
    });

    const worked = await service.workBoard('p1', 7);

    expect(moves[0]).toMatchObject({ cardId: 'sign-in', status: 'blocked' });
    expect(moves[0]!.note).toContain('The CLI exited 1.');
    expect(worked[0]!.status).toBe('blocked');
  });

  it('works as many cards as asked, and stops when none are left', async () => {
    const { planner: service, requests } = planner([
      card('one', 'chore', { status: 'ready' }),
      card('two', 'chore', { status: 'ready' }),
    ]);

    const worked = await service.workBoard('p1', 7, { maxCards: 5 });

    expect(worked).toHaveLength(2);
    expect(requests).toHaveLength(2);
  });

  it('refuses to run when no agent is reachable', async () => {
    const { planner: service, requests } = planner([card('sign-in', 'page', { status: 'ready' })], {
      extra: {
        agentCapabilities: async () => ALL.map((id) => ({ ...capability(id), available: false, state: 'not_installed' as const })),
        directApi: async () => ({ available: false, displayName: 'KAI API' }),
      },
    });

    await expect(service.workBoard('p1', 7)).rejects.toThrow('no card can run');
    expect(requests).toHaveLength(0);
  });
});

describe('board work inputs', () => {
  it('takes the board shape the studio writes', () => {
    const cards = cardsFromDraft({ cards: [{ key: 'sign-in', title: 'Sign in', kind: 'page', route: '/sign-in', dependsOnKeys: [] }] }, AT);

    expect(cards[0]!.route).toBe('/sign-in');
    expect(cards[0]!.status).toBe('backlog');
  });
});
