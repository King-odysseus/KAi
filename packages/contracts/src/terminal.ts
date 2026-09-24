import { z } from 'zod';

export const terminalShellSchema = z.enum(['default', 'powershell', 'gitbash']);

export const terminalStartInputSchema = z
  .object({
    projectId: z.string().min(1),
    shell: terminalShellSchema,
    cols: z.number().int().min(20).max(500).default(120),
    rows: z.number().int().min(5).max(200).default(30),
  })
  .strict();

export const terminalWriteInputSchema = z
  .object({
    id: z.string().min(1),
    data: z.string().max(100_000),
  })
  .strict();

export const terminalResizeInputSchema = z
  .object({
    id: z.string().min(1),
    cols: z.number().int().min(20).max(500),
    rows: z.number().int().min(5).max(200),
  })
  .strict();

export const terminalStopInputSchema = z.object({ id: z.string().min(1) }).strict();

export const terminalEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('output'), id: z.string().min(1), data: z.string() }).strict(),
  z.object({ kind: z.literal('exit'), id: z.string().min(1), code: z.number().int().nullable(), signal: z.string().nullable() }).strict(),
]);

export const terminalSessionSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    shell: terminalShellSchema,
    cwd: z.string().min(1),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  })
  .strict();

export type TerminalShell = z.infer<typeof terminalShellSchema>;
export type TerminalEvent = z.infer<typeof terminalEventSchema>;
export type TerminalSession = z.infer<typeof terminalSessionSchema>;
export type TerminalStartInput = z.infer<typeof terminalStartInputSchema>;
export type TerminalWriteInput = z.infer<typeof terminalWriteInputSchema>;
export type TerminalResizeInput = z.infer<typeof terminalResizeInputSchema>;
