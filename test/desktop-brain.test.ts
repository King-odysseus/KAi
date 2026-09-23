import * as http from 'node:http';
import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Cognitive1Client } from '../apps/desktop/src/main/cognitive1-client';
import { AuthenticatedLoopbackGateway } from '../packages/integrations/src';

const servers: http.Server[] = [];
const gateways: AuthenticatedLoopbackGateway[] = [];

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.stop()));
  await Promise.all(servers.splice(0).map(closeServer));
});

describe('desktop Cognitive1 brain client', () => {
  it('normalizes overview and recall data without exposing the gateway token upstream', async () => {
    const token = 'brain-client-test-token';
    const observedAuthorization: Array<string | undefined> = [];
    const receivedBodies: unknown[] = [];
    const upstream = http.createServer(async (request, response) => {
      observedAuthorization.push(request.headers.authorization);
      const body = await readBody(request);
      receivedBodies.push(body);
      if (request.method === 'GET' && request.url === '/api/status') {
        return json(response, {
          totalEntries: 3,
          health: [
            { type: 'bugs', total: 1 },
            { type: 'patterns', total: 2 },
          ],
          agents: [{ presence: 'active' }, { presence: 'offline' }],
          projects: [{ name: 'KAI' }],
          recentEntries: [],
          brainHunger: { daysSinceLearn: 2, level: 'peckish', lastEntryDate: '2026-09-21' },
        });
      }
      if (request.method === 'GET' && request.url === '/api/brain/quality') {
        return json(response, {
          totalEntries: 3,
          noiseScore: 5,
          signalRatio: 95,
          duplicateCount: 0,
          untaggedTotal: 1,
          deadWeightCount: 2,
        });
      }
      if (request.method === 'POST' && request.url === '/api/brain/recall') {
        return json(response, {
          mode: 'lexical',
          results: [
            {
              date: '2026-09-22',
              title: 'Use isolated brain paths in tests',
              agent: 'codex',
              type: 'patterns',
              tags: 'testing,brain',
              fields: { project: 'KAI', status: 'active', pattern: 'Use temporary data roots' },
            },
          ],
        });
      }
      if (request.method === 'POST' && request.url === '/api/brain/edit-field') {
        return json(response, { ok: true, title: 'Use isolated brain paths in tests', field: 'status', value: 'fixed' });
      }
      if (request.method === 'POST' && request.url === '/api/session/start') {
        return json(response, {
          briefed: true,
          briefing: 'Project briefing from C1.',
          project: 'KAI',
          claimed: true,
          conflicts: [{ agent: 'claude', what: 'Editing tests' }],
        });
      }
      if (request.method === 'POST' && request.url === '/api/session/end') {
        return json(response, {
          ok: true,
          agent: 'codex',
          summary: 'Finished the focused change.',
          autoHandoff: true,
        });
      }
      if (request.method === 'POST' && request.url === '/api/brain/handoff') {
        return json(response, {
          ok: true,
          handoff: {
            date: '2026-09-23',
            fromAgent: 'codex',
            toAgent: 'claude',
            project: 'KAI',
            status: 'Agent switch',
            next: 'Continue the provider tests.',
          },
        });
      }
      json(response, { error: 'Not found' }, 404);
    });
    await listen(upstream, 0);
    servers.push(upstream);

    const upstreamAddress = addressOf(upstream);
    const publicPort = await availablePort();
    const gateway = new AuthenticatedLoopbackGateway({
      listenEndpoint: `http://127.0.0.1:${publicPort}`,
      upstreamEndpoint: `http://127.0.0.1:${upstreamAddress.port}`,
      token,
    });
    gateways.push(gateway);
    await gateway.start();

    const client = new Cognitive1Client({
      access: {
        loopbackAccess: async () => ({ endpoint: `http://127.0.0.1:${publicPort}`, token }),
      },
    });

    await expect(client.overview()).resolves.toMatchObject({
      totalEntries: 3,
      typeCounts: { bugs: 1, decisions: 0, gotchas: 0, patterns: 2 },
      activeAgents: 1,
      projectCount: 1,
      hunger: { level: 'peckish' },
      quality: { signalRatio: 95 },
    });

    await expect(
      client.search({ query: 'isolated', tag: 'testing', project: 'KAI', maxResults: 12 }),
    ).resolves.toEqual([
      {
        date: '2026-09-22',
        title: 'Use isolated brain paths in tests',
        agent: 'codex',
        type: 'patterns',
        tags: 'testing,brain',
        project: 'KAI',
        fields: { project: 'KAI', status: 'active', pattern: 'Use temporary data roots' },
        status: 'active',
      },
    ]);
    expect(receivedBodies.at(-1)).toMatchObject({
      query: 'isolated',
      tag: 'testing',
      project: 'KAI',
      max_results: 12,
    });

    await expect(
      client.updateField({ title: 'Use isolated brain paths in tests', field: 'status', value: 'fixed' }),
    ).resolves.toEqual({ title: 'Use isolated brain paths in tests', field: 'status', value: 'fixed' });
    expect(receivedBodies.at(-1)).toEqual({
      title: 'Use isolated brain paths in tests',
      field: 'status',
      value: 'fixed',
    });

    await expect(
      client.startSession({ agent: 'codex', projectPath: process.cwd(), task: 'Fix recall scope' }),
    ).resolves.toEqual({
      briefed: true,
      briefing: 'Project briefing from C1.',
      project: 'KAI',
      claimed: true,
      conflicts: [{ agent: 'claude', what: 'Editing tests' }],
    });
    expect(receivedBodies.at(-1)).toEqual({
      agent: 'codex',
      project_path: process.cwd(),
      task: 'Fix recall scope',
    });

    await expect(client.endSession('codex', 'Finished the focused change.')).resolves.toEqual({
      agent: 'codex',
      summary: 'Finished the focused change.',
      autoHandoff: true,
    });
    expect(receivedBodies.at(-1)).toEqual({
      agent: 'codex',
      summary: 'Finished the focused change.',
    });

    await expect(
      client.recordHandoff({
        fromAgent: 'codex',
        toAgent: 'claude',
        project: 'KAI',
        status: 'Agent switch',
        next: 'Continue the provider tests.',
        files: 'test/desktop-brain.test.ts',
      }),
    ).resolves.toEqual({
      fromAgent: 'codex',
      toAgent: 'claude',
      project: 'KAI',
      status: 'Agent switch',
      next: 'Continue the provider tests.',
    });
    expect(receivedBodies.at(-1)).toEqual({
      from_agent: 'codex',
      to_agent: 'claude',
      project: 'KAI',
      status: 'Agent switch',
      next: 'Continue the provider tests.',
      files: 'test/desktop-brain.test.ts',
    });
    expect(observedAuthorization).not.toContain(`Bearer ${token}`);
  });
});

function json(response: http.ServerResponse, payload: unknown, status = 200): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function readBody(request: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let text = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      text += chunk;
    });
    request.on('end', () => {
      if (!text) return resolve(undefined);
      try {
        resolve(JSON.parse(text) as unknown);
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await listen(server, 0);
  const port = addressOf(server).port;
  await closeServer(server);
  return port;
}

function addressOf(server: http.Server | net.Server): { port: number } {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address.');
  return { port: address.port };
}

function listen(server: http.Server | net.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

function closeServer(server: http.Server | net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
