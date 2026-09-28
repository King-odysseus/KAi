import { z } from 'zod';
import { providerIdSchema } from './primitives';
import { resolveRole, teamPartRoleSchema, teamPartSchema, type TeamLike, type TeamPart } from './team';

/**
 * The Prompt Guide turns a rough idea into a clear goal and one prompt per teammate before any agent runs. It has
 * its own provider connection, so it can use a small, cheap model and never spends a CLI account's limits.
 */
export const promptGuideSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    provider: providerIdSchema.default('openai'),
    model: z.string().default('gpt-6-luna'),
    baseUrl: z.string().url().default('https://api.openai.com/v1'),
    credentialId: z.string().min(1).default('provider.openai'),
  })
  .strict();
export type PromptGuideSettings = z.infer<typeof promptGuideSettingsSchema>;

export function createDefaultPromptGuide(): PromptGuideSettings {
  return promptGuideSettingsSchema.parse({});
}

export const promptGuideInputSchema = z
  .object({
    projectId: z.string().min(1),
    idea: z.string().trim().min(1).max(4_000),
    // Answers to the questions of an earlier round, so the next round can settle them.
    answers: z
      .array(z.object({ question: z.string().max(500), answer: z.string().trim().max(1_000) }).strict())
      .max(8)
      .default([]),
  })
  .strict();
export type PromptGuideInput = z.infer<typeof promptGuideInputSchema>;

export const promptGuidePromptSchema = z
  .object({
    role: teamPartRoleSchema,
    title: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(1).max(6_000),
    // Folders or files the prompt is about, when the guide could tell.
    paths: z.array(z.string().min(1).max(300)).max(20).default([]),
  })
  .strict();
export type PromptGuidePrompt = z.infer<typeof promptGuidePromptSchema>;

export const promptGuideResultSchema = z
  .object({
    // The idea restated as one clear goal a team can act on.
    goal: z.string().trim().min(1).max(4_000),
    // What the guide assumed where the idea was silent; the user can correct any of them.
    assumptions: z.array(z.string().trim().min(1).max(400)).max(8).default([]),
    // What still needs the user's decision; answering them and refining again settles them.
    questions: z.array(z.string().trim().min(1).max(400)).max(5).default([]),
    prompts: z.array(promptGuidePromptSchema).min(1).max(10),
  })
  .strict();
export type PromptGuideResult = z.infer<typeof promptGuideResultSchema>;

export const promptRefineInputSchema = z
  .object({
    text: z.string().trim().min(1).max(8_000),
    intent: z.enum(['ask', 'plan', 'build', 'review', 'learn']).default('ask'),
  })
  .strict();
export type PromptRefineInput = z.infer<typeof promptRefineInputSchema>;

export const promptRefineResultSchema = z
  .object({
    prompt: z.string().trim().min(1).max(8_000),
  })
  .strict();
export type PromptRefineResult = z.infer<typeof promptRefineResultSchema>;

export interface PromptGuideReadiness {
  ready: boolean;
  displayName: string;
  model: string;
  reason: string | null;
}

/** A plan built straight from the guide's prompts, skipping the orchestrator. */
export const teamPlanFromPartsInputSchema = z
  .object({
    projectId: z.string().min(1),
    goal: z.string().trim().min(1).max(4_000),
    parts: z.array(teamPartSchema).min(1).max(10),
  })
  .strict();
export type TeamPlanFromPartsInput = z.infer<typeof teamPlanFromPartsInputSchema>;

/**
 * The Prompt Guide's prompts as plan parts: each gets an id from its title, and a test part waits for every part that
 * edits files, so tests run against the finished code.
 */
export function partsFromGuide(prompts: readonly PromptGuidePrompt[], team: TeamLike): TeamPart[] {
  const used = new Set<string>();
  const parts = prompts.map((item, index): TeamPart => {
    const base = item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || `part-${index + 1}`;
    let id = base;
    for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
    used.add(id);
    return { id, title: item.title.trim(), role: item.role, prompt: item.prompt.trim(), dependsOn: [], paths: item.paths };
  });
  const editors = parts.filter((part) => part.role !== 'tests' && resolveRole(team, part.role).access === 'edit').map((part) => part.id);
  return parts.map((part) => (part.role === 'tests' ? { ...part, dependsOn: editors } : part));
}
