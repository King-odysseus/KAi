import { z } from 'zod';

/**
 * One ready-made connector. The catalog ships with KAI; installing one only adds a disabled MCP server entry to
 * settings. Nothing is downloaded, run or enabled until the person reviews it and saves the MCP card.
 */
export const connectorCatalogEntrySchema = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(200),
    description: z.string().max(1_000),
    risk: z.enum(['low', 'medium', 'high']),
    /** Environment variables the server needs, and the vault credential that fills each one. */
    credentials: z
      .array(
        z
          .object({
            env: z.string().min(1).max(200),
            credentialId: z.string().min(1).max(200),
            label: z.string().min(1).max(200),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type ConnectorCatalogEntry = z.infer<typeof connectorCatalogEntrySchema>;

export const connectorInstallInputSchema = z.object({ id: z.string().min(1).max(100) }).strict();
