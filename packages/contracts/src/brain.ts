import { z } from 'zod';

export const brainEntryTypeSchema = z.enum(['bugs', 'decisions', 'gotchas', 'patterns']);
export const brainSearchModeSchema = z.enum(['lexical', 'semantic']);
export const brainPresenceSchema = z.enum(['active', 'idle', 'offline']);
export const brainHungerLevelSchema = z.enum(['satisfied', 'peckish', 'hungry', 'starving']);

export const brainEntrySchema = z
  .object({
    date: z.string().min(1),
    title: z.string().min(1),
    agent: z.string(),
    type: brainEntryTypeSchema,
    tags: z.string(),
    project: z.string(),
    fields: z.record(z.string()),
    status: z.string().nullable(),
  })
  .strict();

export const brainOverviewSchema = z
  .object({
    totalEntries: z.number().int().nonnegative(),
    typeCounts: z.record(brainEntryTypeSchema, z.number().int().nonnegative()),
    activeAgents: z.number().int().nonnegative(),
    projectCount: z.number().int().nonnegative(),
    hunger: z
      .object({
        daysSinceLearn: z.number().int().nonnegative(),
        level: brainHungerLevelSchema,
        lastEntryDate: z.string().nullable(),
      })
      .strict(),
    recentEntries: z.array(brainEntrySchema),
    quality: z
      .object({
        totalEntries: z.number().int().nonnegative(),
        noiseScore: z.number().int().min(0).max(100),
        signalRatio: z.number().int().min(0).max(100),
        duplicateCount: z.number().int().nonnegative(),
        untaggedTotal: z.number().int().nonnegative(),
        deadWeightCount: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const brainSearchInputSchema = z
  .object({
    query: z.string().trim().max(500).optional().default(''),
    tag: z.string().trim().max(100).optional().default(''),
    type: brainEntryTypeSchema.optional(),
    project: z.string().trim().max(200).optional().default(''),
    global: z.boolean().optional().default(false),
    mode: brainSearchModeSchema.optional().default('lexical'),
    maxResults: z.number().int().min(1).max(100).optional().default(25),
  })
  .strict();

export const brainFieldUpdateInputSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    field: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z][A-Za-z0-9 _-]*$/),
    value: z.string().max(20_000),
  })
  .strict();

export const brainFieldUpdateResultSchema = z
  .object({
    title: z.string().min(1),
    field: z.string().min(1),
    value: z.string(),
  })
  .strict();

export type BrainEntry = z.infer<typeof brainEntrySchema>;
export type BrainEntryType = z.infer<typeof brainEntryTypeSchema>;
export type BrainHungerLevel = z.infer<typeof brainHungerLevelSchema>;
export type BrainOverview = z.infer<typeof brainOverviewSchema>;
export type BrainSearchInput = z.input<typeof brainSearchInputSchema>;
export type BrainSearchQuery = z.output<typeof brainSearchInputSchema>;
export type BrainFieldUpdateInput = z.input<typeof brainFieldUpdateInputSchema>;
export type BrainFieldUpdate = z.output<typeof brainFieldUpdateInputSchema>;
export type BrainFieldUpdateResult = z.infer<typeof brainFieldUpdateResultSchema>;
