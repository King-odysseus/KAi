import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDefaultSettings,
  learningTutorResponseSchema,
  type LearningLessonRecordInput,
  type LearningTutorRequest,
  type LearningTutorResponse,
} from '../packages/contracts/src';
import { NodeFileSystem } from '../packages/runtime/src/node-file-system';
import { formatProjectCode, projectGitFileInfo } from '../apps/desktop/src/main/code-tools';
import { recordLearningLesson } from '../apps/desktop/src/main/learning-records';
import { LearningProgressStore } from '../apps/desktop/src/main/learning-progress';
import { DesktopLearningTutor, groundedSourceNotes, parseLearningTutorContent, parseTeachingDraftContent } from '../apps/desktop/src/main/learning-tutor';
import { TeachingLibraryStore } from '../apps/desktop/src/main/teaching-library';
import { boundedCode } from '../apps/desktop/src/renderer/src/components/CodeView';
import { LearningBudgetGuard, LearningUsageStore } from '../apps/desktop/src/main/learning-usage';

const directories: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('desktop learning mode', () => {
  it('requests a compact cursor insertion without scanning the project for inline completion', async () => {
    const bodies: unknown[] = [];
    const server = http.createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        bodies.push(JSON.parse(raw));
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ output_text: JSON.stringify({ code: 'world' }) }));
      });
    });
    const baseUrl = await listen(server);
    const settings = createDefaultSettings();
    settings.learningTutor = { ...settings.learningTutor, enabled: true, provider: 'openai', model: 'test-model', baseUrl: `${baseUrl}/v1` };
    const tutor = new DesktopLearningTutor({ load: async () => settings }, { isAvailable: () => true, get: async () => 'test-key' }, async () => { throw new Error('Inline completion must not scan the project'); });
    const request = { ...tutorRequest('complete', 'copilot'), code: '', teachingModes: ['copilot' as const], completionContext: { prefix: 'const greeting = "', suffix: '";' } };
    const result = await tutor.evaluateDetailed(request);
    expect(result.response.suggestion?.code).toBe('world');
    expect(bodies).toHaveLength(1);
    expect(JSON.stringify(bodies[0])).toContain('kai_inline_completion');
    expect(JSON.stringify(bodies[0])).not.toContain('Whole-project brief');
    await expect(tutor.evaluateDetailed({ ...request, assistance: 'guided' })).rejects.toThrow('requires Copilot');
  });

  it('remembers lessons across files and restarts without awarding mastery for self-report', async () => {
    const root = await temporaryDirectory();
    const store = new LearningProgressStore(root, new NodeFileSystem());
    const request = tutorRequest('explain-file', 'guided');
    const first = await store.recordEvaluation(request, tutorResponse());
    const reloaded = await new LearningProgressStore(root, new NodeFileSystem()).get(request.projectId);
    expect(reloaded.memory?.lastLesson).toBe(tutorResponse().title);
    expect(reloaded.memory?.unresolvedCheck).toBe(tutorResponse().checks[0]);
    const understood = await store.markUnderstood(request.projectId, first.memory!.lessonId);
    expect(understood.memory).toMatchObject({ understood: true, unresolvedCheck: '' });
    expect(understood.concepts).toEqual(first.concepts);
    await store.recordEvaluation({ ...request, filePath: 'another.ts' }, tutorResponse());
    const historical = await store.markUnderstood(request.projectId, first.memory!.lessonId);
    expect(historical.memory?.filePath).toBe('another.ts');
    expect(historical.memory?.understood).toBe(false);
    expect(historical.lessons).toHaveLength(2);
    expect(historical.lessons?.[1]?.understood).toBe(true);
    await expect(store.markUnderstood(request.projectId, 'missing')).rejects.toThrow('no longer available');
    expect((await store.get('separate-project')).memory).toBeUndefined();
  });

  it('grounds file citations in supplied context and drops unsupported line ranges', () => {
    const request = { ...tutorRequest('explain-file', 'guided'), filePath: 'src/main.ts', code: 'one\ntwo' };
    const notes = groundedSourceNotes([
      { label: 'Code', filePath: 'src/main.ts', startLine: 2, endLine: 2 },
      { label: 'Bad line', filePath: 'src/main.ts', startLine: 99 },
      { label: 'Invented', filePath: 'missing.ts' },
      { label: 'Escape', filePath: '../secret' },
      { label: 'Test', filePath: 'test/main.test.ts', startLine: 1 },
    ], request, 'File: test/main.test.ts\n1: test()');
    expect(notes).toEqual([
      { label: 'Code', filePath: 'src/main.ts', startLine: 2, endLine: 2 },
      { label: 'Bad line', filePath: 'src/main.ts' },
      { label: 'Test', filePath: 'test/main.test.ts', startLine: 1 },
    ]);
  });

  it('validates and parses structured tutor JSON, including fenced fallback output', () => {
    const parsed = parseLearningTutorContent(`\`\`\`json\n${JSON.stringify(tutorResponse())}\n\`\`\``);
    expect(parsed.title).toBe('Variables hold changing values');
    expect(parsed.concepts[0]).toMatchObject({ name: 'Variables', mastery: 'independent' });
    expect(() => parseLearningTutorContent('{"title":"incomplete"')).toThrow();
    expect(() => learningTutorResponseSchema.parse({
      ...tutorResponse(),
      concepts: [{ name: 'Variables', category: 'TypeScript', mastery: 'expert', evidence: 'No.' }],
    })).toThrow();
  });

  it('keeps a partial but valid provider reply readable by adding neutral empty fields', () => {
    const parsed = parseLearningTutorContent(JSON.stringify({
      title: 'What to inspect next',
      purpose: 'Trace the entry point before changing the code.',
    }));
    expect(parsed.title).toBe('What to inspect next');
    expect(parsed.steps[0]?.title).toBe('Do this next');
    expect(parsed.analogy.limits).toContain('verify');
    expect(parsed.codePreview).toBe('');
  });

  it('records evidence without promoting AI-generated completion to learner mastery', async () => {
    const root = await temporaryDirectory();
    const store = new LearningProgressStore(path.join(root, 'learning'), new NodeFileSystem(), () => new Date('2026-09-23T12:00:00.000Z'));
    const response = tutorResponse();

    const completed = await store.recordEvaluation(tutorRequest('complete', 'copilot'), response);
    expect(completed.concepts[0]).toMatchObject({
      name: 'Variables',
      mastery: 'introduced',
      score: 20,
      evidenceCount: 1,
    });
    expect(completed.concepts[0]?.evidence[0]).toContain('AI-generated completion');

    const checked = await store.recordEvaluation(tutorRequest('check-code', 'pair'), response);
    expect(checked.concepts[0]).toMatchObject({
      name: 'Variables',
      mastery: 'practising',
      score: 78,
      evidenceCount: 2,
    });
    expect(checked.preferences).toEqual({ assistance: 'guided', inlineSuggestions: false });
  });

  it('seeds an app-owned Markdown teaching library that can be edited, duplicated, reset, and removed', async () => {
    const root = await temporaryDirectory();
    const store = new TeachingLibraryStore(path.join(root, 'teaching'), new NodeFileSystem(), () => new Date('2026-09-23T12:00:00.000Z'));
    const seeded = await store.get();

    expect(seeded.methods.map((entry) => entry.title)).toEqual(expect.arrayContaining([
      'KAI Guided Discovery',
      'KAI Worked Example to Transfer',
      'KAI Feynman Rebuild',
      'KAI Production Investigation',
    ]));
    expect(seeded.rules.map((entry) => entry.title)).toEqual(expect.arrayContaining([
      'KAI Core Teaching Rules',
      'KAI Integrity and Safety Boundaries',
    ]));
    await expect(fs.access(path.join(root, 'teaching', 'KAI-Teaching.md'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(root, 'teaching', 'KAI-Teaching-Rules.md'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(root, 'teaching', 'methods', 'kai-guided-discovery.md'))).resolves.toBeUndefined();
    await expect(store.profile()).resolves.toContain('App-owned KAI teaching library');

    const guided = seeded.methods.find((entry) => entry.id === 'kai-guided-discovery')!;
    const edited = await store.save({
      id: guided.id,
      kind: 'method',
      title: guided.title,
      description: 'Edited by the learner.',
      content: '# Edited KAI method\n\nUse learner evidence.',
      enabled: false,
    });
    expect(edited.methods.find((entry) => entry.id === guided.id)).toMatchObject({
      description: 'Edited by the learner.',
      enabled: false,
      builtIn: true,
    });

    const reset = await store.reset('method', guided.id);
    expect(reset.methods.find((entry) => entry.id === guided.id)?.content).toContain('KAI Guided Discovery');
    expect(reset.methods.find((entry) => entry.id === guided.id)?.enabled).toBe(true);

    const custom = await store.save({
      id: 'custom-rule-evidence',
      kind: 'rule',
      title: 'Evidence before praise',
      description: 'Require learner reasoning.',
      content: '1. Name the evidence before describing progress.',
      enabled: true,
    });
    expect(custom.rules).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'custom-rule-evidence' })]));
    const removed = await store.remove('rule', 'custom-rule-evidence');
    expect(removed.rules.some((entry) => entry.id === 'custom-rule-evidence')).toBe(false);
    await expect(store.remove('method', guided.id)).rejects.toThrow(/not deleted/i);
  });

  it('uses the configured OpenAI Responses provider with structured output and store disabled', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const server = http.createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          output_text: JSON.stringify(tutorResponse()),
          usage: { input_tokens: 321, output_tokens: 123 },
        }));
      });
    });
    const baseUrl = await listen(server);
    const settings = createDefaultSettings();
    settings.directApi.enabled = false;
    settings.learningTutor.enabled = true;
    settings.learningTutor.provider = 'openai';
    settings.learningTutor.model = 'test-model';
    settings.learningTutor.baseUrl = `${baseUrl}/v1`;
    const root = await temporaryDirectory();
    await fs.mkdir(path.join(root, 'docs'));
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'docs', 'KAI-TEACHING.md'), 'KAI project overlay: use short verification loops.\n', 'utf8');
    await fs.writeFile(path.join(root, 'docs', 'TEACH.md'), 'MONEY MATTERS MUST NOT LOAD AS A KAI POLICY.\n', 'utf8');
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'kai-learning-fixture', scripts: { test: 'vitest' } }), 'utf8');
    await fs.writeFile(path.join(root, 'README.md'), '# Learning fixture\n\nRun the focused test before changing the source.\n', 'utf8');
    await fs.writeFile(path.join(root, 'src', 'value.ts'), 'export const value = 1;\n', 'utf8');
    await fs.writeFile(path.join(root, 'src', 'value.test.ts'), 'import { value } from "./value";\n', 'utf8');
    await fs.mkdir(path.join(root, 'node_modules'));
    await fs.writeFile(path.join(root, 'node_modules', 'ignored.ts'), 'PROJECT_CONTEXT_NODE_MODULE_SECRET\n', 'utf8');
    await fs.writeFile(path.join(root, '.env'), 'PROJECT_CONTEXT_ENV_SECRET\n', 'utf8');
    const tutor = new DesktopLearningTutor(
      { load: async () => settings },
      {
        isAvailable: () => true,
        get: async (id) => id === 'provider.openai' ? 'sk-test-secret' : undefined,
      },
      async () => root,
      { profile: async () => 'KAI-owned library policy: guided discovery.' },
    );

    const detailed = await tutor.evaluateDetailed(tutorRequest('explain-file', 'guided'));
    const result = detailed.response;

    expect(result.title).toBe('Variables hold changing values');
    expect(detailed.usage).toEqual({ inputTokens: 321, outputTokens: 123, source: 'provider' });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      model: 'test-model',
      store: false,
      text: {
        format: {
          type: 'json_schema',
          name: 'kai_learning_tutor_response',
          strict: true,
        },
      },
    });
    expect(JSON.stringify(bodies[0]?.text)).toContain('"concepts"');
    expect(JSON.stringify(bodies[0])).toContain('KAI-owned library policy');
    expect(JSON.stringify(bodies[0])).toContain('KAI project overlay');
    expect(JSON.stringify(bodies[0])).toContain('kai-learning-fixture');
    expect(JSON.stringify(bodies[0])).toContain('Project brief: kai-learning-fixture');
    expect(JSON.stringify(bodies[0])).toContain('npm run test');
    expect(JSON.stringify(bodies[0])).toContain('src/value.test.ts');
    expect(JSON.stringify(bodies[0])).toContain('Scope: whole project');
    expect(JSON.stringify(bodies[0])).not.toContain('MONEY MATTERS MUST NOT LOAD');
    expect(JSON.stringify(bodies[0])).not.toContain('PROJECT_CONTEXT_NODE_MODULE_SECRET');
    expect(JSON.stringify(bodies[0])).not.toContain('PROJECT_CONTEXT_ENV_SECRET');

    await tutor.evaluateDetailed({ ...tutorRequest('explain-file', 'guided'), scope: 'active-file' });
    expect(bodies).toHaveLength(2);
    expect(JSON.stringify(bodies[1])).toContain('Scope: active file only');
    expect(JSON.stringify(bodies[1])).not.toContain('Project brief: kai-learning-fixture');

    await tutor.evaluateDetailed({
      ...tutorRequest('next-step', 'guided'),
      filePath: undefined,
      code: '',
      scope: 'project',
    });
    expect(bodies).toHaveLength(3);
    expect(JSON.stringify(bodies[2])).toContain('Scope: whole project');
    expect(JSON.stringify(bodies[2])).toContain('No file is open.');
    expect(JSON.stringify(bodies[2])).toContain('Project brief: kai-learning-fixture');
  });

  it('retries chat completions when a compatible Responses endpoint returns an empty output', async () => {
    const paths: string[] = [];
    const server = http.createServer((request, response) => {
      paths.push(request.url ?? '');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      if (request.url?.endsWith('/responses')) {
        response.end(JSON.stringify({ status: 'completed', output: [] }));
        return;
      }
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(tutorResponse()) } }] }));
    });
    const baseUrl = await listen(server);
    const settings = createDefaultSettings();
    settings.learningTutor = { ...settings.learningTutor, enabled: true, provider: 'openai', model: 'test-model', baseUrl: `${baseUrl}/v1` };
    const tutor = new DesktopLearningTutor(
      { load: async () => settings },
      { isAvailable: () => true, get: async () => 'sk-test-secret' },
      async () => temporaryDirectory(),
    );
    const result = await tutor.evaluateDetailed(tutorRequest('explain-file', 'guided'));
    expect(result.response.title).toBe('Variables hold changing values');
    expect(paths).toEqual(['/v1/responses', '/v1/chat/completions']);
  });

  it('retries without json_schema when a chat model returns empty structured content', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const server = http.createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        bodies.push(body);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        const content = body.response_format ? '' : JSON.stringify(tutorResponse());
        response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content, reasoning_content: 'thinking' } }] }));
      });
    });
    const baseUrl = await listen(server);
    const settings = createDefaultSettings();
    settings.learningTutor = { ...settings.learningTutor, enabled: true, provider: 'deepseek', model: 'deepseek-flash', baseUrl };
    const tutor = new DesktopLearningTutor(
      { load: async () => settings },
      { isAvailable: () => true, get: async () => 'sk-test-secret' },
      async () => temporaryDirectory(),
    );
    const result = await tutor.evaluateDetailed(tutorRequest('explain-file', 'guided'));
    expect(result.response.title).toBe('Variables hold changing values');
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.response_format).toBeDefined();
    expect(bodies[1]?.response_format).toBeUndefined();
  });

  it('explains why a chat model returned no tutor content', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: 'long thoughts' } }] }));
    });
    const baseUrl = await listen(server);
    const settings = createDefaultSettings();
    settings.learningTutor = { ...settings.learningTutor, enabled: true, provider: 'deepseek', model: 'deepseek-flash', baseUrl };
    const tutor = new DesktopLearningTutor(
      { load: async () => settings },
      { isAvailable: () => true, get: async () => 'sk-test-secret' },
      async () => temporaryDirectory(),
    );
    await expect(tutor.evaluateDetailed(tutorRequest('explain-file', 'guided')))
      .rejects.toThrow('finish_reason: length; reasoning used the whole output budget');
  });

  it('generates a reviewable teaching draft with the configured direct provider', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const server = http.createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          output_text: JSON.stringify({
            title: 'Check first, explain second',
            description: 'A rule pack for evidence-led feedback.',
            content: '1. Ask for the learner reasoning before judging the result.',
          }),
        }));
      });
    });
    const baseUrl = await listen(server);
    const settings = createDefaultSettings();
    settings.learningTutor.enabled = true;
    settings.learningTutor.provider = 'openai';
    settings.learningTutor.model = 'test-model';
    settings.learningTutor.baseUrl = `${baseUrl}/v1`;
    const tutor = new DesktopLearningTutor(
      { load: async () => settings },
      { isAvailable: () => true, get: async () => 'sk-test-secret' },
      async () => temporaryDirectory(),
      { profile: async () => 'KAI-owned teaching policy.' },
    );

    const detailed = await tutor.generateTeachingDraftDetailed({ kind: 'rule', topic: 'evidence-led feedback' });
    const draft = detailed.draft;

    expect(draft).toEqual({
      title: 'Check first, explain second',
      description: 'A rule pack for evidence-led feedback.',
      content: '1. Ask for the learner reasoning before judging the result.',
    });
    expect(bodies[0]).toMatchObject({
      text: {
        format: {
          name: 'kai_teaching_draft',
          strict: true,
        },
      },
    });
    expect(detailed.usage.source).toBe('estimated');
  });

  it('reports actionable readiness without making a provider request', async () => {
    const settings = createDefaultSettings();
    let providerCalls = 0;
    const tutor = (stored = true) => new DesktopLearningTutor(
      { load: async () => settings },
      { isAvailable: () => true, has: async () => stored, get: async () => stored ? 'secret' : undefined },
      async () => {
        providerCalls += 1;
        return temporaryDirectory();
      },
    );

    settings.learningTutor.enabled = false;
    await expect(tutor().readiness()).resolves.toMatchObject({
      enabled: false,
      ready: false,
      reason: 'Learning Tutor API is disabled.',
    });
    settings.learningTutor.enabled = true;
    settings.learningTutor.provider = 'anthropic';
    settings.learningTutor.model = 'claude-sonnet';
    await expect(tutor().readiness()).resolves.toMatchObject({
      supported: true,
      ready: true,
      protocol: 'anthropic-messages',
      displayName: 'Anthropic Messages API',
    });
    settings.learningTutor.provider = 'deepseek';
    settings.learningTutor.model = 'deepseek-flash';
    settings.learningTutor.credentialId = 'provider.deepseek';
    await expect(tutor().readiness()).resolves.toMatchObject({
      supported: true,
      ready: true,
      protocol: 'chat-completions',
      displayName: 'DeepSeek API',
    });
    settings.learningTutor.provider = 'openai';
    settings.learningTutor.model = '';
    await expect(tutor().readiness()).resolves.toMatchObject({ ready: false, reason: 'No Learning Tutor model is configured.' });
    settings.learningTutor.model = 'gpt-test';
    await expect(tutor(false).readiness()).resolves.toMatchObject({ credentialStored: false, ready: false });
    await expect(tutor().readiness()).resolves.toMatchObject({ credentialStored: true, ready: true, reason: null });
    expect(providerCalls).toBe(0);
  });

  it('keeps a selection near the end of a large file inside the bounded tutor context', () => {
    const values = Array.from({ length: 13_500 }, (_, index) => `const line${index + 1} = ${index + 1};`);
    values[12_999] = 'const TARGET_NEAR_EOF = 42;';
    const source = values.join('\n');

    const bounded = boundedCode(source, 13_000, 13_000);

    expect(bounded).toContain('13000: const TARGET_NEAR_EOF = 42;');
    expect(bounded).toContain('[KAI omitted lines 1-');
    expect(bounded.length).toBeLessThanOrEqual(120_000);

    const middle = boundedCode(source, 6_000, 6_000);
    expect(middle).toContain('6000: const line6000 = 6000;');
    expect(middle.length).toBeLessThanOrEqual(120_000);
  });

  it('blocks a concurrent paid tutor request before it can be sent', () => {
    const guard = new LearningBudgetGuard();
    const budget = {
      mode: 'block' as const,
      perConversationUsd: 0,
      dailyUsd: 0.5,
      monthlyUsd: 0,
      providerDailyUsd: {},
    };
    const request = {
      projectId: 'p1',
      provider: 'deepseek',
      model: 'deepseek-chat',
      conversations: [],
      budget,
      estimatedInputTokens: 1_000_000,
      estimatedOutputTokens: 0,
    };

    const first = guard.reserve(request);
    expect(first.blockedReason).toBeNull();
    expect(guard.reserve(request).blockedReason).toMatch(/daily budget/);
    guard.release(first.id);
    expect(guard.reserve(request).blockedReason).toBeNull();
  });

  it('records provider and estimated learning usage without counting it as a conversation run', async () => {
    const root = await temporaryDirectory();
    const usage = new LearningUsageStore(root, new NodeFileSystem());
    await usage.record({ projectId: 'p1', provider: 'deepseek', model: 'deepseek-chat', usage: { inputTokens: 100, outputTokens: 50, source: 'provider' } });
    await usage.record({ projectId: 'p1', provider: 'custom', model: 'mystery', usage: { inputTokens: 20, outputTokens: 10, source: 'estimated' } });

    await expect(usage.runs()).resolves.toEqual([
      expect.objectContaining({ conversationId: 'learning:p1', provider: 'deepseek', inputTokens: 100, priced: true }),
      expect.objectContaining({ conversationId: 'learning:p1', provider: 'custom', inputTokens: 20, priced: false }),
    ]);
  });

  it('recovers from malformed provider JSON, provider errors, and timeouts', async () => {
    const settings = createDefaultSettings();
    settings.learningTutor.enabled = true;
    settings.learningTutor.provider = 'openai';
    settings.learningTutor.model = 'test-model';
    const makeTutor = (baseUrl: string, timeout = 120_000) => new DesktopLearningTutor(
      { load: async () => settings },
      { isAvailable: () => true, has: async () => true, get: async () => 'sk-test' },
      async () => temporaryDirectory(),
      undefined,
      timeout,
    );

    const malformed = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ output_text: 'not json' }));
    });
    settings.learningTutor.baseUrl = `${await listen(malformed)}/v1`;
    await expect(makeTutor(settings.learningTutor.baseUrl).evaluate(tutorRequest('explain-file', 'guided'))).rejects.toThrow(/after one automatic repair attempt/i);

    const failed = http.createServer((_request, response) => {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'fixture failed' } }));
    });
    settings.learningTutor.baseUrl = `${await listen(failed)}/v1`;
    await expect(makeTutor(settings.learningTutor.baseUrl).evaluate(tutorRequest('explain-file', 'guided'))).rejects.toThrow(/Learning provider request failed \(500\): fixture failed/);

    const slow = http.createServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ output_text: JSON.stringify(tutorResponse()) }));
      }, 150);
    });
    settings.learningTutor.baseUrl = `${await listen(slow)}/v1`;
    await expect(makeTutor(settings.learningTutor.baseUrl, 20).evaluate(tutorRequest('explain-file', 'guided'))).rejects.toThrow(/abort|timeout/i);
  });

  it('repairs one malformed tutor response without falling back to generic request validation', async () => {
    let calls = 0;
    const bodies: Array<Record<string, unknown>> = [];
    const server = http.createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        calls += 1;
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          output_text: calls === 1
            ? JSON.stringify({ title: 'Wrong shape', walkthrough: 'The model used its own keys.' })
            : JSON.stringify(tutorResponse()),
        }));
      });
    });
    const settings = createDefaultSettings();
    settings.directApi.enabled = false;
    settings.learningTutor.enabled = true;
    settings.learningTutor.provider = 'openai';
    settings.learningTutor.model = 'test-model';
    settings.learningTutor.baseUrl = `${await listen(server)}/v1`;
    const tutor = new DesktopLearningTutor(
      { load: async () => settings },
      { isAvailable: () => true, has: async () => true, get: async () => 'sk-test' },
      async () => temporaryDirectory(),
    );

    await expect(tutor.evaluate(tutorRequest('explain-file', 'guided'))).resolves.toMatchObject({
      title: 'Variables hold changing values',
    });
    expect(calls).toBe(2);
    expect(JSON.stringify(bodies[0])).toContain('exactly these top-level keys');
    expect(JSON.stringify(bodies[1])).toContain('previous response did not match');
  });

  it('repairs a local JSON syntax error without making a second paid tutor request', async () => {
    let calls = 0;
    const valid = JSON.stringify({
      ...tutorResponse(),
      checks: ['First check', 'Second check'],
    });
    const malformed = valid.replace('"First check","Second check"', '"First check" "Second check"');
    expect(malformed).not.toBe(valid);
    const server = http.createServer((_request, response) => {
      calls += 1;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ output_text: malformed }));
    });
    const settings = createDefaultSettings();
    settings.learningTutor.enabled = true;
    settings.learningTutor.provider = 'openai';
    settings.learningTutor.model = 'test-model';
    settings.learningTutor.baseUrl = `${await listen(server)}/v1`;
    const tutor = new DesktopLearningTutor(
      { load: async () => settings },
      { isAvailable: () => true, has: async () => true, get: async () => 'sk-test' },
      async () => temporaryDirectory(),
    );

    await expect(tutor.evaluate(tutorRequest('explain-file', 'guided'))).resolves.toMatchObject({
      title: 'Variables hold changing values',
      checks: ['First check', 'Second check'],
    });
    expect(calls).toBe(1);
  });

  it('parses generated teaching drafts without accepting incomplete content', () => {
    expect(parseTeachingDraftContent('```json\n{"title":"Method","description":"","content":"# Method"}\n```')).toEqual({
      title: 'Method',
      description: '',
      content: '# Method',
    });
    expect(() => parseTeachingDraftContent('{"title":"Incomplete"}')).toThrow();
  });

  it('formats with the project Prettier config and reports Git file metadata', async () => {
    const root = await temporaryDirectory();
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, '.prettierrc'), '{"semi":false,"singleQuote":true}\n', 'utf8');
    await fs.writeFile(path.join(root, 'src', 'value.ts'), 'const value = "x";\n', 'utf8');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'kai@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'KAI Test'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'Add value'], { cwd: root });

    const formatted = await formatProjectCode(root, 'src/value.ts', 'const value = "x";\n');
    expect(formatted.changed).toBe(true);
    expect(formatted.parser).toBe('typescript');
    expect(formatted.formatted).toBe("const value = 'x'\n");

    const clean = await projectGitFileInfo(root, 'src/value.ts');
    expect(clean).toMatchObject({ isRepository: true, status: 'clean' });
    expect(clean.entries[0]).toMatchObject({ author: 'KAI Test', subject: 'Add value' });

    await fs.writeFile(path.join(root, 'src', 'value.ts'), 'const value = 2;\n', 'utf8');
    await expect(projectGitFileInfo(root, 'src/value.ts')).resolves.toMatchObject({ status: 'M' });
  }, 20_000);

  it('appends a lesson record only when the explicit record operation is called', async () => {
    const root = await temporaryDirectory();
    const input: LearningLessonRecordInput = {
      projectId: 'project-test',
      filePath: 'src/value.ts',
      request: tutorRequest('explain-file', 'guided'),
      response: tutorResponse(),
    };

    await expect(fs.access(path.join(root, 'docs', 'LEARNING_GUIDE.md'))).rejects.toThrow();
    const result = await recordLearningLesson(root, input);
    const guide = await fs.readFile(path.join(root, 'docs', 'LEARNING_GUIDE.md'), 'utf8');

    expect(result).toMatchObject({ path: 'docs/LEARNING_GUIDE.md', appended: true });
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(guide).toContain('## Variables hold changing values');
    expect(guide).toContain('### Boundary');
    expect(guide).toContain('not by itself proof of independent mastery');
  });
});

function tutorRequest(action: LearningTutorRequest['action'], assistance: LearningTutorRequest['assistance']): LearningTutorRequest {
  return {
    projectId: 'project-test',
    filePath: 'src/value.ts',
    language: 'typescript',
    scope: 'project',
    action,
    assistance,
    code: 'let total = 1;\ntotal = total + 2;\n',
    cursorLine: 2,
  };
}

function tutorResponse(): LearningTutorResponse {
  return learningTutorResponseSchema.parse({
    title: 'Variables hold changing values',
    recap: 'The previous block introduced the file. This block connects the assignment to a value that can change.',
    purpose: 'Understand why a variable is used when a value must be updated during execution.',
    analogy: {
      title: 'A labelled jar',
      explanation: 'A labelled jar can hold a value and that value can be replaced while the label stays the same.',
      mappings: [{
        analogyPart: 'Jar label',
        codePart: 'Variable name',
        explanation: 'The name is how later code finds the stored value.',
      }],
      limits: 'A jar has a physical capacity and a variable is governed by the language type and scope rules.',
    },
    steps: [{
      title: 'Follow the update',
      explanation: 'The runtime creates the binding and then replaces the value stored in it.',
    }],
    concepts: [{
      name: 'Variables',
      category: 'TypeScript',
      mastery: 'independent',
      evidence: 'The learner explained that the name stays stable while the stored value changes.',
    }],
    codePreview: 'total = total + 2;',
    lineByLine: [{
      line: 'total = total + 2;',
      explanation: 'Read the old value, add two, and store the result back under the same name.',
    }],
    checks: ['What evidence proves the learner can predict the value after the update?'],
    sourceNotes: [{ label: 'TypeScript Handbook', url: 'https://www.typescriptlang.org/docs/handbook/2/everyday-types.html' }],
    followUpQuestion: 'What value will total hold after the second line?',
    suggestion: null,
  });
}

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-learning-'));
  directories.push(directory);
  return directory;
}

async function listen(server: http.Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind to a TCP port.');
  return `http://127.0.0.1:${address.port}`;
}
