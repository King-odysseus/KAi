import { z } from 'zod';

export const updateStatusSchema = z.enum(['disabled', 'idle', 'checking', 'available', 'none', 'downloading', 'ready', 'error']);

export const updateStateSchema = z
  .object({
    status: updateStatusSchema,
    currentVersion: z.string().min(1),
    // The newer version, once one has been found.
    version: z.string().nullable(),
    // Plain-text release notes.
    notes: z.string().nullable(),
    percent: z.number().min(0).max(100).nullable(),
    message: z.string().nullable(),
    checkedAt: z.string().nullable(),
    // Name of the config backup made just before installing, so it can be restored afterwards.
    backupName: z.string().nullable(),
  })
  .strict();

export const updateSettingsSchema = z.object({ autoCheck: z.boolean().default(true) }).strict();

export type UpdateState = z.infer<typeof updateStateSchema>;
export type UpdateSettings = z.infer<typeof updateSettingsSchema>;

/** Release notes arrive as a string (often HTML) or a list of per-version notes; show them as plain text. */
export function normalizeReleaseNotes(notes: unknown): string | null {
  const raw = typeof notes === 'string'
    ? notes
    : Array.isArray(notes)
      ? notes.map((item) => (item && typeof item === 'object' ? `${(item as { version?: string }).version ?? ''}\n${(item as { note?: string | null }).note ?? ''}` : String(item))).join('\n\n')
      : '';
  const text = raw
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h[1-6]|div)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text ? text.slice(0, 6_000) : null;
}
