import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createDefaultSettings, type AgentRunRequest, type AppSettings } from '../packages/contracts/src';
import { scopeConversationRequest } from '../apps/desktop/src/main/conversation-scope';
import { DesktopDirectProviderRuntime } from '../apps/desktop/src/main/direct-provider-runtime';
import { LeadToolProgress } from '../apps/desktop/src/main/lead-tool-progress';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

interface Body { tools?: unknown[]; messages: Array<{ role: string; content?: unknown }> }
async function runLead(mode: 'overlap' | 'compact' | 'unique' | 'ignores', local: boolean) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-lead-progress-'));
  const content = Array.from({ length: 100 }, (_, i) => `Evidence line ${i + 1}: ${'facts '.repeat(20)}`).join('\n');
  await fs.writeFile(path.join(project, 'review.txt'), content);
  const bodies: Body[] = [];
  const server = http.createServer((incoming, response) => {
    let raw = ''; incoming.setEncoding('utf8'); incoming.on('data', (part) => { raw += part; });
    incoming.on('end', () => {
      if (incoming.url === '/v1/models') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ data: [{ id: 'test-model' }] })); return;
      }
      const body = JSON.parse(raw) as Body; bodies.push(body);
      const round = bodies.length;
      // A hard stop in the fake provider keeps the pre-fix reproduction bounded.
      const call = (mode === 'ignores' || Boolean(body.tools?.length)) && round <= (mode === 'unique' ? 16 : mode === 'compact' ? 2 : 6);
      const input = mode === 'unique' ? { path: 'review.txt', start_line: round, end_line: round }
        : ['overlap', 'ignores'].includes(mode) && round > 1 ? { path: 'review.txt', start_line: round, end_line: round + 1 }
          : { path: 'review.txt', start_line: 1, end_line: 100 };
      const delta = call ? { content: 'Let me read the review again.\n\n', tool_calls: [{ index: 0, id: `read-${round}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify(input) } }] }
        : { content: '## Next step\nUse the recorded evidence to prepare the repair. The gate stays open.' };
      response.setHeader('Content-Type', 'text/event-stream');
      response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test port.');
  const settings: AppSettings = createDefaultSettings();
  settings.directApi = { ...settings.directApi, enabled: true, provider: local ? 'lmstudio' : 'deepseek', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'test-model', credentialId: 'test-key' };
  settings.usageBudget = { ...settings.usageBudget, compactAtTokens: mode === 'compact' ? 2_000 : 0, compactAtTokensLocal: mode === 'compact' ? 2_000 : 0 };
  const runtime = new DesktopDirectProviderRuntime({ load: async () => settings }, { isAvailable: () => true, has: async () => true, get: async () => 'test-only' });
  const request: AgentRunRequest = scopeConversationRequest({ origin: { kind: 'lead', projectId: 'project-a' } }, { conversationId: 'lead-progress', prompt: 'What next?', agent: 'codex', execution: 'api', route: 'direct', autonomy: 'plan' });
  const result = await runtime.run(request, project);
  return { bodies, result };
}

it.each([true, false])('ends a Lead inspection when changed ranges only reread unchanged evidence (local=%s)', async (local) => {
  const { bodies, result } = await runLead('overlap', local);
  expect(bodies).toHaveLength(4);
  expect(bodies.at(-1)?.tools).toBeUndefined();
  expect(JSON.stringify(bodies.at(-1))).toContain('already read');
  expect(result.status).toBe('completed');
  expect(result.output).toContain('## Next step');
});

it('answers with full existing evidence instead of losing it to Lead context compaction', async () => {
  const { bodies, result } = await runLead('compact', false);
  expect(bodies).toHaveLength(2);
  expect(bodies[1]?.tools).toBeUndefined();
  expect(JSON.stringify(bodies[1])).toContain('Evidence line 100');
  expect(result.output).toContain('## Next step');
});

it('bounds even non-repeating Lead inspection and keeps every executed tool result', async () => {
  const { bodies } = await runLead('unique', true);
  expect(bodies).toHaveLength(13);
  expect(bodies.at(-1)?.tools).toBeUndefined();
  expect(bodies.at(-1)?.messages.filter((message) => message.role === 'tool')).toHaveLength(12);
});

it('allows unread ranges and genuinely changed lines, and keeps run evidence isolated', () => {
  const progress = new LeadToolProgress();
  const read = (text: string) => progress.observe('read_file', { path: 'review.txt' }, { path: 'review.txt', text });
  expect(read('1: first\n2: second').notice).toBeUndefined();
  expect(read('2: second').notice).toContain('already read');
  expect(read('3: new').notice).toBeUndefined();
  expect(read('1: changed').notice).toBeUndefined();
  expect(read('2: second').finish).toBe(false);
  expect(read('1: changed').finish).toBe(true);
  expect(new LeadToolProgress().observe('read_file', {}, { path: 'review.txt', text: '1: changed' }).notice).toBeUndefined();
});

it('does not run more tools if the model ignores the final-answer request', async () => {
  const { bodies, result } = await runLead('ignores', true);
  expect(bodies).toHaveLength(4);
  expect(result.status).toBe('failed');
  expect(result.error).toContain('No further tools were run');
  expect(bodies.at(-1)?.messages.filter((message) => message.role === 'tool')).toHaveLength(3);
});
