import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compactThresholdFor, modelContextFor, type ArchitectBrief } from '../packages/contracts/src';
import { testGuardNote, weakenedTestFlags } from '../apps/desktop/src/main/test-guard';
import { compactChatToolHistory, type ChatMessage } from '../apps/desktop/src/main/direct-provider-runtime';
import { parseModelContexts } from '../apps/desktop/src/main/provider-models';
import { briefText, stepPrompt, planPrompt } from '../apps/desktop/src/main/architect-loop';
import { outlineFile } from '../apps/desktop/src/main/repo-map';
import { DesktopProjectToolRuntime } from '../apps/desktop/src/main/project-tools';

describe('naming test changes a reviewer must justify', () => {
  const diff = (file: string, lines: string): string => `--- ${file}\ndiff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,4 +1,4 @@\n${lines}`;

  it('flags an expected value that changed', () => {
    const flags = weakenedTestFlags(diff('src/context.test.js', "-    assert.equal(kept.length, 5);\n+    assert.equal(kept.length, 6);"));
    expect(flags).toHaveLength(1);
    expect(flags[0]).toContain('an expected value changed');
    expect(flags[0]).toContain('assert.equal(kept.length, 5)');
  });

  it('flags expect() matchers that changed, assertions removed, and skipped tests', () => {
    const flags = weakenedTestFlags(diff('test/parser.spec.ts', [
      "-    expect(names).toEqual(['assumption', 'decision']);",
      "+    expect(names).toEqual(['memory-1', 'memory-2']);",
      "-    expect(total).toBe(3);",
      "+  it.skip('keeps the budget', () => {",
    ].join('\n')));
    expect(flags.some((flag) => flag.includes('an expected value changed'))).toBe(true);
    expect(flags.some((flag) => flag.includes('fewer assertion'))).toBe(true);
    expect(flags.some((flag) => flag.includes('now skipped'))).toBe(true);
  });

  it('leaves new tests, source files and the diff headers alone', () => {
    expect(weakenedTestFlags(diff('src/context.test.js', '+    assert.equal(kept.length, 6);'))).toEqual([]);
    expect(weakenedTestFlags(diff('src/context.ts', "-  expect(a).toBe(1);\n+  expect(a).toBe(2);"))).toEqual([]);
    expect(testGuardNote([])).toBe('');
    expect(testGuardNote(['x'])).toContain('restore the test');
  });
});

describe('a fold keeps the last command output in full', () => {
  it('carries the end of the last command output past the summary clip', () => {
    const failures = `not ok 5 - budget arithmetic\n${'detail '.repeat(100)}\nnot ok 8 - block names`;
    const tail: ChatMessage[] = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] },
      { role: 'tool', tool_call_id: 'a', content: 'file text' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'b', type: 'function', function: { name: 'run_command', arguments: '{"command":"node --test context.test.js"}' } }] },
      { role: 'tool', tool_call_id: 'b', content: failures },
    ];
    const summary = compactChatToolHistory(tail);
    expect(summary).toContain('The last command you ran (run_command');
    expect(summary).toContain('not ok 8 - block names');
  });
});

describe('a local model folds at a share of its own window', () => {
  it('reads the window under each name servers use, preferring the loaded size', () => {
    expect(parseModelContexts({ data: [
      { id: 'lmstudio/glm-4.5-air', loaded_context_length: 65536, max_context_length: 131072 },
      { id: 'or/model', context_length: 200000 },
      { id: 'vllm/model', max_model_len: 32768 },
      { id: 'none' },
    ] })).toEqual({ 'lmstudio/glm-4.5-air': 65536, 'or/model': 200000, 'vllm/model': 32768 });
  });

  it('ignores the momentary loaded size when the list comes from a gateway', () => {
    const body = { data: [{ id: 'lmstudio/q', context_length: 262144, loaded_context_length: 8192 }, { id: 'gateway/coding' }] };
    expect(parseModelContexts(body, false)).toEqual({ 'lmstudio/q': 262144 });
    expect(parseModelContexts(body)).toEqual({ 'lmstudio/q': 8192 });
  });

  it('uses half the window when it is known, the local size when not, and stays off when compaction is off', () => {
    const budget = { compactAtTokens: 24_000, compactAtTokensLocal: 20_000 };
    expect(compactThresholdFor(budget, 'lmstudio', 131_072)).toBe(65_536);
    expect(compactThresholdFor(budget, 'lmstudio')).toBe(20_000);
    expect(compactThresholdFor(budget, 'openai', 131_072)).toBe(24_000);
    expect(compactThresholdFor({ ...budget, compactAtTokens: 0 }, 'lmstudio', 131_072)).toBe(0);
    expect(compactThresholdFor(budget, 'lmstudio', 4_096)).toBe(4_000);
  });

  it('folds a gateway model by its own window, and lets a set override win over the reported one', () => {
    const budget = { compactAtTokens: 50_000, compactAtTokensLocal: 50_000 };
    const id = 'lmstudio/huihui-qwen3-coder-next-abliterated-mlx';
    expect(compactThresholdFor(budget, 'openai-compatible', 131_072)).toBe(65_536);
    expect(compactThresholdFor(budget, 'openai-compatible')).toBe(50_000);
    expect(modelContextFor({ localModelContext: { [id]: 65_536 } }, id)).toBe(65_536);
    expect(modelContextFor({ localModelContext: { [id]: 65_536 }, modelContextOverride: { [id]: 131_072 } }, id)).toBe(131_072);
    expect(modelContextFor({}, id)).toBeUndefined();
    expect(modelContextFor({}, 'gateway/coding')).toBe(131_072);
    expect(modelContextFor({}, 'gateway/general')).toBe(65_536);
    expect(modelContextFor({}, 'gateway/auto')).toBeUndefined();
  });
});

describe('the brief says how to test', () => {
  const brief: ArchitectBrief = {
    goal: 'Fix fence labels', files: ['context.ts'], avoid: [], doneChecks: ['tests pass'],
    steps: ['Export memoryLabels.', 'Update the tests.'],
    oneTestCommand: 'node --test desktop/features/copilot/main/chat/{file}',
    buildCommand: 'npm run build:main',
  };
  it('puts both commands in the brief and in every step', () => {
    expect(briefText(brief)).toContain('To run one test file: node --test');
    expect(briefText(brief)).toContain('Before you run tests, run: npm run build:main');
    expect(stepPrompt(brief, 'task', 'glm', 1)).toContain('To run one test file');
    expect(stepPrompt(brief, 'task', 'glm', 1)).toContain('Never change a test');
    expect(planPrompt('task', 'Claude')).toContain('"oneTestCommand"');
  });
});

describe('outline_file', () => {
  it('lists declarations with line numbers', async () => {
    expect(outlineFile('a.ts', 'import x from "y";\nexport function memoryWithin() {}\nconst a = 1;\nexport class Thing {}')).toEqual(
      expect.arrayContaining([{ line: 2, text: 'export function memoryWithin() {}' }, { line: 4, text: 'export class Thing {}' }]),
    );
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-outline-'));
    try {
      await fs.writeFile(path.join(root, 'context.ts'), 'export function memoryLabels() {}\nexport const CONTEXT_MESSAGES = 4;\n');
      const runtime = new DesktopProjectToolRuntime(root);
      expect((runtime.toolDefinitions() as Array<{ name: string }>).some((tool) => tool.name === 'outline_file')).toBe(true);
      expect(runtime.policy('outline_file', 'plan')).toEqual({ decision: 'allow' });
      const result = await runtime.execute('outline_file', { path: 'context.ts' });
      expect(result.ok).toBe(true);
      expect(String(result.output)).toContain('1: export function memoryLabels() {}');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
