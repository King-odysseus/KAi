import { z } from 'zod';

export const notificationSettingsSchema = z
  .object({
    // Closing the window hides it to the system tray instead of quitting. Off by default.
    trayEnabled: z.boolean().default(false),
    onComplete: z.boolean().default(true),
    onFailure: z.boolean().default(true),
    onApproval: z.boolean().default(true),
    onBudget: z.boolean().default(true),
  })
  .strict();

export const notificationKindSchema = z.enum(['complete', 'failure', 'approval', 'budget']);

export const viewReportSchema = z
  .object({
    view: z.string().min(1).max(32),
    conversationId: z.string().min(1).nullable(),
  })
  .strict();

// `projectId`, when given, is the project the conversation belongs to, so the window can switch to it first.
export const openConversationEventSchema = z.object({ conversationId: z.string().min(1), projectId: z.string().min(1).optional() }).strict();

export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;
export type NotificationKind = z.infer<typeof notificationKindSchema>;
export type ViewReport = z.infer<typeof viewReportSchema>;
export type OpenConversationEvent = z.infer<typeof openConversationEventSchema>;

export const defaultNotificationSettings: NotificationSettings = {
  trayEnabled: false,
  onComplete: true,
  onFailure: true,
  onApproval: true,
  onBudget: true,
};
