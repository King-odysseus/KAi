import {
  TEAM_ROLE_INFO,
  directProviderPreset,
  isBuiltInRole,
  isLocalProvider,
  promptGuideResultSchema,
  type AgentTeam,
  type AppSettings,
  type PromptGuideInput,
  type PromptGuideReadiness,
  type PromptGuideResult,
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

/**
 * Helps the user say what they want before a team runs: it restates the idea as one clear goal, lists what it had to
 * assume and what it still needs to know, and writes a self-contained prompt for each teammate. It reads the project
 * but never changes it, and it runs on its own provider connection from Settings.
 */
export class DesktopPromptGuide {
  constructor(private readonly ports: PromptGuidePorts) {}

  async readiness(): Promise<PromptGuideReadiness> {
    const guide = (await this.ports.settings()).promptGuide;
    const displayName = directProviderPreset(guide.provider).displayName;
    const local = isLocalProvider(guide.provider);
    let reason: string | null = null;
    if (!guide.enabled) reason = 'The Prompt Guide is off. Turn it on and add its API key under Settings, Prompt Guide.';
    else if (!guide.model.trim()) reason = 'Choose a Prompt Guide model under Settings, Prompt Guide.';
    else if (!local && !this.ports.vaultAvailable()) reason = 'The OS credential vault is unavailable, so the Prompt Guide cannot read its key.';
    else if (!local && !(await this.ports.credentialStored(guide.credentialId))) reason = `Save the ${guide.credentialId} key under Settings, Prompt Guide.`;
    return { ready: reason === null, displayName, model: guide.model, reason };
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
