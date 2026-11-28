/**
 * A repeatable stand-in for the failure seen in the saved Qwen runs: a long task on a small window, where each fold
 * throws away what had been read and the model reads it again.
 *
 * The model here is a script, not a real model. It has perfect memory of which edits it made, and none of a file's
 * contents beyond what the request in front of it holds. So every extra read it makes was forced by what KAI sent it.
 * That isolates the loop's behaviour; it says nothing about how well a real model codes.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultSettings, type AgentRunRequest } from '../packages/contracts/src';
import { DesktopDirectProviderRuntime } from '../apps/desktop/src/main/direct-provider-runtime';

const servers: http.Server[] = [];
const folders: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

const MODEL = 'replay-coder';
const SOURCES = Array.from({ length: 8 }, (_, index) => `src/part-${index + 1}.ts`);
/** What every edit depends on, as a plan or a shared types file does in a real task. */
const SHARED = ['docs/spec.md', 'src/types.ts'];

/** The last line of each file. A summary that clips a result never carries it, so seeing it means seeing the file. */
const endOf = (file: string): string => `// end of ${file}`;

function contents(file: string, lines: number): string {
  return [`// ${file} TODO`, ...Array.from({ length: lines }, (_, index) => `export const value${index} = '${'x'.repeat(40)}';`), endOf(file)].join('\n');
}

interface ReplayResult {
  status: string;
  rounds: number;
  reads: number;
  /** Reads of a file the model had already read and that had not changed since. */
  rereads: number;
  folds: number;
  edited: number;
  largestRequestChars: number;
}

async function replay(windowTokens: number): Promise<ReplayResult> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-replay-'));
  folders.push(root);
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'docs'));
  for (const file of SHARED) fs.writeFileSync(path.join(root, file), contents(file, 45));
  for (const file of SOURCES) fs.writeFileSync(path.join(root, file), contents(file, 70));

  const result: ReplayResult = { status: '', rounds: 0, reads: 0, rereads: 0, folds: 0, edited: 0, largestRequestChars: 0 };
  const edited = new Set<string>();
  const readSinceChange = new Set<string>();

  const server = http.createServer((incoming, response) => {
    let raw = '';
    incoming.setEncoding('utf8');
    incoming.on('data', (chunk) => { raw += chunk; });
    incoming.on('end', () => {
      if (incoming.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: MODEL }] }));
        return;
      }
      const body = JSON.parse(raw) as { messages: Array<{ role: string; content?: unknown }> };
      result.rounds += 1;
      result.largestRequestChars = Math.max(result.largestRequestChars, raw.length);
      const seen = body.messages.filter((message) => message.role === 'tool').map((message) => String(message.content)).join('\n');
      const next = SOURCES.find((file) => !edited.has(file));
      const missing = next ? [...SHARED, next].find((file) => !seen.includes(endOf(file))) : undefined;

      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // A model that never gets what it needs would go on for ever, and so would this test.
      if (!next || result.rounds > 150) {
        response.end('data: {"choices":[{"delta":{"content":"Done."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
        return;
      }
      let call: { name: string; arguments: unknown };
      if (missing) {
        result.reads += 1;
        if (readSinceChange.has(missing)) result.rereads += 1;
        readSinceChange.add(missing);
        call = { name: 'read_file', arguments: { path: missing } };
      } else {
        edited.add(next);
        readSinceChange.delete(next);
        call = { name: 'replace_in_file', arguments: { path: next, old_text: `// ${next} TODO`, new_text: `// ${next} done` } };
      }
      const toolCall = { index: 0, id: `call_${result.rounds}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } };
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [toolCall] } }] })}\n\ndata: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind.');

  const settings = createDefaultSettings();
  settings.directApi = { enabled: true, provider: 'lmstudio', model: MODEL, baseUrl: `http://127.0.0.1:${address.port}/v1`, credentialId: 'provider.lmstudio' };
  settings.modelContextOverride = { [MODEL]: windowTokens };
  const runtime = new DesktopDirectProviderRuntime(
    { load: async () => settings },
    { isAvailable: () => false, has: async () => false, get: async () => undefined },
  );
  const request: AgentRunRequest = { conversationId: 'conv-replay', prompt: 'Finish the TODO in every file under src.', agent: 'codex', execution: 'api', route: 'direct', autonomy: 'full' };
  const run = await runtime.run(request, root);

  result.status = run.status;
  result.edited = edited.size;
  result.folds = run.events.filter((event) => event.type === 'notice' && event.message.startsWith('Compacted this run')).length;
  return result;
}

describe('replay of a long task on a local model', () => {
  it('needs each file once when the window holds the whole task', async () => {
    const roomy = await replay(200_000);
    console.log('replay, roomy window', roomy);

    expect(roomy).toMatchObject({ status: 'completed', edited: SOURCES.length, folds: 0, rereads: 0, reads: SOURCES.length + SHARED.length });
  }, 60_000);

  // The "before" figures for the working-memory work (K7 to K9 in docs/desktop/LOCAL_FIRST_PLAN.md). When that lands,
  // these expectations become the target: no re-reads of unchanged files, however often the run folds.
  it('re-reads unchanged files after each fold when the window is small', async () => {
    const small = await replay(12_000);
    console.log('replay, small window', small);

    expect(small.folds).toBeGreaterThan(0);
    expect(small.rereads).toBeGreaterThan(0);
  }, 60_000);
});
