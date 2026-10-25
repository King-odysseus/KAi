import { z } from 'zod';

export const playwrightViewportStatusSchema = z.object({
  status: z.enum(['ok', 'needs-reset', 'unavailable']),
  viewportWidth: z.number().nonnegative().nullable(),
  windowWidth: z.number().nonnegative().nullable(),
  screenWidth: z.number().nonnegative().nullable(),
  message: z.string().optional(),
}).strict();

export type PlaywrightViewportStatus = z.infer<typeof playwrightViewportStatusSchema>;
