import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { jsonrepair } from 'jsonrepair';
import {
  directProviderPreset,
  learningTutorResponseSchema,
  teachingDraftSchema,
  type AppSettings,
  type LearningTutorRequest,
  type LearningTutorResponse,
  type LearningReadiness,
  type LearningProviderUsage,
  type TeachingDraft,
  type TeachingDraftGenerateInput,
} from '@kai/contracts';
import { teachingDraftJsonSchema, teachingDraftPrompt } from './teaching-library';

interface SettingsPort {
  load(): Promise<AppSettings>;
}

interface CredentialPort {
  isAvailable(): boolean;
  has?(id: string): Promise<boolean>;
  get(id: string): Promise<string | undefined>;
}

interface TeachingLibraryPort {
  profile(): Promise<string>;
}

const MAX_TUTOR_RESPONSE_CHARS = 200_000;
const MAX_TEACHING_PROFILE_CHARS = 60_000;
const MAX_LEARNING_GUIDE_TAIL_CHARS = 18_000;
const MAX_PROJECT_CONTEXT_CHARS = 60_000;
const MAX_PROJECT_SNAPSHOT_FILE_CHARS = 12_000;
const MAX_PROJECT_TREE_ENTRIES = 400;
const PROJECT_CONTEXT_MAX_DEPTH = 6;
const PROJECT_CONTEXT_SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', '.venv', 'venv', 'node_modules', 'dist', 'build', 'coverage', 'release', 'out',
]);
const PROJECT_CONTEXT_SKIP_FILES = new Set(['.env', '.env.local', '.env.development', '.env.production']);
const PROJECT_CONTEXT_EXTENSIONS = /\.(?:c|cc|cpp|cs|css|go|h|hpp|html|java|js|json|jsx|kt|md|php|py|rb|rs|scss|sh|sql|svelte|toml|ts|tsx|txt|vue|xml|yaml|yml)$/i;
const PROJECT_CONTEXT_SPECIAL_FILES = new Set(['Dockerfile', 'Makefile', 'Procfile']);

const LEARNING_TUTOR_FORMAT_GUIDE = [
  'Return one JSON object with exactly these top-level keys and no additional keys:',
  'title, recap, purpose, analogy, steps, concepts, codePreview, lineByLine, checks, sourceNotes, followUpQuestion, suggestion.',
  'Required value shapes:',
  'title/recap/purpose: strings.',
  'analogy: { title: string, explanation: string, mappings: [{ analogyPart: string, codePart: string, explanation: string }], limits: string }.',
  'steps: at least one { title: string, explanation: string }.',
  'concepts: [{ name: string, category: string, mastery: one of introduced|needs-practice|developing|practising|independent, evidence: string }].',
  'codePreview: string. lineByLine: [{ line: string, explanation: string }]. checks: string[].',
  'sourceNotes: [{ label: string, url: string or null }]. followUpQuestion: string.',
  'suggestion: null or { code: string, language: string, replaceSelection: boolean, explanation: string }.',
  'Use empty arrays where an optional collection has no entries, but steps must contain at least one entry. Do not rename, wrap, or omit keys.',
].join('\n');

interface LearningProviderConfiguration {
  baseUrl: string;
  model: string;
  apiKey: string;
  protocol: 'responses' | 'chat-completions' | 'anthropic-messages' | 'google-generative-ai';
  openRouter: boolean;
}

interface LearningProviderResult {
  content: string;
  usage: LearningProviderUsage | null;
}

const learningTutorJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'title',
    'recap',
    'purpose',
    'analogy',
    'steps',
    'concepts',
    'codePreview',
    'lineByLine',
    'checks',
    'sourceNotes',
    'followUpQuestion',
    'suggestion',
  ],
  properties: {
    title: { type: 'string' },
    recap: { type: 'string' },
    purpose: { type: 'string' },
    analogy: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'explanation', 'mappings', 'limits'],
      properties: {
        title: { type: 'string' },
        explanation: { type: 'string' },
        mappings: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['analogyPart', 'codePart', 'explanation'],
            properties: {
              analogyPart: { type: 'string' },
              codePart: { type: 'string' },
              explanation: { type: 'string' },
            },
          },
        },
        limits: { type: 'string' },
      },
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'explanation'],
        properties: { title: { type: 'string' }, explanation: { type: 'string' } },
      },
    },
    concepts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'category', 'mastery', 'evidence'],
        properties: {
          name: { type: 'string' },
          category: { type: 'string' },
          mastery: { enum: ['introduced', 'needs-practice', 'developing', 'practising', 'independent'] },
          evidence: { type: 'string' },
        },
      },
    },
    codePreview: { type: 'string' },
    lineByLine: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['line', 'explanation'],
        properties: { line: { type: 'string' }, explanation: { type: 'string' } },
      },
    },
    checks: { type: 'array', items: { type: 'string' } },
    sourceNotes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label'],
        properties: { label: { type: 'string' }, url: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
      },
    },
    followUpQuestion: { type: 'string' },
    suggestion: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'language', 'replaceSelection', 'explanation'],
          properties: {
            code: { type: 'string' },
            language: { type: 'string' },
            replaceSelection: { type: 'boolean' },
            explanation: { type: 'string' },
          },
        },
      ],
    },
  },
} as const;

export class DesktopLearningTutor {
  constructor(
    private readonly settings: SettingsPort,
    private readonly credentials: CredentialPort,
    private readonly resolveProjectRoot: (projectId: string) => Promise<string>,
    private readonly teachingLibrary?: TeachingLibraryPort,
    private readonly requestTimeoutMs = 120_000,
  ) {}

  async readiness(): Promise<LearningReadiness> {
    const settings = await this.settings.load();
    const learningTutor = settings.learningTutor;
    const preset = directProviderPreset(learningTutor.provider);
    const supported = true;
    const credentialStored = Boolean(await this.credentials.has?.(learningTutor.credentialId));
    let reason: string | null = null;
    let recovery: string | null = null;
    if (!learningTutor.enabled) {
      reason = 'Learning Tutor API is disabled.';
      recovery = 'Enable the Learning Tutor API in Settings and choose a supported provider.';
    } else if (!learningTutor.model.trim()) {
      reason = 'No Learning Tutor model is configured.';
      recovery = 'Choose a model in Learning Tutor settings before using Learning Mode.';
    } else if (!this.credentials.isAvailable()) {
      reason = 'OS credential encryption is unavailable.';
      recovery = 'Repair or enable the operating-system credential store, then save the API key again.';
    } else if (!credentialStored) {
      reason = `No ${learningTutor.credentialId} credential is stored.`;
      recovery = 'Open Learning Tutor settings and save the provider API key.';
    }
    return {
      enabled: learningTutor.enabled,
      supported,
      ready: reason === null,
      provider: learningTutor.provider,
      displayName: preset.displayName,
      model: learningTutor.model,
      protocol: preset.protocol,
      credentialStored,
      reason,
      recovery,
    };
  }

  async evaluate(request: LearningTutorRequest): Promise<LearningTutorResponse> {
    return (await this.evaluateDetailed(request)).response;
  }

  async evaluateDetailed(request: LearningTutorRequest): Promise<{ response: LearningTutorResponse; usage: LearningProviderUsage }> {
    const provider = await this.providerConfiguration();
    const projectRoot = await this.resolveProjectRoot(request.projectId);
    const scope = request.scope ?? 'project';
    if (scope === 'active-file' && !request.filePath) {
      throw new Error('Open a file before using file context.');
    }
    const [teachingProfile, projectProfile, projectContext] = await Promise.all([
      this.teachingLibrary ? this.teachingLibrary.profile() : Promise.resolve(null),
      loadProjectTeachingProfile(projectRoot),
      scope === 'project' ? loadProjectContext(projectRoot, request.filePath) : Promise.resolve(null),
    ]);
    const prompt = tutorPrompt(request, teachingProfile, projectProfile, projectContext);
    const result = await this.requestAndParse(
      provider,
      prompt,
      'kai_learning_tutor_response',
      learningTutorJsonSchema,
      parseLearningTutorContent,
      (invalid, error) => tutorRepairPrompt(prompt, invalid, error),
    );
    return {
      response: result.value,
      usage: result.usage,
    };
  }

  async generateTeachingDraft(input: TeachingDraftGenerateInput): Promise<TeachingDraft> {
    return (await this.generateTeachingDraftDetailed(input)).draft;
  }

  async generateTeachingDraftDetailed(input: TeachingDraftGenerateInput): Promise<{ draft: TeachingDraft; usage: LearningProviderUsage }> {
    const provider = await this.providerConfiguration();
    const prompt = teachingDraftPrompt(input);
    const result = await this.requestAndParse(
      provider,
      prompt,
      'kai_teaching_draft',
      teachingDraftJsonSchema,
      parseTeachingDraftContent,
      (invalid, error) => teachingDraftRepairPrompt(prompt, invalid, error),
    );
    return {
      draft: result.value,
      usage: result.usage,
    };
  }

  private async providerConfiguration(): Promise<LearningProviderConfiguration> {
    const settings = await this.settings.load();
    const learningTutor = settings.learningTutor;
    if (!learningTutor.enabled) throw new Error('Enable the Learning Tutor API in Settings before using Learning Mode.');
    const preset = directProviderPreset(learningTutor.provider);
    if (!learningTutor.model.trim()) throw new Error('Set a Learning Tutor model in Settings before using Learning Mode.');
    if (!this.credentials.isAvailable()) throw new Error('OS credential encryption is unavailable; Learning Mode will not use a plaintext API key.');
    const apiKey = await this.credentials.get(learningTutor.credentialId);
    if (!apiKey) throw new Error(`Save the ${learningTutor.credentialId} credential in Learning Tutor settings before using Learning Mode.`);
    return {
      baseUrl: learningTutor.baseUrl,
      model: learningTutor.model,
      apiKey,
      protocol: preset.protocol,
      openRouter: learningTutor.provider === 'openrouter',
    };
  }

  private async requestAndParse<T>(
    provider: LearningProviderConfiguration,
    prompt: { system: string; user: string },
    schemaName: string,
    schema: object,
    parse: (content: string) => T,
    repairPrompt: (invalidContent: string, error: unknown) => { system: string; user: string },
  ): Promise<{ value: T; usage: LearningProviderUsage }> {
    const first = await this.requestStructured(provider, prompt, schemaName, schema);
    try {
      return {
        value: parse(first.content),
        usage: first.usage ?? estimateTutorUsage(prompt, first.content),
      };
    } catch (firstError) {
      const repair = repairPrompt(first.content, firstError);
      const repaired = await this.requestStructured(provider, repair, schemaName, schema);
      try {
        return {
          value: parse(repaired.content),
          usage: combinedTutorUsage(first, repaired, prompt, repair),
        };
      } catch (repairError) {
        throw new Error(`The provider returned an invalid Learning Tutor response after one automatic repair attempt. ${messageOf(repairError)}`);
      }
    }
  }

  private async requestStructured(
    provider: LearningProviderConfiguration,
    prompt: { system: string; user: string },
    schemaName: string,
    schema: object,
  ): Promise<LearningProviderResult> {
    if (provider.protocol === 'responses') {
      return this.requestResponses(provider.baseUrl, provider.model, provider.apiKey, prompt, schemaName, schema);
    }
    if (provider.protocol === 'anthropic-messages') {
      return this.requestAnthropicMessages(provider.baseUrl, provider.model, provider.apiKey, prompt, schemaName, schema);
    }
    if (provider.protocol === 'google-generative-ai') {
      return this.requestGoogleGenerativeAi(provider.baseUrl, provider.model, provider.apiKey, prompt, schemaName, schema);
    }
    return this.requestChatCompletions(provider.baseUrl, provider.model, provider.apiKey, prompt, provider.openRouter, schemaName, schema);
  }

  private async requestAnthropicMessages(
    baseUrl: string,
    model: string,
    apiKey: string,
    prompt: { system: string; user: string },
    _schemaName: string,
    _schema: object,
  ): Promise<LearningProviderResult> {
    const response = await fetch(anthropicMessagesUrl(baseUrl), {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        system: prompt.system,
        max_tokens: 6_000,
        messages: [{ role: 'user', content: prompt.user }],
      }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) throw await providerFailure(response);
    const value = await response.json() as Record<string, unknown>;
    return { content: anthropicOutputText(value), usage: providerUsage(value.usage) };
  }

  private async requestGoogleGenerativeAi(
    baseUrl: string,
    model: string,
    apiKey: string,
    prompt: { system: string; user: string },
    _schemaName: string,
    _schema: object,
  ): Promise<LearningProviderResult> {
    const response = await fetch(geminiGenerateUrl(baseUrl, model), {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: prompt.system }] },
        contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
        generationConfig: {
          maxOutputTokens: 6_000,
          responseMimeType: 'application/json',
        },
      }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) throw await providerFailure(response);
    const value = await response.json() as Record<string, unknown>;
    return { content: geminiOutputText(value), usage: providerUsage(value.usageMetadata) };
  }

  private async requestResponses(
    baseUrl: string,
    model: string,
    apiKey: string,
    prompt: { system: string; user: string },
    schemaName: string,
    schema: object,
  ): Promise<LearningProviderResult> {
    const response = await fetch(responsesUrl(baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        store: false,
        input: `${prompt.system}\n\n${prompt.user}`,
        max_output_tokens: 6_000,
        text: {
          format: {
            type: 'json_schema',
            name: schemaName,
            strict: true,
            schema,
          },
        },
      }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) throw await providerFailure(response);
    const value = await response.json() as Record<string, unknown>;
    return { content: responseOutputText(value), usage: providerUsage(value.usage) };
  }

  private async requestChatCompletions(
    baseUrl: string,
    model: string,
    apiKey: string,
    prompt: { system: string; user: string },
    openRouter: boolean,
    schemaName: string,
    schema: object,
  ): Promise<LearningProviderResult> {
    const structured = await this.fetchChatCompletion(baseUrl, model, apiKey, prompt, openRouter, true, schemaName, schema);
    if (structured.ok) return { content: structured.content, usage: structured.usage };
    if (![400, 404, 415, 422].includes(structured.status)) throw structured.error;
    const fallback = await this.fetchChatCompletion(baseUrl, model, apiKey, prompt, openRouter, false, schemaName, schema);
    if (!fallback.ok) throw fallback.error;
    return { content: fallback.content, usage: fallback.usage };
  }

  private async fetchChatCompletion(
    baseUrl: string,
    model: string,
    apiKey: string,
    prompt: { system: string; user: string },
    openRouter: boolean,
    structured: boolean,
    schemaName: string,
    schema: object,
  ): Promise<{ ok: true; content: string; usage: LearningProviderUsage | null } | { ok: false; status: number; error: Error }> {
    try {
      const response = await fetch(chatCompletionsUrl(baseUrl), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...(openRouter ? { 'X-Title': 'KAI Desktop Learning Mode' } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
          max_tokens: 6_000,
          ...(structured ? {
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: schemaName,
                strict: true,
                schema,
              },
            },
          } : {}),
        }),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      if (!response.ok) return { ok: false, status: response.status, error: await providerFailure(response) };
      const value = await response.json() as Record<string, unknown>;
      const content = chatOutputText(value);
      if (!content) throw new Error('The provider returned no tutor content.');
      return { ok: true, content, usage: providerUsage(value.usage) };
    } catch (error) {
      return { ok: false, status: 0, error: error instanceof Error ? error : new Error(String(error)) };
    }
  }
}

export function parseLearningTutorContent(content: string): LearningTutorResponse {
  return parseStructuredResponse(learningTutorResponseSchema, content, 'tutor');
}

export function parseTeachingDraftContent(content: string): TeachingDraft {
  return parseStructuredResponse(teachingDraftSchema, content, 'teaching draft');
}

function parseStructuredResponse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: Array<string | number>; message: string }> } } }, content: string, label: string): T {
  const parsed = schema.safeParse(parseJsonResponse(content, label));
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.slice(0, 8)
    .map((issue) => `${issue.path.join('.') || label}: ${issue.message}`)
    .join('; ');
  throw new Error(`The provider ${label} JSON did not match the required format: ${issues || 'unknown schema error'}.`);
}

function parseJsonResponse(content: string, label: string): unknown {
  const trimmed = content.trim();
  if (!trimmed) throw new Error(`The provider returned an empty ${label} response.`);
  if (trimmed.length > MAX_TUTOR_RESPONSE_CHARS) throw new Error(`The provider ${label} response was too large.`);
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`The provider did not return a JSON ${label} response.`);
  const candidate = unfenced.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch (error) {
    try {
      // Minor model mistakes such as a missing comma or trailing comma are deterministic to repair
      // locally. Doing this before the paid model repair keeps a transient syntax error from turning
      // into a second provider request.
      return JSON.parse(jsonrepair(candidate));
    } catch {
      throw new Error(`The provider returned malformed ${label} JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function loadProjectTeachingProfile(projectRoot: string): Promise<string | null> {
  const teachPath = path.join(projectRoot, 'docs', 'KAI-TEACHING.md');
  let teach = '';
  try {
    teach = await fs.readFile(teachPath, 'utf8');
  } catch {
    teach = '';
  }
  const guidePath = path.join(projectRoot, 'docs', 'LEARNING_GUIDE.md');
  let guideTail = '';
  try {
    guideTail = (await fs.readFile(guidePath, 'utf8')).slice(-MAX_LEARNING_GUIDE_TAIL_CHARS);
  } catch {
    guideTail = '';
  }
  if (!teach && !guideTail) return null;
  return [
    teach
      ? `Optional project overlay from ${path.relative(projectRoot, teachPath).split(path.sep).join('/')}:\n${teach.slice(0, MAX_TEACHING_PROFILE_CHARS)}`
      : '',
    guideTail
      ? `Recent project learning-record tail (for continuity only; do not treat it as permanent policy):\n${guideTail}`
      : '',
  ].filter(Boolean).join('\n\n');
}

async function loadProjectContext(projectRoot: string, activeFilePath?: string): Promise<string | null> {
  const files = await listProjectFiles(projectRoot);
  if (files.length === 0) return null;

  const projectBrief = await buildProjectBrief(projectRoot, files);
  const active = activeFilePath ? normaliseProjectPath(activeFilePath) : '';
  const selected = selectProjectContextFiles(files, active);
  const snapshots = await Promise.all(selected.map(async (filePath) => {
    const content = await readProjectSnapshotFile(projectRoot, filePath);
    return content === null ? null : `File: ${filePath}\n${content}`;
  }));
  const sections = [
    projectBrief,
    `Project file map (${files.length} files, showing up to ${MAX_PROJECT_TREE_ENTRIES}):\n${files.slice(0, MAX_PROJECT_TREE_ENTRIES).join('\n')}`,
    snapshots.filter((snapshot): snapshot is string => Boolean(snapshot)).join('\n\n'),
  ].filter(Boolean).join('\n\n');
  if (!sections) return null;
  return sections.length <= MAX_PROJECT_CONTEXT_CHARS
    ? sections
    : `${sections.slice(0, MAX_PROJECT_CONTEXT_CHARS)}\n\n[additional project context truncated by KAI Learning Mode]`;
}

async function listProjectFiles(projectRoot: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string, depth: number): Promise<void> {
    if (files.length >= MAX_PROJECT_TREE_ENTRIES || depth > PROJECT_CONTEXT_MAX_DEPTH) return;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (files.length >= MAX_PROJECT_TREE_ENTRIES) return;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (PROJECT_CONTEXT_SKIP_DIRS.has(entry.name)) continue;
        await visit(path.join(directory, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile() || PROJECT_CONTEXT_SKIP_FILES.has(entry.name)) continue;
      const relative = normaliseProjectPath(path.relative(projectRoot, path.join(directory, entry.name)));
      if (relative && isSafeProjectRelativePath(relative) && (PROJECT_CONTEXT_EXTENSIONS.test(relative) || PROJECT_CONTEXT_SPECIAL_FILES.has(entry.name))) files.push(relative);
    }
  }
  await visit(projectRoot, 0);
  return files;
}

function selectProjectContextFiles(files: readonly string[], activeFilePath = ''): string[] {
  const preferredNames = [
    'package.json',
    'pyproject.toml',
    'Cargo.toml',
    'go.mod',
    'composer.json',
    'requirements.txt',
    'README.md',
    'README',
    'docs/KAI-TEACHING.md',
    'docs/LEARNING_GUIDE.md',
  ];
  const preferred = preferredNames.filter((filePath) => files.includes(filePath));
  const activeDirectory = path.posix.dirname(activeFilePath);
  const activeStem = path.posix.basename(activeFilePath).replace(/\.[^.]+$/, '');
  const nearby = files.filter((filePath) => filePath !== activeFilePath && path.posix.dirname(filePath) === activeDirectory);
  const relatedTests = files.filter((filePath) => filePath !== activeFilePath
    && /(?:^|\/)(?:__tests__|tests?|specs?)\//i.test(filePath)
    && filePath.toLowerCase().includes(activeStem.toLowerCase()));
  const entryPoints = files.filter((filePath) => /(?:^|\/)(?:src\/)?(?:index|main|app)\.(?:ts|tsx|js|jsx|py|go|rs|java|cs)$/i.test(filePath));
  const architecture = files.filter((filePath) => /(?:^|\/)(?:types?|schema|config|store|router|routes?|api|client|server|context|state)\.(?:ts|tsx|js|jsx|py|go|rs|java|cs)$/i.test(filePath));
  if (!activeFilePath) {
    const tests = files.filter((filePath) => /(?:^|\/)(?:__tests__|tests?|specs?)\//i.test(filePath) || /\.(?:test|spec)\.[^.]+$/i.test(filePath));
    const manifests = files.filter((filePath) => /^(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod|composer\.json|requirements\.txt|Dockerfile|Makefile)$/i.test(filePath));
    return [...new Set([...preferred, ...entryPoints, ...architecture, ...tests, ...manifests, ...files])].slice(0, 24);
  }
  return [...new Set([...preferred, ...relatedTests, ...nearby, ...entryPoints, ...architecture])]
    .filter((filePath) => filePath !== activeFilePath)
    .slice(0, 16);
}

async function buildProjectBrief(projectRoot: string, files: readonly string[]): Promise<string> {
  let projectName = path.basename(projectRoot);
  const topLevel = new Map<string, number>();
  for (const file of files) {
    const root = file.includes('/') ? file.split('/')[0]! : '(root)';
    topLevel.set(root, (topLevel.get(root) ?? 0) + 1);
  }
  const tests = files.filter((file) => /(?:^|\/)(?:__tests__|tests?|specs?)\//i.test(file) || /\.(?:test|spec)\.[^.]+$/i.test(file));
  const docs = files.filter((file) => /(?:^|\/)docs?\//i.test(file) || /^README(?:\.[^.]+)?$/i.test(file));
  const entryPoints = files.filter((file) => /(?:^|\/)(?:src\/)?(?:index|main|app)\.(?:ts|tsx|js|jsx|py|go|rs|java|cs)$/i.test(file));
  const manifests = files.filter((file) => /^(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod|composer\.json|requirements\.txt|Dockerfile|Makefile)$/i.test(file));

  let packageSummary: string | null = null;
  if (files.includes('package.json')) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8')) as {
        name?: unknown;
        scripts?: unknown;
        dependencies?: unknown;
        devDependencies?: unknown;
      };
      const scripts = manifest.scripts && typeof manifest.scripts === 'object'
        ? Object.keys(manifest.scripts as Record<string, unknown>).slice(0, 16)
        : [];
      const dependencies = manifest.dependencies && typeof manifest.dependencies === 'object'
        ? Object.keys(manifest.dependencies as Record<string, unknown>).slice(0, 24)
        : [];
      const devDependencies = manifest.devDependencies && typeof manifest.devDependencies === 'object'
        ? Object.keys(manifest.devDependencies as Record<string, unknown>).slice(0, 24)
        : [];
      if (typeof manifest.name === 'string' && manifest.name.trim()) projectName = manifest.name.trim();
      packageSummary = [
        typeof manifest.name === 'string' ? `Package: ${manifest.name}` : null,
        scripts.length > 0 ? `Available commands: ${scripts.map((name) => `npm run ${name}`).join(', ')}` : null,
        dependencies.length > 0 ? `Runtime dependencies: ${dependencies.join(', ')}` : null,
        devDependencies.length > 0 ? `Development dependencies: ${devDependencies.join(', ')}` : null,
      ].filter((line): line is string => line !== null).join('\n');
    } catch {
      packageSummary = null;
    }
  }

  return [
    `Project brief: ${projectName}`,
    `Project inventory: ${files.length} relevant source, documentation, and configuration files were discovered.`,
    `Main areas: ${[...topLevel.entries()].sort((left, right) => right[1] - left[1]).slice(0, 16).map(([name, count]) => `${name} (${count})`).join(', ')}.`,
    entryPoints.length > 0 ? `Likely entry points: ${entryPoints.slice(0, 12).join(', ')}.` : 'No conventional entry point was identified.',
    tests.length > 0 ? `Tests found: ${tests.slice(0, 24).join(', ')}.` : 'No test files were identified in the bounded project scan.',
    docs.length > 0 ? `Documentation found: ${docs.slice(0, 12).join(', ')}.` : 'No project documentation was identified.',
    manifests.length > 0 ? `Manifests and build files: ${manifests.join(', ')}.` : '',
    packageSummary,
  ].filter((line): line is string => Boolean(line)).join('\n');
}

async function readProjectSnapshotFile(projectRoot: string, relativePath: string): Promise<string | null> {
  if (!isSafeProjectRelativePath(relativePath)) return null;
  try {
    const content = await fs.readFile(path.join(projectRoot, relativePath), 'utf8');
    return content.length <= MAX_PROJECT_SNAPSHOT_FILE_CHARS
      ? content
      : `${content.slice(0, MAX_PROJECT_SNAPSHOT_FILE_CHARS)}\n[file truncated by KAI Learning Mode]`;
  } catch {
    return null;
  }
}

function normaliseProjectPath(value: string): string {
  return value.split(path.sep).join('/').replace(/^\.\//, '');
}

function isSafeProjectRelativePath(value: string): boolean {
  const normalised = value.replace(/\\/g, '/');
  return Boolean(normalised) && !normalised.startsWith('/') && !normalised.split('/').includes('..') && !/^[A-Za-z]:/.test(normalised);
}

function tutorPrompt(
  request: LearningTutorRequest,
  teachingLibrary: string | null,
  projectProfile: string | null,
  projectContext: string | null,
): { system: string; user: string } {
  const assistance = {
    learn: 'Teach through explanation and questions. Do not give the answer before asking the learner to attempt it. Your first step must be titled "Do this next" and ask the learner to inspect or predict one specific thing in the active project.',
    guided: 'Give a concrete hint and a small, clearly bounded example. Your first step must be titled "Do this next" and ask the learner to complete one small project task.',
    pair: 'Work as a pairing partner: explain the reasoning and offer a partial implementation, but leave one meaningful decision to the learner. Your first step must be titled "Do this next" and assign that decision or task to the learner.',
    copilot: 'You may provide a complete suggestion, but explain it and state that the learner must verify and own it. Your first step must be titled "Do this next" and tell the learner exactly how to review, run, or verify the suggestion.',
  }[request.assistance];
  const action = {
    'explain-selection': 'Explain the selected code in its file and project context.',
    'explain-file': 'Explain the file structure, its role in the wider project, and the most important execution path.',
    hint: 'Give the smallest useful hint; do not reveal the full solution unless assistance is copilot.',
    'check-code': 'Check the submitted code. Identify errors, invariants, and one precise next action. Do not silently rewrite the learner’s work.',
    'explain-error': 'Explain the reported error from cause to symptom, then give one bounded diagnostic action.',
    'next-step': 'Recommend the next small learning step from the whole-project picture when available, then connect it to a verifiable active-file action.',
    complete: 'Offer a completion only when the assistance level permits it. Clearly label generated code as a suggestion.',
  }[request.action];
  const scope = request.scope ?? 'project';
  const hasActiveFile = Boolean(request.filePath);
  const hasActiveCode = hasActiveFile && Boolean(request.code.trim());
  const scopeInstruction = scope === 'project'
    ? `Scope: whole project. Act like a senior developer guiding a novice through this codebase. Use the project brief, file map, manifests, docs, tests, nearby files, and active file together. ${hasActiveFile ? 'Explain how the active file fits the larger architecture, data flow, and verification path.' : 'No file is open. Guide the learner from the project snapshot and name a concrete file or command to inspect first.'} Do not pretend to know files or results outside the bounded snapshot.`
    : 'Scope: active file only. Teach from the active file and selected code. Mention the wider project only when needed to explain a concrete dependency, and state clearly when more project context is required.';
  const code = limitMiddle(request.code, 80_000);
  const selection = request.selectedText ? limitMiddle(request.selectedText, 30_000) : '';
  const system = [
    'You are KAI Learning Mode, an evidence-based coding tutor inside a desktop editor.',
    'Return only JSON matching the provided schema. Never include markdown fences around the JSON.',
    LEARNING_TUTOR_FORMAT_GUIDE,
    'Be precise, age-neutral, and technically correct. Do not invent APIs, files, test results, or learner ability.',
    'Write for a total beginner: briefly define jargon, avoid unexplained shorthand, and make every recommendation executable without requiring prior knowledge of the project.',
    'The first item in steps must be titled exactly "Do this next". It must be one small action that the learner can complete now, name the relevant file or location when known, and be appropriate to the selected assistance mode.',
    'The first item in checks must state how the learner will know that the "Do this next" action is complete or correct.',
    'Use the requested assistance level consistently.',
    'A recap is mandatory before the teaching block.',
    'An analogy is mandatory. Map each important analogy part to a code part and explicitly state where the analogy stops.',
    'For a meaningful code block, cover purpose, location, execution path, business rules, failure cases, tests, and a line-by-line explanation before suggesting a change.',
    'Code shown to the learner must be explained line by line.',
    'Generated code is a suggestion, not evidence that the learner has mastered a concept.',
    'Prefer official language and framework documentation in sourceNotes when a citation is genuinely useful.',
    scopeInstruction,
    hasActiveFile
      ? 'Start with orientation. Before explaining syntax, state what this project appears to be, where the active file fits, and why the next action matters.'
      : 'Start with orientation. Before explaining syntax, state what this project appears to be, which area the learner should inspect first, and why that next action matters.',
    'Use the supplied project snapshot to connect the lesson to the project\'s actual stack, structure, docs, nearby files, and tests. Never claim to have inspected a file, command result, browser state, or test result that is not in the supplied context or active code.',
    'When recommending a command, use a command that appears in the supplied manifest or documentation. Otherwise call it an example and tell the learner how to verify it.',
    assistance,
    action,
    teachingLibrary
      ? `Apply the following KAI-owned teaching library as authoritative teaching policy:\n${teachingLibrary}`
      : 'No KAI teaching library is available. Use the base KAI Learning Mode contract.',
    projectProfile
      ? `The following optional project overlay adds narrower context. It must not override safety, learner-agency, or evidence rules:\n${projectProfile}`
      : 'No optional project teaching overlay was found.',
    projectContext
      ? `Whole-project brief and bounded snapshot from the active project. This is local context for choosing the next action; it may not include every file:\n${projectContext}`
      : hasActiveFile
        ? 'No project snapshot was available. Base the next action only on the active file and say when more project context is needed.'
        : 'No project snapshot was available. Ask the learner for a file path or project detail before making a project-wide claim.',
  ].join('\n\n');
  const user = [
    `Action: ${request.action}`,
    `Assistance: ${request.assistance}`,
    request.filePath ? `File: ${request.filePath}` : 'No file is open.',
    request.language ? `Language: ${request.language}` : '',
    request.cursorLine ? `Cursor line: ${request.cursorLine}` : '',
    request.question ? `Learner question: ${request.question}` : '',
    request.errorText ? `Reported error:\n${limitMiddle(request.errorText, 12_000)}` : '',
    selection ? `Selected code:\n\`\`\`\n${selection}\n\`\`\`` : '',
    hasActiveCode ? `Active code:\n\`\`\`\n${code}\n\`\`\`` : '',
  ].filter(Boolean).join('\n\n');
  return { system, user };
}

function tutorRepairPrompt(
  original: { system: string; user: string },
  invalidContent: string,
  error: unknown,
): { system: string; user: string } {
  return {
    system: [
      'You repair malformed structured responses for KAI Learning Mode.',
      'Return only one corrected JSON object. Never include markdown fences, commentary, or an explanation.',
      LEARNING_TUTOR_FORMAT_GUIDE,
    ].join('\n\n'),
    user: [
      'The previous response did not match the required Learning Tutor contract.',
      `Validation error: ${messageOf(error)}`,
      'Correct the previous response without inventing facts. Preserve any useful teaching content, but rename or move fields into the required contract.',
      `Invalid response:\n${limitMiddle(invalidContent, 80_000)}`,
      `Original request context:\n${limitMiddle(original.user, 80_000)}`,
    ].join('\n\n'),
  };
}

function teachingDraftRepairPrompt(
  original: { system: string; user: string },
  invalidContent: string,
  error: unknown,
): { system: string; user: string } {
  return {
    system: [
      'You repair malformed structured responses for KAI teaching-library drafts.',
      'Return only one JSON object with exactly title, description, and content. Never include markdown fences or commentary.',
    ].join('\n\n'),
    user: [
      `Validation error: ${messageOf(error)}`,
      `Invalid response:\n${limitMiddle(invalidContent, 80_000)}`,
      `Original request:\n${limitMiddle(original.user, 40_000)}`,
    ].join('\n\n'),
  };
}

function combinedTutorUsage(
  first: LearningProviderResult,
  repaired: LearningProviderResult,
  firstPrompt: { system: string; user: string },
  repairPrompt: { system: string; user: string },
): LearningProviderUsage {
  if (first.usage && repaired.usage && first.usage.source === 'provider' && repaired.usage.source === 'provider') {
    return {
      inputTokens: first.usage.inputTokens + repaired.usage.inputTokens,
      outputTokens: first.usage.outputTokens + repaired.usage.outputTokens,
      source: 'provider',
    };
  }
  const firstUsage = first.usage ?? estimateTutorUsage(firstPrompt, first.content);
  const repairedUsage = repaired.usage ?? estimateTutorUsage(repairPrompt, repaired.content);
  return {
    inputTokens: firstUsage.inputTokens + repairedUsage.inputTokens,
    outputTokens: firstUsage.outputTokens + repairedUsage.outputTokens,
    source: 'estimated',
  };
}

function limitMiddle(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) return value;
  const head = Math.floor(maxCharacters * 0.65);
  const tail = maxCharacters - head;
  return `${value.slice(0, head)}\n\n[context truncated by KAI Learning Mode]\n\n${value.slice(-tail)}`;
}

function responsesUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return /\/responses$/i.test(trimmed) ? trimmed : `${trimmed}/responses`;
}

function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return /\/chat\/completions$/i.test(trimmed) ? trimmed : `${trimmed}/chat/completions`;
}

function anthropicMessagesUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return /\/messages$/i.test(trimmed) ? trimmed : `${trimmed}/messages`;
}

function geminiGenerateUrl(baseUrl: string, model: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  const modelId = model.trim().replace(/^models\//, '');
  if (/:generateContent$/i.test(trimmed)) return trimmed;
  return `${trimmed}/models/${encodeURIComponent(modelId)}:generateContent`;
}

function anthropicOutputText(value: Record<string, unknown>): string {
  const content = Array.isArray(value.content) ? value.content : [];
  const text = content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const record = block as Record<string, unknown>;
      return record.type === 'text' && typeof record.text === 'string' ? record.text : '';
    })
    .join('');
  if (!text.trim()) throw new Error('The provider returned no tutor content.');
  return text;
}

function geminiOutputText(value: Record<string, unknown>): string {
  const candidate = Array.isArray(value.candidates) && value.candidates[0] && typeof value.candidates[0] === 'object'
    ? value.candidates[0] as Record<string, unknown>
    : null;
  const parts = candidate && candidate.content && typeof candidate.content === 'object'
    ? (candidate.content as Record<string, unknown>).parts
    : null;
  const text = Array.isArray(parts)
    ? parts.map((part) => part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string'
      ? (part as Record<string, unknown>).text as string
      : '').join('')
    : '';
  if (!text.trim()) throw new Error('The provider returned no tutor content.');
  return text;
}

function responseOutputText(value: Record<string, unknown>): string {
  if (typeof value.output_text === 'string' && value.output_text.trim()) return value.output_text;
  const output = Array.isArray(value.output) ? value.output : [];
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const content = Array.isArray((item as Record<string, unknown>).content)
      ? (item as Record<string, unknown>).content as unknown[]
      : [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const record = block as Record<string, unknown>;
      if (typeof record.text === 'string' && (record.type === 'output_text' || record.type === 'text')) parts.push(record.text);
    }
  }
  if (!parts.length) throw new Error('The provider returned no tutor content.');
  return parts.join('');
}

function chatOutputText(value: Record<string, unknown>): string | null {
  const choice = Array.isArray(value.choices) && value.choices[0] && typeof value.choices[0] === 'object'
    ? value.choices[0] as Record<string, unknown>
    : null;
  const message = choice && choice.message && typeof choice.message === 'object'
    ? choice.message as Record<string, unknown>
    : null;
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (!block || typeof block !== 'object') return '';
      const text = (block as Record<string, unknown>).text;
      return typeof text === 'string' ? text : '';
    }).join('') || null;
  }
  return null;
}

function providerUsage(value: unknown): LearningProviderUsage | null {
  if (!value || typeof value !== 'object') return null;
  const usage = value as Record<string, unknown>;
  const input = typeof usage.input_tokens === 'number'
    ? usage.input_tokens
    : typeof usage.promptTokenCount === 'number'
      ? usage.promptTokenCount
    : typeof usage.prompt_tokens === 'number'
      ? usage.prompt_tokens
      : null;
  const output = typeof usage.output_tokens === 'number'
    ? usage.output_tokens
    : typeof usage.candidatesTokenCount === 'number'
      ? usage.candidatesTokenCount
    : typeof usage.completion_tokens === 'number'
      ? usage.completion_tokens
      : null;
  if (input === null || output === null || input < 0 || output < 0) return null;
  return { inputTokens: Math.round(input), outputTokens: Math.round(output), source: 'provider' };
}

function estimateTutorUsage(
  prompt: { system: string; user: string },
  content: string,
): LearningProviderUsage {
  // Four characters per token is deliberately conservative for mixed source code and prose.
  return {
    inputTokens: Math.ceil((prompt.system.length + prompt.user.length) / 4),
    outputTokens: Math.ceil(content.length / 4),
    source: 'estimated',
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function providerFailure(response: Response): Promise<Error> {
  const detail = await response.text();
  let message = detail.trim();
  try {
    const parsed = JSON.parse(detail) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === 'string') message = parsed.error.message;
  } catch {
    // Keep the plain response body when it is not JSON.
  }
  return new Error(`Learning provider request failed (${response.status})${message ? `: ${message.slice(0, 2_000)}` : '.'}`);
}

export { learningTutorJsonSchema };
