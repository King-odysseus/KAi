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
  brainGitStatusSchema,
  brainGitSyncResultSchema,
  brainImportResultSchema,
  brainOverviewSchema,
  brainSearchInputSchema,
  cognitive1McpToolInputSchema,
  cognitive1McpToolResultSchema,
  cognitive1OperationInputSchema,
  cognitive1OperationResultSchema,
  type BrainFieldUpdateInput,
  type BrainFieldUpdateResult,
  type BrainImportResult,
  type BrainGitStatus,
  type BrainGitSyncResult,
  type BrainOverview,
  type BrainSearchInput,
  type Cognitive1McpToolInput,
  type Cognitive1McpToolResult,
  type Cognitive1OperationInput,
  type Cognitive1OperationResult,
} from './brain';
import { setupStatusSchema, type SetupStatus } from './setup';
import {
  contextChipSchema,
  contextSearchInputSchema,
  contextPreviewInputSchema,
  contextPreviewSchema,
  gitDiffStatResultSchema,
  type ContextChip,
  type ContextPreview,
  type ContextPreviewInput,
  type ContextSearchInput,
  type GitDiffStatResult,
} from './context';
import {
  cliModelNameSchema,
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
  learningTutorSettingsSchema,
} from './domain';
import { providerModelCatalogSchema, type ProviderModelCatalog } from './direct-providers';
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
  proxyConnectionTestSchema,
  proxyAgentIdSchema,
  proxyAgentRouteSchema,
  proxyConfigTransferResultSchema,
  proxyCostsClearResultSchema,
  proxyCostPeriodSchema,
  proxyCostSummarySchema,
  proxyDryRunResultSchema,
  proxyEnvCopyResultSchema,
  proxyHistoryClearResultSchema,
  proxyHistoryDetailSchema,
  proxyHistoryQuerySchema,
  proxyHistorySummarySchema,
  proxyLaunchResultSchema,
  proxyLiveEventSchema,
  proxyModelSchema,
  proxyOverviewSchema,
  proxyPingResultSchema,
  proxyReplayPreviewSchema,
  proxyReplayResultSchema,
  proxyRoutingActionSchema,
  proxyRoutingResultSchema,
  proxyClaudeResetResultSchema,
  proxyClaudeSettingsResultSchema,
  type ProxyAgentRoute,
  type ProxyConnectionTest,
  type ProxyConfigTransferResult,
  type ProxyCostsClearResult,
  type ProxyCostPeriod,
  type ProxyCostSummary,
  type ProxyDryRunResult,
  type ProxyEnvCopyResult,
  type ProxyHistoryDetail,
  type ProxyHistoryQuery,
  type ProxyHistorySummary,
  type ProxyLaunchResult,
  type ProxyLiveEvent,
  type ProxyModel,
  type ProxyOverview,
  type ProxyPingResult,
  type ProxyReplayPreview,
  type ProxyReplayResult,
  type ProxyRoutingResult,
  type ProxyClaudeResetResult,
  type ProxyClaudeSettingsResult,
} from './proxy';
import {
  executionRuleDocumentSchema,
  executionRuleSaveInputSchema,
  type ExecutionRuleDocument,
  type ExecutionRuleSaveInput,
} from './rules';
import { coordinationOverviewSchema, preflightInputSchema, preflightResultSchema, type CoordinationOverview, type PreflightResult } from './coordination';
import { globalSearchInputSchema, globalSearchResultSchema, type GlobalSearchResult } from './search';
import { updateSettingsSchema, updateStateSchema, type UpdateState } from './updates';
import {
  terminalEventSchema,
  terminalResizeInputSchema,
  terminalSessionSchema,
  terminalStartInputSchema,
  terminalStopInputSchema,
  terminalWriteInputSchema,
  type TerminalEvent,
  type TerminalSession,
} from './terminal';
import { gitActionResultSchema, gitCheckoutInputSchema, gitCommitInputSchema, gitCreateBranchInputSchema, gitDiffInputSchema, gitOverviewSchema, gitPullRequestInputSchema, gitPullRequestResultSchema, gitStageInputSchema, gitSyncInputSchema, type GitActionResult, type GitOverview, type GitSyncAction } from './git';
import { verificationOverviewSchema, verificationRunInputSchema, verificationRunSchema, type VerificationOverview, type VerificationRun } from './verification';
import { editorDocumentRemoveSchema, editorDocumentStateSchema, editorSavedDocumentSchema, editorWindowSnapshotSchema, fileChangedInputSchema, fileReadInputSchema, fileWriteInputSchema, openedFileSchema, projectFileTreeSchema, rejectHunksInputSchema, writtenFileSchema, type EditorDocumentRemove, type EditorDocumentState, type EditorSavedDocument, type EditorWindowSnapshot, type FileWriteInput, type OpenedFile, type ProjectFileTree, type WrittenFile } from './files';
import {
  codeFormatInputSchema,
  codeFormatResultSchema,
  gitFileInfoSchema,
  learningEvaluationResultSchema,
  learningLessonRecordInputSchema,
  learningLessonRecordResultSchema,
  learningPreferencesInputSchema,
  learningProgressSchema,
  learningReadinessSchema,
  learningTutorRequestSchema,
  teachingDraftGenerateInputSchema,
  teachingDraftSchema,
  teachingLibraryEntryInputSchema,
  teachingLibrarySaveInputSchema,
  teachingLibrarySchema,
  type CodeFormatInput,
  type CodeFormatResult,
  type GitFileInfo,
  type LearningEvaluationResult,
  type LearningLessonRecordInput,
  type LearningLessonRecordResult,
  type LearningPreferencesInput,
  type LearningProgress,
  type LearningReadiness,
  type LearningTutorRequest,
  type TeachingDraft,
  type TeachingDraftGenerateInput,
  type TeachingLibrary,
  type TeachingLibraryEntryInput,
  type TeachingLibrarySaveInput,
} from './learning';
import { recoveryRecapSchema, recoveryRecordSchema, recoveryResumeSchema, type RecoveryRecap, type RecoveryRecord, type RecoveryResume } from './recovery';
import { notificationSettingsSchema, viewReportSchema, type OpenConversationEvent } from './notifications';
import { usageBudgetSchema, usageSummarySchema, type UsageSummary } from './usage';
import {
  checkpointRejectInputSchema,
  checkpointRestoreResultSchema,
  checkpointReviewSchema,
  checkpointTurnInputSchema,
  compareOpenInputSchema,
  comparePickInputSchema,
  compareRunSchema,
  compareStartInputSchema,
  configBackupCreateInputSchema,
  configBackupRestoreInputSchema,
  configBackupSchema,
  skillSummarySchema,
  workflowTemplateSaveInputSchema,
  workflowTemplateSchema,
  workflowStartInputSchema,
  workflowControlInputSchema,
  workflowRunSchema,
  type CheckpointRestoreResult,
  type CheckpointReview,
  type ComparePickInput,
  type CompareRun,
  type CompareStartInput,
  type ConfigBackup,
  type SkillSummary,
  type WorkflowTemplate,
  type WorkflowTemplateSaveInput,
  type WorkflowStartInput,
  type WorkflowRun,
} from './workbench';

export const ipcChannels = [
  'app:get-bootstrap',
  'projects:choose',
  'projects:open',
  'projects:remove',
  'settings:get',
  'settings:update',
  'providers:list-models',
  'services:status',
  'services:start',
  'services:stop',
  'services:restart',
  'services:rotate-token',
  'services:copy-token',
  'brain:overview',
  'brain:search',
  'brain:update-field',
  'brain:import',
  'brain:git-status',
  'brain:git-sync',
  'cognitive1:tool',
  'cognitive1:operation',
  'rules:get',
  'rules:save',
  'skills:list',
  'files:choose',
  'files:search',
  'files:tree',
  'files:read',
  'files:write',
  'files:changed',
  'editor:update-document',
  'editor:remove-document',
  'editor:update-window',
  'learning:progress',
  'learning:readiness',
  'learning:update-preferences',
  'learning:evaluate',
  'learning:record-lesson',
  'learning:teaching-library',
  'learning:save-teaching-entry',
  'learning:delete-teaching-entry',
  'learning:reset-teaching-entry',
  'learning:generate-teaching-draft',
  'code:format',
  'git:file-info',
  'checkpoints:reject-hunks',
  'context:git-diff',
  'attachments:save',
  'workflows:list-templates',
  'workflows:list-runs',
  'workflows:start',
  'workflows:stop',
  'workflows:resume',
  'workflows:save-template',
  'workflows:delete-template',
  'proxy:overview',
  'proxy:history',
  'proxy:history-detail',
  'proxy:clear-history',
  'proxy:test-connection',
  'proxy:ping-all',
  'proxy:dry-run',
  'proxy:clear-costs',
  'proxy:cost-summary',
  'proxy:replay-preview',
  'proxy:replay',
  'proxy:models',
  'proxy:routes',
  'proxy:route-action',
  'proxy:export-config',
  'proxy:import-config',
  'proxy:copy-env',
  'proxy:launch-agent',
  'proxy:reset-claude',
  'proxy:open-claude-settings',
  'proxy:start-live-tail',
  'proxy:stop-live-tail',
  'preferences:get',
  'preferences:update',
  'credentials:status',
  'credentials:set',
  'credentials:clear',
  'conversations:list',
  'conversations:get',
  'conversations:create',
  'conversations:compact',
  'conversations:save',
  'conversations:delete',
  'checkpoints:review',
  'checkpoints:reject',
  'checkpoints:restore',
  'compare:start',
  'compare:pick',
  'compare:discard',
  'compare:open',
  'backups:list',
  'backups:create',
  'backups:restore',
  'backups:delete',
  'agents:capabilities',
  'agents:run',
  'agents:cancel',
  'agents:pause',
  'agents:resume',
  'agents:sign-in',
  'agents:approval-response',
  'agents:api-capability',
  'context:preview',
  'usage:summary',
  'ui:report-view',
  'coordination:overview',
  'coordination:preflight',
  'search:global',
  'updates:state',
  'updates:check',
  'updates:download',
  'updates:install',
  'setup:status',
  'setup:complete',
  'terminal:start',
  'terminal:write',
  'terminal:resize',
  'terminal:stop',
  'git:overview',
  'git:stage',
  'git:commit',
  'git:checkout',
  'git:create-branch',
  'git:sync',
  'git:diff',
  'git:pull-request',
  'verification:overview',
  'verification:run',
  'recovery:list',
  'recovery:recap',
  'recovery:resume',
  'recovery:discard',
  'diagnostics:report',
  'diagnostics:data-locations',
  'diagnostics:recent-logs',
  'window:state',
  'window:new',
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
      learningTutor: learningTutorSettingsSchema.partial().strict().optional(),
      cognitive1: cognitive1ServiceSettingsSchema.partial().strict().optional(),
      proxy: proxyServiceSettingsSchema.partial().strict().optional(),
      usageBudget: usageBudgetSchema.partial().strict().optional(),
      notifications: notificationSettingsSchema.partial().strict().optional(),
      updates: updateSettingsSchema.partial().strict().optional(),
      agentModels: z.record(agentIdSchema, cliModelNameSchema).optional(),
      shortcuts: z.record(z.string().min(1).max(100), z.string().min(1).max(80)).optional(),
      setupCompletedAt: z.string().datetime().nullable().optional(),
    })
    .strict(),
  'providers:list-models': z
    .object({
      provider: providerIdSchema,
      baseUrl: z.string().url(),
      credentialId: z.string().min(1),
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
  'brain:import': emptyInputSchema,
  'brain:git-status': emptyInputSchema,
  'brain:git-sync': z.object({ action: z.enum(['init', 'commit', 'pull', 'push']) }).strict(),
  'cognitive1:tool': cognitive1McpToolInputSchema,
  'cognitive1:operation': cognitive1OperationInputSchema,
  'rules:get': emptyInputSchema,
  'rules:save': executionRuleSaveInputSchema,
  'skills:list': z.object({ projectId: z.string().min(1).optional() }).strict(),
  'files:choose': z.object({ projectId: z.string().min(1) }).strict(),
  'files:search': contextSearchInputSchema,
  'files:tree': z.object({ projectId: z.string().min(1) }).strict(),
  'files:read': fileReadInputSchema,
  'files:write': fileWriteInputSchema,
  'files:changed': fileChangedInputSchema,
  'editor:update-document': editorDocumentStateSchema,
  'editor:remove-document': editorDocumentRemoveSchema,
  'editor:update-window': editorWindowSnapshotSchema,
  'learning:progress': z.object({ projectId: z.string().min(1) }).strict(),
  'learning:readiness': emptyInputSchema,
  'learning:update-preferences': learningPreferencesInputSchema,
  'learning:evaluate': learningTutorRequestSchema,
  'learning:record-lesson': learningLessonRecordInputSchema,
  'learning:teaching-library': emptyInputSchema,
  'learning:save-teaching-entry': teachingLibrarySaveInputSchema,
  'learning:delete-teaching-entry': teachingLibraryEntryInputSchema,
  'learning:reset-teaching-entry': teachingLibraryEntryInputSchema,
  'learning:generate-teaching-draft': teachingDraftGenerateInputSchema,
  'code:format': codeFormatInputSchema,
  'git:file-info': z.object({ projectId: z.string().min(1), path: z.string().min(1).max(1_000) }).strict(),
  'checkpoints:reject-hunks': rejectHunksInputSchema,
  'context:git-diff': z.object({ projectId: z.string().min(1) }).strict(),
  'attachments:save': z
    .object({
      name: z.string().trim().min(1).max(500),
      dataUrl: z.string().min(1).max(30_000_000),
    })
    .strict(),
  'workflows:list-templates': z.object({ projectId: z.string().min(1).optional() }).strict(),
  'workflows:list-runs': z.object({ projectId: z.string().min(1).optional() }).strict(),
  'workflows:start': workflowStartInputSchema,
  'workflows:stop': workflowControlInputSchema,
  'workflows:resume': workflowControlInputSchema,
  'workflows:save-template': workflowTemplateSaveInputSchema,
  'workflows:delete-template': z.object({ id: z.string().min(1) }).strict(),
  'proxy:overview': emptyInputSchema,
  'proxy:history': proxyHistoryQuerySchema,
  'proxy:history-detail': z.object({ id: z.string().min(1) }).strict(),
  'proxy:clear-history': emptyInputSchema,
  'proxy:test-connection': z.object({ agent: z.string().min(1).max(32).optional() }).strict(),
  'proxy:ping-all': emptyInputSchema,
  'proxy:dry-run': z.object({ body: z.unknown() }).strict(),
  'proxy:clear-costs': emptyInputSchema,
  'proxy:cost-summary': z.object({ period: proxyCostPeriodSchema.exclude(['session']) }).strict(),
  'proxy:replay-preview': z.object({ id: z.string().min(1) }).strict(),
  'proxy:replay': z.object({ id: z.string().min(1) }).strict(),
  'proxy:models': emptyInputSchema,
  'proxy:routes': emptyInputSchema,
  'proxy:route-action': z
    .object({
      agent: proxyAgentIdSchema,
      action: proxyRoutingActionSchema,
      routeUntil: z.number().int().nonnegative().optional(),
    })
    .strict(),
  'proxy:export-config': emptyInputSchema,
  'proxy:import-config': emptyInputSchema,
  'proxy:copy-env': z.object({ agent: proxyAgentIdSchema.optional() }).strict(),
  'proxy:launch-agent': z.object({ agent: z.enum(['claude', 'codex']) }).strict(),
  'proxy:reset-claude': emptyInputSchema,
  'proxy:open-claude-settings': emptyInputSchema,
  'proxy:start-live-tail': emptyInputSchema,
  'proxy:stop-live-tail': emptyInputSchema,
  'preferences:get': z.object({ projectId: z.string().min(1) }).strict(),
  'preferences:update': projectPreferencesV1Schema,
  'credentials:status': emptyInputSchema,
  'credentials:set': z.object({ id: z.string().min(1), value: z.string().min(1) }).strict(),
  'credentials:clear': z.object({ id: z.string().min(1) }).strict(),
  'conversations:list': emptyInputSchema,
  'conversations:get': z.object({ id: z.string().min(1) }).strict(),
  'conversations:create': z.object({ projectId: z.string().nullable(), firstPrompt: z.string().max(20_000) }).strict(),
  'conversations:compact': z.object({ conversationId: z.string().min(1) }).strict(),
  'conversations:save': conversationRecordV1Schema,
  'conversations:delete': z.object({ id: z.string().min(1) }).strict(),
  'checkpoints:review': checkpointTurnInputSchema,
  'checkpoints:reject': checkpointRejectInputSchema,
  'checkpoints:restore': checkpointTurnInputSchema,
  'compare:start': compareStartInputSchema,
  'compare:pick': comparePickInputSchema,
  'compare:discard': z.object({ id: z.string().min(1) }).strict(),
  'compare:open': compareOpenInputSchema,
  'backups:list': emptyInputSchema,
  'backups:create': configBackupCreateInputSchema,
  'backups:restore': configBackupRestoreInputSchema,
  'backups:delete': configBackupRestoreInputSchema,
  'agents:capabilities': emptyInputSchema,
  'agents:run': agentRunRequestSchema,
  'agents:cancel': agentCancelInputSchema,
  'agents:pause': agentCancelInputSchema,
  'agents:resume': agentCancelInputSchema,
  'agents:sign-in': agentSignInInputSchema,
  'agents:approval-response': agentApprovalResponseInputSchema,
  'agents:api-capability': emptyInputSchema,
  'context:preview': contextPreviewInputSchema,
  'usage:summary': z.object({ conversationId: z.string().min(1).optional() }).strict(),
  'ui:report-view': viewReportSchema,
  'coordination:overview': emptyInputSchema,
  'coordination:preflight': preflightInputSchema,
  'search:global': globalSearchInputSchema,
  'updates:state': emptyInputSchema,
  'updates:check': emptyInputSchema,
  'updates:download': emptyInputSchema,
  'updates:install': emptyInputSchema,
  'setup:status': emptyInputSchema,
  'setup:complete': z.object({ complete: z.boolean() }).strict(),
  'terminal:start': terminalStartInputSchema,
  'terminal:write': terminalWriteInputSchema,
  'terminal:resize': terminalResizeInputSchema,
  'terminal:stop': terminalStopInputSchema,
  'git:overview': z.object({ projectId: z.string().min(1) }).strict(),
  'git:stage': gitStageInputSchema,
  'git:commit': gitCommitInputSchema,
  'git:checkout': gitCheckoutInputSchema,
  'git:create-branch': gitCreateBranchInputSchema,
  'git:sync': gitSyncInputSchema,
  'git:diff': gitDiffInputSchema,
  'git:pull-request': gitPullRequestInputSchema,
  'verification:overview': z.object({ projectId: z.string().min(1) }).strict(),
  'verification:run': verificationRunInputSchema,
  'recovery:list': emptyInputSchema,
  'recovery:recap': z.object({ conversationId: z.string().min(1) }).strict(),
  'recovery:resume': z.object({ conversationId: z.string().min(1) }).strict(),
  'recovery:discard': z.object({ conversationId: z.string().min(1) }).strict(),
  'diagnostics:report': z.object({ copy: z.boolean() }).strict(),
  'diagnostics:data-locations': emptyInputSchema,
  'diagnostics:recent-logs': z.object({ count: z.number().int().min(1).max(1000).optional() }).strict(),
  'window:state': emptyInputSchema,
  'window:new': emptyInputSchema,
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
export const brainImportResponseSchema = brainImportResultSchema;
export const brainGitStatusResponseSchema = brainGitStatusSchema;
export const brainGitSyncResponseSchema = brainGitSyncResultSchema;
export const cognitive1McpToolResponseSchema = cognitive1McpToolResultSchema;
export const cognitive1OperationResponseSchema = cognitive1OperationResultSchema;
export const executionRuleDocumentResponseSchema = executionRuleDocumentSchema;
export const skillSummaryListResponseSchema = z.array(skillSummarySchema);
export const selectedFilesResponseSchema = z.array(z.string().min(1));
export const gitDiffStatResponseSchema = gitDiffStatResultSchema;
export const attachmentResultSchema = contextChipSchema;
export const workflowTemplateListResponseSchema = z.array(workflowTemplateSchema);
export const workflowRunListResponseSchema = z.array(workflowRunSchema);
export const checkpointReviewResponseSchema = checkpointReviewSchema;
export const checkpointRestoreResponseSchema = checkpointRestoreResultSchema;
export const compareRunResponseSchema = compareRunSchema;
export const configBackupListResponseSchema = z.array(configBackupSchema);
export const proxyOverviewResponseSchema = proxyOverviewSchema;
export const proxyHistoryResponseSchema = z.array(proxyHistorySummarySchema);
export const proxyHistoryDetailResponseSchema = proxyHistoryDetailSchema;
export const proxyHistoryClearResponseSchema = proxyHistoryClearResultSchema;
export const proxyConnectionTestResponseSchema = proxyConnectionTestSchema;
export const proxyPingAllResponseSchema = z.array(proxyPingResultSchema);
export const proxyDryRunResponseSchema = proxyDryRunResultSchema;
export const proxyCostsClearResponseSchema = proxyCostsClearResultSchema;
export const proxyCostSummaryResponseSchema = proxyCostSummarySchema;
export const proxyReplayPreviewResponseSchema = proxyReplayPreviewSchema;
export const proxyReplayResponseSchema = proxyReplayResultSchema;
export const proxyModelsResponseSchema = z.array(proxyModelSchema);
export const proxyRoutesResponseSchema = z.array(proxyAgentRouteSchema);
export const proxyRoutingResultResponseSchema = proxyRoutingResultSchema;
export const proxyConfigTransferResponseSchema = proxyConfigTransferResultSchema;
export const proxyEnvCopyResponseSchema = proxyEnvCopyResultSchema;
export const proxyLaunchResponseSchema = proxyLaunchResultSchema;
export const proxyClaudeResetResponseSchema = proxyClaudeResetResultSchema;
export const proxyClaudeSettingsResponseSchema = proxyClaudeSettingsResultSchema;
export const proxyLiveEventResponseSchema = proxyLiveEventSchema;
export const agentCapabilitiesResponseSchema = z.array(agentCapabilitySchema);
export const agentRunResponseSchema = agentRunResultSchema;
export const agentCancelResponseSchema = z.boolean();
export const agentSignInResponseSchema = agentSignInResultSchema;
export const directApiCapabilityResponseSchema = directApiCapabilitySchema;
export const providerModelCatalogResponseSchema = providerModelCatalogSchema;
export const contextPreviewResponseSchema = contextPreviewSchema;
export const usageSummaryResponseSchema = usageSummarySchema;
export const projectFileTreeResponseSchema = projectFileTreeSchema;
export const openedFileResponseSchema = openedFileSchema;
export const writtenFileResponseSchema = writtenFileSchema;
export const learningProgressResponseSchema = learningProgressSchema;
export const learningReadinessResponseSchema = learningReadinessSchema;
export const learningEvaluationResponseSchema = learningEvaluationResultSchema;
export const learningLessonRecordResponseSchema = learningLessonRecordResultSchema;
export const teachingLibraryResponseSchema = teachingLibrarySchema;
export const teachingDraftResponseSchema = teachingDraftSchema;
export const codeFormatResponseSchema = codeFormatResultSchema;
export const gitFileInfoResponseSchema = gitFileInfoSchema;
export const coordinationOverviewResponseSchema = coordinationOverviewSchema;
export const preflightResponseSchema = preflightResultSchema;
export const globalSearchResponseSchema = globalSearchResultSchema;
export const updateStateResponseSchema = updateStateSchema;
export const setupStatusResponseSchema = setupStatusSchema;
export const terminalSessionResponseSchema = terminalSessionSchema;
export const terminalEventResponseSchema = terminalEventSchema;
export const gitOverviewResponseSchema = gitOverviewSchema;
export const gitActionResponseSchema = gitActionResultSchema;
export const gitPullRequestResponseSchema = gitPullRequestResultSchema;
export const verificationOverviewResponseSchema = verificationOverviewSchema;
export const verificationRunResponseSchema = verificationRunSchema;
export const recoveryListResponseSchema = z.array(recoveryRecordSchema);
export const recoveryRecapResponseSchema = recoveryRecapSchema;
export const recoveryResumeResponseSchema = recoveryResumeSchema;
export const conversationCompactionResponseSchema = conversationRecordV1Schema;
export const editorSavedDocumentResponseSchema = z.array(editorSavedDocumentSchema);

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
  activeConversationId: string | null;
  buildIdentifier: string;
  editor: EditorWindowSnapshot | null;
  settings: AppSettings;
  services: ServiceState[];
  dataLocations: DataLocation[];
}

/** Shared state broadcast to every independent window after a main-process mutation. */
export interface SharedDesktopState {
  settings: AppSettings;
  projects: ProjectRecord[];
  credentials: CredentialStatus;
  services: ServiceState[];
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
  learningTutor?: Partial<AppSettings['learningTutor']>;
  cognitive1?: Partial<AppSettings['cognitive1']>;
  proxy?: Partial<AppSettings['proxy']>;
  usageBudget?: Partial<AppSettings['usageBudget']>;
  notifications?: Partial<AppSettings['notifications']>;
  updates?: Partial<AppSettings['updates']>;
  agentModels?: AppSettings['agentModels'];
  shortcuts?: AppSettings['shortcuts'];
  setupCompletedAt?: AppSettings['setupCompletedAt'];
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
  onSharedDesktopState(listener: (state: SharedDesktopState) => void): () => void;
  serviceStatus(): Promise<IpcResponse<ServiceState[]>>;
  startService(kind: ServiceState['kind']): Promise<IpcResponse<ServiceState[]>>;
  stopService(kind: ServiceState['kind']): Promise<IpcResponse<ServiceState[]>>;
  restartService(kind: ServiceState['kind']): Promise<IpcResponse<ServiceState[]>>;
  rotateServiceToken(kind: ServiceState['kind']): Promise<IpcResponse<ServiceState[]>>;
  copyServiceToken(kind: ServiceState['kind']): Promise<IpcResponse<ServiceTokenCopyResult>>;
  brainOverview(): Promise<IpcResponse<BrainOverview>>;
  searchBrain(request: BrainSearchInput): Promise<IpcResponse<BrainOverview['recentEntries']>>;
  updateBrainField(request: BrainFieldUpdateInput): Promise<IpcResponse<BrainFieldUpdateResult>>;
  importBrain(): Promise<IpcResponse<BrainImportResult | null>>;
  cognitive1Tool(request: Cognitive1McpToolInput): Promise<IpcResponse<Cognitive1McpToolResult>>;
  cognitive1Operation(request: Cognitive1OperationInput): Promise<IpcResponse<Cognitive1OperationResult>>;
  getRules(): Promise<IpcResponse<ExecutionRuleDocument>>;
  saveRule(request: ExecutionRuleSaveInput): Promise<IpcResponse<ExecutionRuleDocument>>;
  listSkills(projectId?: string): Promise<IpcResponse<SkillSummary[]>>;
  chooseFiles(projectId: string): Promise<IpcResponse<string[]>>;
  searchFiles(request: ContextSearchInput): Promise<IpcResponse<string[]>>;
  projectFileTree(projectId: string): Promise<IpcResponse<ProjectFileTree>>;
  readProjectFile(projectId: string, path: string): Promise<IpcResponse<OpenedFile>>;
  writeProjectFile(request: FileWriteInput): Promise<IpcResponse<WrittenFile>>;
  projectFileChanged(projectId: string, path: string, expectedHash: string): Promise<IpcResponse<boolean>>;
  updateEditorDocument(document: EditorDocumentState): Promise<IpcResponse<boolean>>;
  removeEditorDocument(document: EditorDocumentRemove): Promise<IpcResponse<boolean>>;
  updateEditorWindow(snapshot: EditorWindowSnapshot): Promise<IpcResponse<boolean>>;
  onEditorDocumentsSaved(listener: (documents: EditorSavedDocument[]) => void): () => void;
  learningProgress(projectId: string): Promise<IpcResponse<LearningProgress>>;
  learningReadiness(): Promise<IpcResponse<LearningReadiness>>;
  updateLearningPreferences(input: LearningPreferencesInput): Promise<IpcResponse<LearningProgress>>;
  evaluateLearning(request: LearningTutorRequest): Promise<IpcResponse<LearningEvaluationResult>>;
  recordLearningLesson(input: LearningLessonRecordInput): Promise<IpcResponse<LearningLessonRecordResult>>;
  teachingLibrary(): Promise<IpcResponse<TeachingLibrary>>;
  saveTeachingEntry(input: TeachingLibrarySaveInput): Promise<IpcResponse<TeachingLibrary>>;
  deleteTeachingEntry(input: TeachingLibraryEntryInput): Promise<IpcResponse<TeachingLibrary>>;
  resetTeachingEntry(input: TeachingLibraryEntryInput): Promise<IpcResponse<TeachingLibrary>>;
  generateTeachingDraft(input: TeachingDraftGenerateInput): Promise<IpcResponse<TeachingDraft>>;
  formatCode(input: CodeFormatInput): Promise<IpcResponse<CodeFormatResult>>;
  gitFileInfo(projectId: string, path: string): Promise<IpcResponse<GitFileInfo>>;
  rejectCheckpointHunks(conversationId: string, turnId: string, filePath: string, hunkIds: number[]): Promise<IpcResponse<CheckpointRestoreResult>>;
  gitDiffStat(projectId: string): Promise<IpcResponse<GitDiffStatResult>>;
  saveAttachment(name: string, dataUrl: string): Promise<IpcResponse<ContextChip>>;
  listWorkflowTemplates(projectId?: string): Promise<IpcResponse<WorkflowTemplate[]>>;
  listWorkflowRuns(projectId?: string): Promise<IpcResponse<WorkflowRun[]>>;
  startWorkflow(request: WorkflowStartInput): Promise<IpcResponse<WorkflowRun>>;
  stopWorkflow(workflowId: string): Promise<IpcResponse<WorkflowRun>>;
  resumeWorkflow(workflowId: string): Promise<IpcResponse<WorkflowRun>>;
  onWorkflowChanged(listener: (run: WorkflowRun) => void): () => void;
  saveWorkflowTemplate(request: WorkflowTemplateSaveInput): Promise<IpcResponse<WorkflowTemplate>>;
  deleteWorkflowTemplate(id: string): Promise<IpcResponse<{ deleted: boolean }>>;
  proxyOverview(): Promise<IpcResponse<ProxyOverview>>;
  proxyHistory(request?: ProxyHistoryQuery): Promise<IpcResponse<ProxyHistorySummary[]>>;
  proxyHistoryDetail(id: string): Promise<IpcResponse<ProxyHistoryDetail>>;
  clearProxyHistory(): Promise<IpcResponse<{ cleared: number }>>;
  testProxyConnection(agent?: string): Promise<IpcResponse<ProxyConnectionTest>>;
  pingProxyProviders(): Promise<IpcResponse<ProxyPingResult[]>>;
  dryRunProxy(body: unknown): Promise<IpcResponse<ProxyDryRunResult>>;
  clearProxyCosts(): Promise<IpcResponse<ProxyCostsClearResult>>;
  proxyCostSummary(period: Exclude<ProxyCostPeriod, 'session'>): Promise<IpcResponse<ProxyCostSummary>>;
  previewProxyReplay(id: string): Promise<IpcResponse<ProxyReplayPreview>>;
  replayProxyRequest(id: string): Promise<IpcResponse<ProxyReplayResult>>;
  proxyModels(): Promise<IpcResponse<ProxyModel[]>>;
  proxyRoutes(): Promise<IpcResponse<ProxyAgentRoute[]>>;
  routeProxyAgent(agent: ProxyAgentRoute['agentId'], action: ProxyRoutingResult['action'], routeUntil?: number): Promise<IpcResponse<ProxyRoutingResult>>;
  exportProxyConfig(): Promise<IpcResponse<ProxyConfigTransferResult>>;
  importProxyConfig(): Promise<IpcResponse<ProxyConfigTransferResult>>;
  copyProxyEnv(agent?: ProxyAgentRoute['agentId']): Promise<IpcResponse<ProxyEnvCopyResult>>;
  launchProxyAgent(agent: 'claude' | 'codex'): Promise<IpcResponse<ProxyLaunchResult>>;
  resetClaudeCode(): Promise<IpcResponse<ProxyClaudeResetResult>>;
  openClaudeSettings(): Promise<IpcResponse<ProxyClaudeSettingsResult>>;
  startProxyLiveTail(): Promise<IpcResponse<boolean>>;
  stopProxyLiveTail(): Promise<IpcResponse<boolean>>;
  onProxyLiveEvent(listener: (event: ProxyLiveEvent) => void): () => void;
  getPreferences(projectId: string): Promise<IpcResponse<ProjectPreferences | null>>;
  updatePreferences(preferences: ProjectPreferences): Promise<IpcResponse<ProjectPreferences>>;
  credentialStatus(): Promise<IpcResponse<CredentialStatus>>;
  setCredential(id: string, value: string): Promise<IpcResponse<CredentialStatus>>;
  clearCredential(id: string): Promise<IpcResponse<CredentialStatus>>;
  listConversations(): Promise<IpcResponse<ConversationRecord[]>>;
  getConversation(id: string): Promise<IpcResponse<ConversationRecord | null>>;
  createConversation(projectId: string | null, firstPrompt: string): Promise<IpcResponse<ConversationRecord>>;
  compactConversation(conversationId: string): Promise<IpcResponse<ConversationRecord>>;
  saveConversation(conversation: ConversationRecord): Promise<IpcResponse<ConversationRecord>>;
  deleteConversation(id: string): Promise<IpcResponse<void>>;
  reviewCheckpoint(conversationId: string, turnId: string): Promise<IpcResponse<CheckpointReview>>;
  rejectCheckpointFile(conversationId: string, turnId: string, filePath: string): Promise<IpcResponse<CheckpointRestoreResult>>;
  restoreCheckpoint(conversationId: string, turnId: string): Promise<IpcResponse<CheckpointRestoreResult>>;
  startCompare(request: CompareStartInput): Promise<IpcResponse<CompareRun>>;
  pickCompareWinner(id: string, side: 'left' | 'right'): Promise<IpcResponse<{ applied: boolean }>>;
  discardCompare(id: string): Promise<IpcResponse<{ discarded: boolean }>>;
  openCompareWorktree(id: string, side: 'left' | 'right'): Promise<IpcResponse<{ opened: boolean }>>;
  listBackups(): Promise<IpcResponse<ConfigBackup[]>>;
  createBackup(name?: string): Promise<IpcResponse<ConfigBackup>>;
  restoreBackup(id: string): Promise<IpcResponse<{ restored: boolean }>>;
  deleteBackup(id: string): Promise<IpcResponse<{ deleted: boolean }>>;
  agentCapabilities(): Promise<IpcResponse<AgentCapability[]>>;
  directApiCapability(): Promise<IpcResponse<DirectApiCapability>>;
  listProviderModels(request: { provider: AppSettings['directApi']['provider']; baseUrl: string; credentialId: string }): Promise<IpcResponse<ProviderModelCatalog>>;
  previewContext(request: ContextPreviewInput): Promise<IpcResponse<ContextPreview>>;
  runAgent(request: AgentRunRequest): Promise<IpcResponse<AgentRunResult>>;
  cancelAgent(conversationId: string): Promise<IpcResponse<boolean>>;
  pauseAgent(conversationId: string): Promise<IpcResponse<boolean>>;
  resumeAgent(conversationId: string): Promise<IpcResponse<boolean>>;
  signInAgent(agent: AgentRunRequest['agent']): Promise<IpcResponse<AgentSignInResult>>;
  respondToApproval(request: AgentApprovalResponseInput): Promise<IpcResponse<boolean>>;
  onAgentEvent(listener: (payload: AgentRunEvent) => void): () => void;
  usageSummary(conversationId?: string): Promise<IpcResponse<UsageSummary>>;
  reportView(view: string, conversationId: string | null): Promise<IpcResponse<boolean>>;
  coordinationOverview(): Promise<IpcResponse<CoordinationOverview>>;
  coordinationPreflight(projectId: string, files: string[]): Promise<IpcResponse<PreflightResult>>;
  globalSearch(query: string): Promise<IpcResponse<GlobalSearchResult>>;
  updateState(): Promise<IpcResponse<UpdateState>>;
  checkForUpdates(): Promise<IpcResponse<UpdateState>>;
  downloadUpdate(): Promise<IpcResponse<UpdateState>>;
  installUpdate(): Promise<IpcResponse<UpdateState>>;
  onUpdateState(listener: (state: UpdateState) => void): () => void;
  setupStatus(): Promise<IpcResponse<SetupStatus>>;
  completeSetup(complete: boolean): Promise<IpcResponse<SetupStatus>>;
  startTerminal(projectId: string, shell: TerminalSession['shell'], cols: number, rows: number): Promise<IpcResponse<TerminalSession>>;
  writeTerminal(id: string, data: string): Promise<IpcResponse<boolean>>;
  resizeTerminal(id: string, cols: number, rows: number): Promise<IpcResponse<boolean>>;
  stopTerminalCommand(id: string): Promise<IpcResponse<boolean>>;
  onTerminalEvent(listener: (event: TerminalEvent) => void): () => void;
  brainGitStatus(): Promise<IpcResponse<BrainGitStatus>>;
  brainGitSync(action: 'init' | 'commit' | 'pull' | 'push'): Promise<IpcResponse<BrainGitSyncResult>>;
  gitOverview(projectId: string): Promise<IpcResponse<GitOverview>>;
  gitStage(projectId: string, paths: string[], stage: boolean): Promise<IpcResponse<GitActionResult>>;
  gitCommit(projectId: string, message: string): Promise<IpcResponse<GitActionResult>>;
  gitCheckout(projectId: string, branch: string): Promise<IpcResponse<GitActionResult>>;
  gitCreateBranch(projectId: string, name: string, checkout: boolean): Promise<IpcResponse<GitActionResult>>;
  gitSync(projectId: string, action: GitSyncAction): Promise<IpcResponse<GitActionResult>>;
  gitDiff(projectId: string, path: string, staged: boolean): Promise<IpcResponse<GitActionResult>>;
  gitPullRequest(projectId: string, title: string, body: string): Promise<IpcResponse<{ url: string }>>;
  verificationOverview(projectId: string): Promise<IpcResponse<VerificationOverview>>;
  runVerification(projectId: string, command: string): Promise<IpcResponse<VerificationRun>>;
  listInterruptedRuns(): Promise<IpcResponse<RecoveryRecord[]>>;
  interruptedRunRecap(conversationId: string): Promise<IpcResponse<RecoveryRecap>>;
  resumeInterruptedRun(conversationId: string): Promise<IpcResponse<RecoveryResume>>;
  discardInterruptedRun(conversationId: string): Promise<IpcResponse<boolean>>;
  onOpenConversation(listener: (event: OpenConversationEvent) => void): () => void;
  diagnosticsReport(copy: boolean): Promise<IpcResponse<{ text: string }>>;
  dataLocations(): Promise<IpcResponse<DataLocation[]>>;
  recentLogs(count?: number): Promise<IpcResponse<LogEntry[]>>;
  windowState(): Promise<IpcResponse<{ maximized: boolean }>>;
  newWindow(): Promise<IpcResponse<boolean>>;
}
