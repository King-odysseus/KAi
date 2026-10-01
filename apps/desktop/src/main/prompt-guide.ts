import {
  TEAM_ROLE_INFO,
  directProviderPreset,
  isBuiltInRole,
  isLocalProvider,
  promptRefineResultSchema,
  promptGuideResultSchema,
  type AgentTeam,
  type AppSettings,
  type PromptGuideInput,
  type PromptGuideReadiness,
  type PromptGuideResult,
  type PromptRefineInput,
  type PromptRefineResult,
  type TeamWorkerRoleId,
} from '@kai/contracts';
import { loadProjectContext, parseJsonResponse, type ProviderConnection } from './learning-tutor';

/** Enough of the tutor to borrow its provider plumbing, so the guide adds no second HTTP client. */
export interface StructuredRequester {
  structuredRequest<T>(
    connection: ProviderConnection,
    names: { feature: string; card: string },
    prompt: { system: string; user: string },
    schemaName: string,
    schema: object,
    parse: (content: string) => T,
    /** A larger output budget for a request that writes a long document. */
    options?: { maxOutputTokens?: number },
  ): Promise<T>;
}

export interface PromptGuidePorts {
  settings(): Promise<AppSettings>;
  /** The team the project uses, so the guide only writes prompts for roles that exist. */
  team(projectId: string): Promise<AgentTeam>;
  projectRoot(projectId: string): Promise<string>;
  credentialStored(id: string): Promise<boolean>;
  vaultAvailable(): boolean;
  requester: StructuredRequester;
}

const NAMES = { feature: 'the Prompt Guide', card: 'Prompt Guide' };
// The guide plans; it does not need the whole project, only enough to name real files and folders.
const GUIDE_CONTEXT_CHARS = 12_000;
const WORKER_ROLES: readonly TeamWorkerRoleId[] = ['frontend', 'backend', 'tests', 'securityReviewer', 'codeReviewer', 'docs'];

const PROMPT_GUIDE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['goal', 'assumptions', 'questions', 'prompts'],
  properties: {
    goal: { type: 'string' },
    assumptions: { type: 'array', items: { type: 'string' } },
    questions: { type: 'array', items: { type: 'string' } },
    prompts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['role', 'title', 'prompt', 'paths'],
        properties: {
          role: { type: 'string' },
          title: { type: 'string' },
          prompt: { type: 'string' },
          paths: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

const PROMPT_REFINEMENT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string' },
  },
} as const;

/**
 * Helps the user say what they want before a team runs: it restates the idea as one clear goal, lists what it had to
 * assume and what it still needs to know, and writes a self-contained prompt for each teammate. It reads the project
 * but never changes it, and it runs on its own provider connection from Settings.
 */
export class DesktopPromptGuide {
  constructor(private readonly ports: PromptGuidePorts) {}

  async readiness(): Promise<PromptGuideReadiness> {
    return this.connectionReadiness((await this.ports.settings()).promptGuide, 'Prompt Guide');
  }

  private async connectionReadiness(
    connection: AppSettings['promptGuide'] | AppSettings['directApi'],
    card: 'Prompt Guide' | 'Direct API',
  ): Promise<PromptGuideReadiness> {
    const displayName = directProviderPreset(connection.provider).displayName;
    const local = isLocalProvider(connection.provider);
    let reason: string | null = null;
    if (!connection.enabled) {
      reason = card === 'Prompt Guide'
        ? 'The Prompt Guide is off. Turn it on and add its API key under Settings, Prompt Guide.'
        : 'Direct API mode is off. Turn it on under Settings, Direct API.';
    } else if (!connection.model.trim()) {
      reason = `Choose a ${card} model under Settings, ${card}.`;
    } else if (!local && !this.ports.vaultAvailable()) {
      reason = `The OS credential vault is unavailable, so ${card} cannot read its key.`;
    } else if (!local && !(await this.ports.credentialStored(connection.credentialId))) {
      reason = `Save the ${connection.credentialId} key under Settings, ${card}.`;
    }
    return { ready: reason === null, displayName, model: connection.model, reason };
  }

  async refine(input: PromptGuideInput): Promise<PromptGuideResult> {
    const [settings, team, root] = await Promise.all([
      this.ports.settings(),
      this.ports.team(input.projectId),
      this.ports.projectRoot(input.projectId),
    ]);
    const context = await loadProjectContext(root, undefined, GUIDE_CONTEXT_CHARS).catch(() => null);
    const prompt = buildPromptGuidePrompt(input, team, context);
    const result = await this.ports.requester.structuredRequest(
      settings.promptGuide,
      NAMES,
      prompt,
      'kai_prompt_guide',
      PROMPT_GUIDE_JSON_SCHEMA,
      (content) => parsePromptGuideContent(content, team),
    );
    return result;
  }

  /** Rewrites only the user's draft. It may use the dedicated Prompt Guide connection or the configured Direct API fallback. */
  /** The Prompt Guide connection when it is ready, otherwise the Direct API one; a reason when neither is. */
  async pickConnection(): Promise<{ connection: AppSettings['promptGuide'] | AppSettings['directApi'] } | { reason: string }> {
    const settings = await this.ports.settings();
    const guideReadiness = await this.connectionReadiness(settings.promptGuide, 'Prompt Guide');
    if (guideReadiness.ready) return { connection: settings.promptGuide };
    const directReadiness = await this.connectionReadiness(settings.directApi, 'Direct API');
    if (directReadiness.ready) return { connection: settings.directApi };
    return { reason: guideReadiness.reason ?? directReadiness.reason ?? 'Configure Prompt Guide or Direct API in Settings first.' };
  }

  async refinePrompt(input: PromptRefineInput): Promise<PromptRefineResult> {
    const picked = await this.pickConnection();
    if (!('connection' in picked)) throw new Error(picked.reason);
    const connection = picked.connection;
    return this.ports.requester.structuredRequest(
      connection,
      { feature: 'Prompt refinement', card: 'Prompt refinement' },
      buildPromptRefinementPrompt(input),
      'kai_prompt_refinement',
      PROMPT_REFINEMENT_JSON_SCHEMA,
      parsePromptRefinementContent,
    );
  }
}

/** Rewrites a rough draft without changing what the user asked for. */
export function buildPromptRefinementPrompt(input: PromptRefineInput): { system: string; user: string } {
  const intent = {
    ask: 'Make the request specific and answerable. Preserve whether the user wants an explanation, advice, diagnosis, or an answer.',
    plan: 'Make it ask for a concrete plan, affected areas, risks, and verification. Do not turn it into an instruction to edit files.',
    build: 'Make the desired change explicit, preserve every constraint, and state what should be verified when the work is complete. Do not add scope, technologies, or requirements.',
    review: 'Make the review target and concerns explicit: correctness, security, architecture, regressions, and missing tests where relevant. Do not ask for edits unless the draft does.',
    learn: 'Make it ask for a clear explanation or teaching response, preserving the topic, desired depth, and any learner context.',
  }[input.intent];
  const system = [
    'You are the prompt editor inside KAI, a desktop coding workbench.',
    'Rewrite the user draft into a clear, self-contained prompt for a coding agent.',
    intent,
    'Preserve the user meaning, facts, names, paths, constraints, requested outcome, and level of detail. Do not add requirements or invent decisions.',
    'Do not answer the request, perform the work, or turn the prompt into a plan unless the requested mode explicitly asks for a plan.',
    'Keep the user language and tone. If the draft is already clear, make only the smallest useful edits. Return only JSON matching the schema, with no markdown fences.',
  ].join('\n');
  return { system, user: `Draft:\n${input.text}` };
}

export function parsePromptRefinementContent(content: string): PromptRefineResult {
  const raw = parseJsonResponse(content, 'Prompt refinement');
  const parsed = promptRefineResultSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new Error(`The prompt refinement reply did not match the expected shape (${issue ? `${issue.path.join('.') || 'reply'}: ${issue.message}` : 'unknown error'}).`);
}

export function buildPromptGuidePrompt(input: PromptGuideInput, team: Pick<AgentTeam, 'custom'>, context: string | null): { system: string; user: string } {
  const builtIn = WORKER_ROLES.map((role) => `- "${role}": ${TEAM_ROLE_INFO[role].label}. ${TEAM_ROLE_INFO[role].description}`);
  const custom = (team.custom ?? []).map((role) => `- "${role.id}": ${role.label} (${role.access === 'read' ? 'read-only' : 'edits files'}). ${role.description}`.trim());
  const answered = input.answers.filter((item) => item.answer.trim());
  const system = [
    'You are the Prompt Guide inside KAI, a desktop workbench where a team of coding agents builds software.',
    'The user has an idea that may be vague. Your job is to make it clear enough that each agent can do its part without guessing.',
    'Return only JSON matching the schema, with no markdown fences.',
    '',
    'Write:',
    '- "goal": the idea restated as one clear, specific goal (what is built, for whom, and what "done" looks like).',
    '- "assumptions": decisions you made where the idea was silent. Keep each short and concrete.',
    '- "questions": up to five questions only the user can answer, most important first. Ask none if the idea is already clear.',
    '- "prompts": one prompt per teammate who has real work, using only the role ids listed below. Each prompt must stand on its own: say what to build or check, which files or folders it covers (name real ones from the project snapshot when you can), what the finished result looks like, and what to leave to other roles.',
    'Use as few prompts as the work needs. Add a "tests" prompt when code changes. Reviews are added automatically, so only write a reviewer prompt when the user asked for a specific review.',
    'Never invent files that the snapshot shows do not exist; say "a new file under <folder>" instead.',
    '',
    'Role ids you can use:',
    ...builtIn,
    ...custom,
  ].join('\n');
  const user = [
    `Idea:\n${input.idea}`,
    answered.length > 0 ? `The user answered your earlier questions:\n${answered.map((item) => `Q: ${item.question}\nA: ${item.answer}`).join('\n\n')}` : '',
    context ? `Project snapshot (read-only; for naming real files and folders):\n${context}` : 'No project snapshot is available.',
  ].filter(Boolean).join('\n\n');
  return { system, user };
}

/** Reads the guide's reply, dropping any prompt for a role the team does not have instead of failing the whole reply. */
export function parsePromptGuideContent(content: string, team: Pick<AgentTeam, 'custom'>): PromptGuideResult {
  const raw = parseJsonResponse(content, 'Prompt Guide') as { prompts?: Array<{ role?: unknown }> } & Record<string, unknown>;
  const known = (role: unknown): boolean => typeof role === 'string' && ((isBuiltInRole(role) && role !== 'orchestrator') || (team.custom ?? []).some((item) => item.id === role));
  const prompts = Array.isArray(raw.prompts) ? raw.prompts.filter((item) => known(item?.role)).slice(0, 10) : [];
  const parsed = promptGuideResultSchema.safeParse({
    ...raw,
    assumptions: Array.isArray(raw.assumptions) ? raw.assumptions.slice(0, 8) : [],
    questions: Array.isArray(raw.questions) ? raw.questions.slice(0, 5) : [],
    prompts,
  });
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new Error(`The Prompt Guide reply did not match the expected shape (${issue ? `${issue.path.join('.') || 'reply'}: ${issue.message}` : 'unknown error'}).`);
}
