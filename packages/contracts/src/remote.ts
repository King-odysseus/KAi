import { z } from 'zod';

/**
 * Settings for KAI Remote, the phone-sized console the desktop serves over the local network. Off by
 * default: turning it on opens a port whose requests reach the same handlers the desktop UI uses.
 */
export const remoteAccessSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Loopback-only unless the user opts in. The server never binds 0.0.0.0, even with this on. */
    lanEnabled: z.boolean().default(false),
    port: z.number().int().min(1024).max(65_535).default(8790),
  })
  .strict();
export type RemoteAccessSettings = z.infer<typeof remoteAccessSettingsSchema>;

export function createDefaultRemoteAccess(): RemoteAccessSettings {
  return remoteAccessSettingsSchema.parse({});
}

/** How the gateway is doing right now, for the Settings panel and the `remote:status` channel. */
export const remoteAccessStatusSchema = z
  .object({
    enabled: z.boolean(),
    running: z.boolean(),
    lanEnabled: z.boolean(),
    port: z.number().int().nullable(),
    /** The addresses a phone on this network can reach, loopback first. */
    urls: z.array(z.string()),
    /**
     * The address a phone on this network would type, whether or not LAN mode is on. Reported even
     * with the gateway stopped, because "what do I put in the phone?" comes before both switches.
     */
    lanUrl: z.string().nullable(),
    /** Whether a token is stored. The token itself never leaves the main process through this channel. */
    tokenSet: z.boolean(),
    /** How many phones are attached, so an idle gateway is visibly idle rather than merely on. */
    connectedClients: z.number().int().nonnegative(),
    /** Why it is enabled but not listening — a taken port, no LAN address to bind. Null when fine. */
    lastError: z.string().nullable(),
  })
  .strict();
export type RemoteAccessStatus = z.infer<typeof remoteAccessStatusSchema>;

/** One desktop window a phone can target. The id is sent back on every window-scoped remote request. */
export const remoteWindowSummarySchema = z
  .object({
    id: z.number().int(),
    projectId: z.string().nullable(),
    projectName: z.string().nullable(),
    conversationId: z.string().nullable(),
    view: z.string(),
    focused: z.boolean(),
  })
  .strict();
export type RemoteWindowSummary = z.infer<typeof remoteWindowSummarySchema>;

/**
 * The pushes that travel to the phone, as names the live stream sends and the client subscribes to.
 * Default-deny like the request allowlist: the renderer's own channels — terminal output, editor
 * saves, proxy tails — stay on this machine. These five are what a remote console needs.
 */
export const REMOTE_PUSH_CHANNELS = [
  'agents:event',
  'app:shared-state',
  'workflows:changed',
  'studio:board-changed',
  'app:update-state',
] as const;
export type RemotePushChannel = (typeof REMOTE_PUSH_CHANNELS)[number];

/** What the desktop is told after pairing a device. The new token is returned to this path only. */
export const remoteTokenResultSchema = z
  .object({
    token: z.string().min(1),
    urls: z.array(z.string()),
  })
  .strict();
export type RemoteTokenResult = z.infer<typeof remoteTokenResultSchema>;

/** What the desktop is told to pair a device as. A label is the only thing the user has to supply. */
export const remotePairDeviceInputSchema = z.object({ label: z.string().max(60) }).strict();
export type RemotePairDeviceInput = z.infer<typeof remotePairDeviceInputSchema>;

/**
 * The phone's read of the C1 brain's task board. A channel of its own rather than a call to
 * `cognitive1:operation`, because that door is generic — it also carries task-complete, brain-prune and
 * the rest. This one asks a single question, with the arguments fixed in the handler, and cannot ask
 * another. `project` narrows it; absent means every project. Nothing here names a card to change.
 */
export const remoteTasksInputSchema = z.object({ project: z.string().min(1).optional() }).strict();
export type RemoteTasksInput = z.infer<typeof remoteTasksInputSchema>;

/** A paired device as a list may show it. The token is deliberately absent: a list hands out no secrets. */
export const remoteDeviceSchema = z
  .object({
    id: z.string().min(1),
    label: z.string(),
    createdAt: z.string().min(1),
  })
  .strict();
export type RemoteDeviceSummary = z.infer<typeof remoteDeviceSchema>;
