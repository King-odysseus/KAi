import { z } from 'zod';
import {
  agentCapabilitySchema,
  agentApprovalResponseInputSchema,
  agentCancelInputSchema,
  agentRunRequestSchema,
  agentRunResultSchema,
  agentSignInInputSchema,
  agentSignInResultSchema,
  directApiCapabilitySchema,
  type AgentCapability,
  type AgentApprovalResponseInput,
  type AgentRunEvent,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentSignInResult,
  type DirectApiCapability,
} from './agents';
import {
  brainFieldUpdateInputSchema,
  brainFieldUpdateResultSchema,
  brainOverviewSchema,
  brainSearchInputSchema,
  type BrainFieldUpdateInput,
  type BrainFieldUpdateResult,
  type BrainOverview,
  type BrainSearchInput,
} from './brain';
import {
  contextPreviewInputSchema,
  contextPreviewSchema,
  type ContextPreview,
  type ContextPreviewInput,
} from './context';
import {
  cognitive1ServiceSettingsSchema,
  conversationRecordV1Schema,
  mcpServerSettingsSchema,
  type AppSettings,
  type ConversationRecord,
  type ProjectPreferences,
  type ProjectRecord,
  projectPreferencesV1Schema,
  projectRecordV1Schema,
  proxyServiceSettingsSchema,
} from './domain';
import {
  agentIdSchema,
  autonomyModeSchema,
  providerIdSchema,
  routeModeSchema,
  themeModeSchema,
  serviceKindSchema,
  serviceStateSchema,
  type LogEntry,
  type ServiceState,
} from './primitives';
import {
  proxyHistoryClearResultSchema,
  proxyHistoryDetailSchema,
  proxyHistoryQuerySchema,
  proxyHistorySummarySchema,
  proxyOverviewSchema,
  type ProxyHistoryDetail,
  type ProxyHistoryQuery,
  type ProxyHistorySummary,
  type ProxyOverview,
} from './proxy';

export const ipcChannels = [
  'app:get-bootstrap',
  'projects:choose',
  'projects:open',
  'projects:remove',
  'settings:get',
  'settings:update',
  'services:status',
  'services:start',
  'services:stop',
  'services:restart',
  'services:rotate-token',
  'services:copy-token',
  'brain:overview',
  'brain:search',
  'brain:update-field',
  'proxy:overview',
  'proxy:history',
  'proxy:history-detail',
  'proxy:clear-history',
  'preferences:get',
  'preferences:update',
  'credentials:status',
  'credentials:set',
  'credentials:clear',
  'conversations:list',
  'conversations:get',
  'conversations:create',
  'conversations:save',
  'conversations:delete',
  'agents:capabilities',
  'agents:run',
  'agents:cancel',
  'agents:sign-in',
  'agents:approval-response',
  'agents:api-capability',
  'context:preview',
  'diagnostics:data-locations',
  'diagnostics:recent-logs',
  'window:state',
] as const;

export type IpcChannel = (typeof ipcChannels)[number];

const emptyInputSchema = z.object({}).strict();

export const ipcInputSchemas = {
  'app:get-bootstrap': emptyInputSchema,
  'projects:choose': emptyInputSchema,
  'projects:open': z.object({ id: z.string().min(1) }).strict(),
  'projects:remove': z.object({ id: z.string().min(1) }).strict(),
  'settings:get': emptyInputSchema,
  'settings:update': z
    .object({
      defaultAgent: agentIdSchema.optional(),
      defaultRoute: routeModeSchema.optional(),
      defaultAutonomy: autonomyModeSchema.optional(),
      theme: themeModeSchema.optional(),
      logRetentionEntries: z.number().int().min(100).max(100_000).optional(),
      diagnosticsEnabled: z.boolean().optional(),
      mcpServers: z.array(mcpServerSettingsSchema).optional(),
      directApi: z
        .object({
          enabled: z.boolean().optional(),
          provider: providerIdSchema.optional(),
          model: z.string().optional(),
          baseUrl: z.string().url().optional(),
          credentialId: z.string().min(1).optional(),
        })
        .strict()
        .optional(),
      cognitive1: cognitive1ServiceSettingsSchema.partial().strict().optional(),
      proxy: proxyServiceSettingsSchema.partial().strict().optional(),
    })
    .strict(),
  'services:status': emptyInputSchema,
  'services:start': z.object({ kind: serviceKindSchema }).strict(),
  'services:stop': z.object({ kind: serviceKindSchema }).strict(),
  'services:restart': z.object({ kind: serviceKindSchema }).strict(),
  'services:rotate-token': z.object({ kind: serviceKindSchema }).strict(),
  'services:copy-token': z.object({ kind: serviceKindSchema }).strict(),
  'brain:overview': emptyInputSchema,
  'brain:search': brainSearchInputSchema,
  'brain:update-field': brainFieldUpdateInputSchema,
  'proxy:overview': emptyInputSchema,
  'proxy:history': proxyHistoryQuerySchema,
  'proxy:history-detail': z.object({ id: z.string().min(1) }).strict(),
  'proxy:clear-history': emptyInputSchema,
  'preferences:get': z.object({ projectId: z.string().min(1) }).strict(),
  'preferences:update': projectPreferencesV1Schema,
  'credentials:status': emptyInputSchema,
  'credentials:set': z.object({ id: z.string().min(1), value: z.string().min(1) }).strict(),
  'credentials:clear': z.object({ id: z.string().min(1) }).strict(),
  'conversations:list': emptyInputSchema,
  'conversations:get': z.object({ id: z.string().min(1) }).strict(),
  'conversations:create': z.object({ projectId: z.string().nullable(), firstPrompt: z.string().max(20_000) }).strict(),
  'conversations:save': conversationRecordV1Schema,
  'conversations:delete': z.object({ id: z.string().min(1) }).strict(),
  'agents:capabilities': emptyInputSchema,
  'agents:run': agentRunRequestSchema,
  'agents:cancel': agentCancelInputSchema,
  'agents:sign-in': agentSignInInputSchema,
  'agents:approval-response': agentApprovalResponseInputSchema,
  'agents:api-capability': emptyInputSchema,
  'context:preview': contextPreviewInputSchema,
  'diagnostics:data-locations': emptyInputSchema,
  'diagnostics:recent-logs': z.object({ count: z.number().int().min(1).max(1000).optional() }).strict(),
  'window:state': emptyInputSchema,
} satisfies Record<IpcChannel, z.ZodTypeAny>;

export interface IpcSuccess<T> {
  ok: true;
  data: T;
}

export interface IpcFailure {
  ok: false;
  error: {
    code: 'INVALID_REQUEST' | 'NOT_FOUND' | 'CONFLICT' | 'UNAVAILABLE' | 'INTERNAL';
    message: string;
  };
}

export type IpcResponse<T> = IpcSuccess<T> | IpcFailure;

export const projectSummarySchema = projectRecordV1Schema;
export const serviceStatesSchema = z.array(serviceStateSchema);
export const brainOverviewResponseSchema = brainOverviewSchema;
export const brainSearchResponseSchema = z.array(brainOverviewSchema.shape.recentEntries.element);
export const brainFieldUpdateResponseSchema = brainFieldUpdateResultSchema;
export const proxyOverviewResponseSchema = proxyOverviewSchema;
export const proxyHistoryResponseSchema = z.array(proxyHistorySummarySchema);
export const proxyHistoryDetailResponseSchema = proxyHistoryDetailSchema;
export const proxyHistoryClearResponseSchema = proxyHistoryClearResultSchema;
export const agentCapabilitiesResponseSchema = z.array(agentCapabilitySchema);
export const agentRunResponseSchema = agentRunResultSchema;
export const agentCancelResponseSchema = z.boolean();
export const agentSignInResponseSchema = agentSignInResultSchema;
export const directApiCapabilityResponseSchema = directApiCapabilitySchema;
export const contextPreviewResponseSchema = contextPreviewSchema;

export function parseIpcInput<TChannel extends IpcChannel>(
  channel: TChannel,
  input: unknown,
): z.infer<(typeof ipcInputSchemas)[TChannel]> {
  return ipcInputSchemas[channel].parse(input) as z.infer<(typeof ipcInputSchemas)[TChannel]>;
}

export type IpcInput<TChannel extends IpcChannel> = z.infer<(typeof ipcInputSchemas)[TChannel]>;

export interface DataLocation {
  label: string;
  path: string;
  kind: 'settings' | 'conversations' | 'logs' | 'credentials' | 'runtime';
}

export interface BootstrapPayload {
  appName: string;
  version: string;
  platform: string;
  projects: ProjectRecord[];
  activeProjectId: string | null;
  settings: AppSettings;
  services: ServiceState[];
  dataLocations: DataLocation[];
}

export interface SettingsUpdate {
  defaultAgent?: AppSettings['defaultAgent'];
  defaultRoute?: AppSettings['defaultRoute'];
  defaultAutonomy?: AppSettings['defaultAutonomy'];
  theme?: AppSettings['theme'];
  logRetentionEntries?: number;
  diagnosticsEnabled?: boolean;
  mcpServers?: AppSettings['mcpServers'];
  directApi?: Partial<AppSettings['directApi']>;
  cognitive1?: Partial<AppSettings['cognitive1']>;
  proxy?: Partial<AppSettings['proxy']>;
}

export interface CredentialStatus {
  available: boolean;
  ids: string[];
}

export interface ServiceTokenCopyResult {
  copied: true;
  kind: ServiceState['kind'];
  endpoint: string;
  header: 'Authorization';
  scheme: 'Bearer';
}

export interface KaiDesktopBridge {
  bootstrap(): Promise<IpcResponse<BootstrapPayload>>;
  chooseProject(): Promise<IpcResponse<ProjectRecord | null>>;
  openProject(id: string): Promise<IpcResponse<BootstrapPayload>>;
  removeProject(id: string): Promise<IpcResponse<BootstrapPayload>>;
  getSettings(): Promise<IpcResponse<AppSettings>>;
  updateSettings(update: SettingsUpdate): Promise<IpcResponse<AppSettings>>;
  serviceStatus(): Promise<IpcResponse<ServiceState[]>>;
  startService(kind: ServiceState['kind']): Promise<IpcResponse<ServiceState[]>>;
  stopService(kind: ServiceState['kind']): Promise<IpcResponse<ServiceState[]>>;
  restartService(kind: ServiceState['kind']): Promise<IpcResponse<ServiceState[]>>;
  rotateServiceToken(kind: ServiceState['kind']): Promise<IpcResponse<ServiceState[]>>;
  copyServiceToken(kind: ServiceState['kind']): Promise<IpcResponse<ServiceTokenCopyResult>>;
  brainOverview(): Promise<IpcResponse<BrainOverview>>;
  searchBrain(request: BrainSearchInput): Promise<IpcResponse<BrainOverview['recentEntries']>>;
  updateBrainField(request: BrainFieldUpdateInput): Promise<IpcResponse<BrainFieldUpdateResult>>;
  proxyOverview(): Promise<IpcResponse<ProxyOverview>>;
  proxyHistory(request?: ProxyHistoryQuery): Promise<IpcResponse<ProxyHistorySummary[]>>;
  proxyHistoryDetail(id: string): Promise<IpcResponse<ProxyHistoryDetail>>;
  clearProxyHistory(): Promise<IpcResponse<{ cleared: number }>>;
  getPreferences(projectId: string): Promise<IpcResponse<ProjectPreferences | null>>;
  updatePreferences(preferences: ProjectPreferences): Promise<IpcResponse<ProjectPreferences>>;
  credentialStatus(): Promise<IpcResponse<CredentialStatus>>;
  setCredential(id: string, value: string): Promise<IpcResponse<CredentialStatus>>;
  clearCredential(id: string): Promise<IpcResponse<CredentialStatus>>;
  listConversations(): Promise<IpcResponse<ConversationRecord[]>>;
  getConversation(id: string): Promise<IpcResponse<ConversationRecord | null>>;
  createConversation(projectId: string | null, firstPrompt: string): Promise<IpcResponse<ConversationRecord>>;
  saveConversation(conversation: ConversationRecord): Promise<IpcResponse<ConversationRecord>>;
  deleteConversation(id: string): Promise<IpcResponse<void>>;
  agentCapabilities(): Promise<IpcResponse<AgentCapability[]>>;
  directApiCapability(): Promise<IpcResponse<DirectApiCapability>>;
  previewContext(request: ContextPreviewInput): Promise<IpcResponse<ContextPreview>>;
  runAgent(request: AgentRunRequest): Promise<IpcResponse<AgentRunResult>>;
  cancelAgent(conversationId: string): Promise<IpcResponse<boolean>>;
  signInAgent(agent: AgentRunRequest['agent']): Promise<IpcResponse<AgentSignInResult>>;
  respondToApproval(request: AgentApprovalResponseInput): Promise<IpcResponse<boolean>>;
  onAgentEvent(listener: (payload: AgentRunEvent) => void): () => void;
  dataLocations(): Promise<IpcResponse<DataLocation[]>>;
  recentLogs(count?: number): Promise<IpcResponse<LogEntry[]>>;
  windowState(): Promise<IpcResponse<{ maximized: boolean }>>;
}
