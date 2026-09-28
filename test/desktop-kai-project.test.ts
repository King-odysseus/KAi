import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boardCardSchema, studioBoardSchema, type BoardCard } from '../packages/contracts/src';
import { StudioArtifacts } from '../apps/desktop/src/main/artifacts';
import { StudioBoardStore } from '../apps/desktop/src/main/board';
import { createKaiProjectTools, type KaiProjectPorts } from '../apps/desktop/src/main/kai-project-tools';
import { SpecStore } from '../apps/desktop/src/main/spec-store';

/**
 * The `kai-project` server is how an outside agent works KAI's board. These tests run it against a real spec folder,
 * because the promise is that an outside agent gets the same rules as a KAI one — and those rules live in the stores.
 */

const AT = '2026-09-28T12:00:00.000Z';

function card(id: string, extra: Partial<BoardCard> = {}): BoardCard {
  return boardCardSchema.parse({ id, title: `${id} card`, kind: 'component', createdAt: AT, updatedAt: AT, ...extra });
}

class Server {
  readonly root: string;
  private readonly spec = new SpecStore();
  private readonly ports: KaiProjectPorts;

  private constructor(root: string) {
    this.root = root;
    const projectRoot = async (): Promise<string> => root;
    const now = (): string => AT;
    this.ports = {
      projectId: 'current',
      projectRoot,
      spec: this.spec,
      artifacts: new StudioArtifacts({ spec: this.spec, projectRoot, now }),
      board: new StudioBoardStore({ spec: this.spec, projectRoot, dirtyFiles: async () => null, hashFile: async () => null, run: async () => null, now }),
      now,
    };
  }

  static async create(cards: BoardCard[] = []): Promise<Server> {
    const root = await mkdtemp(path.join(tmpdir(), 'kai-project-'));
    const server = new Server(root);
    if (cards.length > 0) {
      await server.spec.write(root, 'board.json', JSON.stringify(studioBoardSchema.parse({ schemaVersion: 1, cards })));
    }
    return server;
  }

  tool(name: string) {
    const found = createKaiProjectTools(this.ports).find((candidate) => candidate.name === name);
    if (!found) throw new Error(`No tool ${name}.`);
    return found.run;
  }

  names(): string[] {
    return createKaiProjectTools(this.ports).map((tool) => tool.name);
  }

  specStore(): SpecStore {
    return this.spec;
  }

  async board(): Promise<BoardCard[]> {
    return (await this.ports.board.read('current')).cards;
  }
}

let server: Server;

afterEach(async () => {
  await rm(server.root, { recursive: true, force: true });
});

describe('the kai-project tools an outside agent is given', () => {
  it('exposes the six the plan names, and nothing else', async () => {
    server = await Server.create();
    expect(server.names().sort()).toEqual(['claim_task', 'get_board', 'list_artifacts', 'move_task', 'read_artifact', 'submit_output']);
  });
});

describe('reading the artifacts', () => {
  beforeEach(async () => {
    server = await Server.create();
  });

  it('lists the catalog the studio keeps, adopting a brief written to disk, and reads either by kind', async () => {
    await server.specStore().write(server.root, 'brief.md', '# The idea\n');
    await server.specStore().write(server.root, 'prd.md', '# The PRD\n');

    const listed = (await server.tool('list_artifacts')({})) as { artifacts: Array<{ kind: string; version: number }> };

    // The brief is adopted because the interview writes it; a stray file is not invented into the catalog.
    expect(listed.artifacts.map((entry) => entry.kind)).toEqual(['brief']);
    expect(await server.tool('read_artifact')({ kind: 'brief' })).toMatchObject({ content: '# The idea\n' });
    // Reading is tolerant: an outside agent can still read a file the catalog does not list.
    expect(await server.tool('read_artifact')({ path: 'prd.md' })).toMatchObject({ content: '# The PRD\n' });
  });

  it('refuses a path that would climb out of the spec folder', async () => {
    await expect(server.tool('read_artifact')({ path: '../../.git/config' })).rejects.toThrow('may not climb out');
  });

  it('asks for one of kind or path, and says so when neither is given', async () => {
    await expect(server.tool('read_artifact')({})).rejects.toThrow('Name a kind');
    await expect(server.tool('read_artifact')({ kind: 'brief', path: 'brief.md' })).rejects.toThrow('not both');
  });

  it('reports a missing artifact as missing rather than as empty text', async () => {
    await expect(server.tool('read_artifact')({ kind: 'prd' })).rejects.toThrow('There is no prd yet');
  });
});

describe('working the board', () => {
  beforeEach(async () => {
    server = await Server.create([card('button', { status: 'ready' }), card('sign-in', { status: 'backlog', dependsOn: ['button'] })]);
  });

  it('names the ready cards and carries their brief so the agent needs one call, not two', async () => {
    const board = (await server.tool('get_board')({})) as { ready: string[]; briefs: Record<string, { title: string }> };

    expect(board.ready).toEqual(['button']);
    expect(board.briefs.button?.title).toBe('button card');
    expect(board.briefs['sign-in']).toBeUndefined();
  });

  it('takes a card for one agent and refuses a second claim by another', async () => {
    const claimed = (await server.tool('claim_task')({ cardId: 'button', agent: 'claude' })) as { status: string; claimedBy: string };

    expect(claimed.status).toBe('inProgress');
    expect(claimed.claimedBy).toBe('claude');
    await expect(server.tool('claim_task')({ cardId: 'button', agent: 'codex' })).rejects.toThrow('already held by claude');
  });

  it('refuses output from an agent that never claimed the card', async () => {
    await expect(server.tool('submit_output')({ cardId: 'button', agent: 'codex', summary: 'done' })).rejects.toThrow('claim it with claim_task');
  });

  it('records what an agent changed and hands the card to review, releasing the claim', async () => {
    await server.tool('claim_task')({ cardId: 'button', agent: 'claude' });

    const result = (await server.tool('submit_output')({
      cardId: 'button',
      agent: 'claude',
      model: 'claude-sonnet-5',
      summary: 'Built the button.',
      files: ['src/Button.tsx'],
    })) as { status: string; claimedBy: string | null };

    expect(result.status).toBe('review');
    expect(result.claimedBy).toBeNull();
    const [button] = await server.board();
    expect(button!.notes).toBe('Built the button.');
    expect(button!.runs).toHaveLength(1);
    expect(button!.runs[0]).toMatchObject({ agent: 'claude', model: 'claude-sonnet-5', files: ['src/Button.tsx'] });
  });

  it('lets an agent block a card with what it needs, rather than leaving it held', async () => {
    await server.tool('claim_task')({ cardId: 'button', agent: 'claude' });

    const result = (await server.tool('submit_output')({ cardId: 'button', agent: 'claude', summary: 'Waiting on the API key.', outcome: 'blocked' })) as { status: string };

    expect(result.status).toBe('blocked');
    expect((await server.board())[0]!.notes).toBe('Waiting on the API key.');
  });

  it('refuses to move a card to done with no passing check, and leaves the status alone', async () => {
    await expect(server.tool('move_task')({ cardId: 'button', status: 'done' })).rejects.toThrow('no record of a passing check');
    expect((await server.board())[0]!.status).toBe('ready');
  });

  it('refuses to ready a card whose dependency is not done', async () => {
    await expect(server.tool('move_task')({ cardId: 'sign-in', status: 'ready' })).rejects.toThrow('blocked by button');
  });

  it('moves a card and keeps the reason it was blocked', async () => {
    const moved = (await server.tool('move_task')({ cardId: 'button', status: 'blocked', note: 'Needs the design pull first.' })) as { status: string };

    expect(moved.status).toBe('blocked');
    expect((await server.board())[0]!.notes).toBe('Needs the design pull first.');
  });
});
