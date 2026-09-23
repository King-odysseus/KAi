import { z } from 'zod';

export const terminalShellSchema = z.enum(['default', 'powershell', 'gitbash']);

export const terminalRunInputSchema = z
  .object({
    projectId: z.string().min(1),
    command: z.string().trim().min(1).max(4_000),
    shell: terminalShellSchema,
  })
  .strict();

export const terminalRunResultSchema = z.object({ id: z.string().min(1) }).strict();

export const terminalStopInputSchema = z.object({ id: z.string().min(1) }).strict();

export const terminalEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('output'), id: z.string().min(1), stream: z.enum(['stdout', 'stderr']), text: z.string() }).strict(),
  z.object({ kind: z.literal('exit'), id: z.string().min(1), code: z.number().int().nullable(), signal: z.string().nullable() }).strict(),
]);

export type TerminalShell = z.infer<typeof terminalShellSchema>;
export type TerminalEvent = z.infer<typeof terminalEventSchema>;
export type TerminalRunResult = z.infer<typeof terminalRunResultSchema>;
