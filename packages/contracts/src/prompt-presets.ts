import { z } from 'zod';

/**
 * A reusable prompt the person saved into a numbered slot, the way Codex's `/presets` does. Slots are small in
 * number on purpose — this is a short list of prompts worth reaching for by number, not a prompt library.
 */
export const promptPresetSchema = z
  .object({
    slot: z.number().int().min(1).max(9),
    label: z.string().trim().min(1).max(60),
    text: z.string().min(1).max(20_000),
  })
  .strict();

export const promptPresetListSchema = z.array(promptPresetSchema).max(9);
export const promptPresetStoreSchema = z.object({ version: z.literal(1), presets: promptPresetListSchema }).strict();

export const promptPresetSaveInputSchema = z
  .object({ slot: z.number().int().min(1).max(9), label: z.string().trim().min(1).max(60), text: z.string().min(1).max(20_000) })
  .strict();
export const promptPresetDeleteInputSchema = z.object({ slot: z.number().int().min(1).max(9) }).strict();

export type PromptPreset = z.infer<typeof promptPresetSchema>;
export type PromptPresetList = z.infer<typeof promptPresetListSchema>;
