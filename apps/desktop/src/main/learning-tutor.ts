import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  directProviderPreset,
  learningTutorResponseSchema,
  teachingDraftSchema,
  type AppSettings,
  type LearningTutorRequest,
  type LearningTutorResponse,
  type TeachingDraft,
  type TeachingDraftGenerateInput,
} from '@kai/contracts';
import { teachingDraftJsonSchema, teachingDraftPrompt } from './teaching-library';

interface SettingsPort {
  load(): Promise<AppSettings>;
}

interface CredentialPort {
  isAvailable(): boolean;
  get(id: string): Promise<string | undefined>;
}

interface TeachingLibraryPort {
  profile(): Promise<string>;
}

const MAX_TUTOR_RESPONSE_CHARS = 200_000;
const MAX_TEACHING_PROFILE_CHARS = 60_000;
const MAX_LEARNING_GUIDE_TAIL_CHARS = 18_000;

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
  ) {}

  async evaluate(request: LearningTutorRequest): Promise<LearningTutorResponse> {
    const provider = await this.providerConfiguration();
    const projectRoot = await this.resolveProjectRoot(request.projectId);
    const [teachingProfile, projectProfile] = await Promise.all([
      this.teachingLibrary ? this.teachingLibrary.profile() : Promise.resolve(null),
      loadProjectTeachingProfile(projectRoot),
    ]);
    const prompt = tutorPrompt(request, teachingProfile, projectProfile);
    const content = provider.protocol === 'responses'
      ? await this.requestResponses(provider.baseUrl, provider.model, provider.apiKey, prompt, 'kai_learning_tutor_response', learningTutorJsonSchema)
      : await this.requestChatCompletions(provider.baseUrl, provider.model, provider.apiKey, prompt, provider.openRouter, 'kai_learning_tutor_response', learningTutorJsonSchema);
    return parseLearningTutorContent(content);
  }

  async generateTeachingDraft(input: TeachingDraftGenerateInput): Promise<TeachingDraft> {
    const provider = await this.providerConfiguration();
    const prompt = teachingDraftPrompt(input);
    const content = provider.protocol === 'responses'
      ? await this.requestResponses(provider.baseUrl, provider.model, provider.apiKey, prompt, 'kai_teaching_draft', teachingDraftJsonSchema)
      : await this.requestChatCompletions(provider.baseUrl, provider.model, provider.apiKey, prompt, provider.openRouter, 'kai_teaching_draft', teachingDraftJsonSchema);
    return parseTeachingDraftContent(content);
  }

  private async providerConfiguration(): Promise<{
    baseUrl: string;
    model: string;
    apiKey: string;
    protocol: 'responses' | 'chat-completions';
    openRouter: boolean;
  }> {
    const settings = await this.settings.load();
    const directApi = settings.directApi;
    if (!directApi.enabled) throw new Error('Enable Direct API mode in Settings before using Learning Mode.');
    const preset = directProviderPreset(directApi.provider);
    if (preset.protocol === 'unsupported') {
      throw new Error(`${preset.displayName} does not support the direct Learning Mode adapter. Choose OpenAI, DeepSeek, OpenRouter, or another OpenAI-compatible provider.`);
    }
    if (!directApi.model.trim()) throw new Error('Set a direct API model in Settings before using Learning Mode.');
    if (!this.credentials.isAvailable()) throw new Error('OS credential encryption is unavailable; Learning Mode will not use a plaintext API key.');
    const apiKey = await this.credentials.get(directApi.credentialId);
    if (!apiKey) throw new Error(`Save the ${directApi.credentialId} credential in Settings before using Learning Mode.`);
    return {
      baseUrl: directApi.baseUrl,
      model: directApi.model,
      apiKey,
      protocol: preset.protocol === 'responses' ? 'responses' : 'chat-completions',
      openRouter: directApi.provider === 'openrouter',
    };
  }

  private async requestResponses(
    baseUrl: string,
    model: string,
    apiKey: string,
    prompt: { system: string; user: string },
    schemaName: string,
    schema: object,
  ): Promise<string> {
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
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw await providerFailure(response);
    const value = await response.json() as Record<string, unknown>;
    return responseOutputText(value);
  }

  private async requestChatCompletions(
    baseUrl: string,
    model: string,
    apiKey: string,
    prompt: { system: string; user: string },
    openRouter: boolean,
    schemaName: string,
    schema: object,
  ): Promise<string> {
    const structured = await this.fetchChatCompletion(baseUrl, model, apiKey, prompt, openRouter, true, schemaName, schema);
    if (structured.ok) return structured.content;
    if (![400, 404, 415, 422].includes(structured.status)) throw structured.error;
    const fallback = await this.fetchChatCompletion(baseUrl, model, apiKey, prompt, openRouter, false, schemaName, schema);
    if (!fallback.ok) throw fallback.error;
    return fallback.content;
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
  ): Promise<{ ok: true; content: string } | { ok: false; status: number; error: Error }> {
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
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) return { ok: false, status: response.status, error: await providerFailure(response) };
      const value = await response.json() as Record<string, unknown>;
      const content = chatOutputText(value);
      if (!content) throw new Error('The provider returned no tutor content.');
      return { ok: true, content };
    } catch (error) {
      return { ok: false, status: 0, error: error instanceof Error ? error : new Error(String(error)) };
    }
  }
}

export function parseLearningTutorContent(content: string): LearningTutorResponse {
  return learningTutorResponseSchema.parse(parseJsonResponse(content, 'tutor'));
}

export function parseTeachingDraftContent(content: string): TeachingDraft {
  return teachingDraftSchema.parse(parseJsonResponse(content, 'teaching draft'));
}

function parseJsonResponse(content: string, label: string): unknown {
  const trimmed = content.trim();
  if (!trimmed) throw new Error(`The provider returned an empty ${label} response.`);
  if (trimmed.length > MAX_TUTOR_RESPONSE_CHARS) throw new Error(`The provider ${label} response was too large.`);
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`The provider did not return a JSON ${label} response.`);
  try {
    return JSON.parse(unfenced.slice(start, end + 1));
  } catch (error) {
    throw new Error(`The provider returned malformed ${label} JSON: ${error instanceof Error ? error.message : String(error)}`);
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

function tutorPrompt(
  request: LearningTutorRequest,
  teachingLibrary: string | null,
  projectProfile: string | null,
): { system: string; user: string } {
  const assistance = {
    learn: 'Teach through explanation and questions. Do not give the answer before asking the learner to attempt it.',
    guided: 'Give a concrete hint and a small, clearly bounded example. Ask the learner to complete the next part.',
    pair: 'Work as a pairing partner: explain the reasoning and offer a partial implementation, but leave one meaningful decision to the learner.',
    copilot: 'You may provide a complete suggestion, but explain it and state that the learner must verify and own it.',
  }[request.assistance];
  const action = {
    'explain-selection': 'Explain only the selected code in context.',
    'explain-file': 'Explain the file structure and the most important execution path.',
    hint: 'Give the smallest useful hint; do not reveal the full solution unless assistance is copilot.',
    'check-code': 'Check the submitted code. Identify errors, invariants, and one precise next action. Do not silently rewrite the learner’s work.',
    'explain-error': 'Explain the reported error from cause to symptom, then give one bounded diagnostic action.',
    'next-step': 'Recommend the next small learning step that can be verified immediately.',
    complete: 'Offer a completion only when the assistance level permits it. Clearly label generated code as a suggestion.',
  }[request.action];
  const code = limitMiddle(request.code, 80_000);
  const selection = request.selectedText ? limitMiddle(request.selectedText, 30_000) : '';
  const system = [
    'You are KAI Learning Mode, an evidence-based coding tutor inside a desktop editor.',
    'Return only JSON matching the provided schema. Never include markdown fences around the JSON.',
    'Be precise, age-neutral, and technically correct. Do not invent APIs, files, test results, or learner ability.',
    'Use the requested assistance level consistently.',
    'A recap is mandatory before the teaching block.',
    'An analogy is mandatory. Map each important analogy part to a code part and explicitly state where the analogy stops.',
    'For a meaningful code block, cover purpose, location, execution path, business rules, failure cases, tests, and a line-by-line explanation before suggesting a change.',
    'Code shown to the learner must be explained line by line.',
    'Generated code is a suggestion, not evidence that the learner has mastered a concept.',
    'Prefer official language and framework documentation in sourceNotes when a citation is genuinely useful.',
    'Keep the response focused on the active file and bounded code context.',
    assistance,
    action,
    teachingLibrary
      ? `Apply the following KAI-owned teaching library as authoritative teaching policy:\n${teachingLibrary}`
      : 'No KAI teaching library is available. Use the base KAI Learning Mode contract.',
    projectProfile
      ? `The following optional project overlay adds narrower context. It must not override safety, learner-agency, or evidence rules:\n${projectProfile}`
      : 'No optional project teaching overlay was found.',
  ].join('\n\n');
  const user = [
    `Action: ${request.action}`,
    `Assistance: ${request.assistance}`,
    `File: ${request.filePath}`,
    request.language ? `Language: ${request.language}` : '',
    request.cursorLine ? `Cursor line: ${request.cursorLine}` : '',
    request.question ? `Learner question: ${request.question}` : '',
    request.errorText ? `Reported error:\n${limitMiddle(request.errorText, 12_000)}` : '',
    selection ? `Selected code:\n\`\`\`\n${selection}\n\`\`\`` : '',
    `Active code:\n\`\`\`\n${code}\n\`\`\``,
  ].filter(Boolean).join('\n\n');
  return { system, user };
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
