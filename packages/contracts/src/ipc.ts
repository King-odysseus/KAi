import { z } from 'zod';
import type { PlaywrightViewportStatus } from './playwright-viewport';
import { composerQueueAddInputSchema, composerQueueClaimInputSchema, composerQueueConversationInputSchema, composerQueueHoldInputSchema, composerQueueSchema, composerQueueUpdateInputSchema, type ComposerQueue, type QueuedPrompt } from './composer-queue';
import { promptPresetDeleteInputSchema, promptPresetSaveInputSchema, type PromptPresetList } from './prompt-presets';
import { autoModelSettingsSchema } from './model-tiers';
import {
  interviewAnswerInputSchema,
  interviewCorrectionInputSchema,
  interviewAssumptionInputSchema,
  interviewTopicAskInputSchema,
  interviewProjectInputSchema,
  interviewDraftInputSchema,
  type InterviewDraftInput,
  interviewStartInputSchema,
  studioProjectArchiveInputSchema,
  studioProjectFolderInputSchema,
  studioProjectFolderResultSchema,
  studioProjectLaunchInputSchema,
  studioProjectLaunchResultSchema,
  studioProjectSummarySchema,
  type InterviewAnswerInput,
  type InterviewCorrectionInput,
  type InterviewAssumptionInput,
  type InterviewTopicAskInput,
  type InterviewStartInput,
  type InterviewState,
  type StudioReadiness,
  type StudioProjectArchiveInput,
  type StudioProjectFolderInput,
  type StudioProjectFolderResult,
  type StudioProjectLaunchInput,
  type StudioProjectLaunchResult,
  type StudioProjectSummary,
} from './interview';
import { brainMirrorInputSchema, brainMirrorOutcomeSchema, type BrainMirrorInput, type BrainMirrorOutcome } from './brain-mirror';
import {
  autopilotAuditEntrySchema,
  autopilotAuditInputSchema,
  autopilotInterruptedInputSchema,
  autopilotProjectInputSchema,
  autopilotRunRecordSchema,
  autopilotStartInputSchema,
  autopilotStatusResponseSchema,
  type AutopilotInterruptedInput,
  type AutopilotAuditInput,
  type AutopilotAuditEntry,
  type AutopilotProjectInput,
  type AutopilotRunRecord,
  type AutopilotStartInput,
  type AutopilotStatus,
} from './autopilot';
import {
  architectAnswerInputSchema,
  architectConversationInputSchema,
  architectReadinessInputSchema,
  architectRunInputSchema,
  type ArchitectAnswerInput,
  type ArchitectConversationInput,
  type ArchitectReadiness,
  type ArchitectRunInput,
  type ArchitectStatus,
  type RoleTarget,
} from './architect';
import {
  autoConversationInputSchema,
  autoStartInputSchema,
  autoStatusResponseSchema,
  type AutoConversationInput,
  type AutoStartRequest,
  type AutoStatus,
} from './auto';
import {
  studioArtifactInputSchema,
  openPencilSaveInputSchema,
  studioArtifactSaveInputSchema,
  studioArtifactsGenerateSelectedInputSchema,
  studioArtifactsGenerationResultSchema,
  studioPlanChatInputSchema,
  studioPlanChatResultSchema,
  studioPlanApplyInputSchema,
  studioPlanApplyResultSchema,
  studioStyleReferenceAddInputSchema,
  studioStyleReferenceRemoveInputSchema,
  studioBoardCardInputSchema,
  studioBoardClaimInputSchema,
  studioBoardMoveInputSchema,
  boardCardReviewInputSchema,
  studioBoardAcceptanceInputSchema,
  studioBoardRouteInputSchema,
  studioBoardWorkInputSchema,
  studioDesignBuildCancelInputSchema,
  studioDesignBuildStepInputSchema,
  studioDesignBuildStepResultSchema,
  studioDesignChatInputSchema,
  studioDesignChatResultSchema,
  studioDesignScreenshotInputSchema,
  studioDesignScreenshotResultSchema,
  studioRouteRepairInputSchema,
  studioRouteRepairResultSchema,
  studioDesignPageDeleteInputSchema,
  studioDesignPageRenameInputSchema,
  studioDesignPullSchema,
  studioDesignSchema,
  studioDesignPullInputSchema,
  studioProjectInputSchema,
  studioArtifactsSchema,
  studioBoardSchema,
  boardCardSchema,
  studioUiCheckResultSchema,
  type StudioArtifactInput,
  type OpenPencilSaveInput,
  type OpenPencilStatus,
  type OpenPencilTestResult,
  type StudioArtifactSaveInput,
  type StudioArtifactsGenerateSelectedInput,
  type StudioArtifactsGenerationResult,
  type StudioPlanChatInput,
  type StudioPlanChatResult,
  type StudioPlanProgress,
  type StudioPlanApplyInput,
  type StudioPlanApplyResult,
  type StudioStyleReferenceAddInput,
  type StudioStyleReferenceRemoveInput,
  type StudioStyleReferences,
  type StudioArtifacts,
  type StudioBoard,
  type StudioBoardCardInput,
  type StudioBoardClaimInput,
  type StudioBoardMoveInput,
  type BoardCardReviewInput,
  type StudioBoardAcceptanceInput,
  type StudioBoardRouteInput,
  type StudioBoardWorkInput,
  type StudioDesign,
  type StudioDesignBuildStepInput,
  type StudioDesignBuildStepResult,
  type StudioDesignChatInput,
  type StudioDesignChatResult,
  type StudioDesignScreenshotInput,
  type StudioDesignScreenshotResult,
  type StudioRouteRepairResult,
  type StudioDesignPageDeleteInput,
  type StudioDesignPageRenameInput,
  type StudioDesignPull,
  type StudioDesignStatus,
  type StudioProjectInput,
  type StudioUiCheckResult,
  type BoardCard,
} from './studio';
import type { StudioGuideView } from './studio-guide';
import type { CodeGuideView } from './code-guide';
import {
  remoteAccessStatusSchema,
  remoteAccessSettingsSchema,
  remoteDeviceSchema,
  remotePairDeviceInputSchema,
  remoteTasksInputSchema,
  remoteTokenResultSchema,
  remoteWindowSummarySchema,
  type RemoteAccessStatus,
  type RemoteDeviceSummary,
  type RemoteTokenResult,
  type RemoteWindowSummary,
} from './remote';
import {
  promptGuideInputSchema,
  promptRefineInputSchema,
  promptRefineResultSchema,
  promptGuideSettingsSchema,
  teamPlanFromPartsInputSchema,
  type PromptGuideInput,
  type PromptGuideReadiness,
  type PromptGuideResult,
  type PromptRefineInput,
  type PromptRefineResult,
  type TeamPlanFromPartsInput,
} from './prompt-guide';
import { teamRecordQuerySchema, type TeamRecordQuery, type TeamRecordAdvice } from './team-record';
import { experienceLevelSchema, memoryImprovementSuggestionReviewInputSchema, memoryImprovementSuggestionSchema, type MemoryImprovementSuggestion } from './experience';
import { capabilityBundleSkillSchema, capabilityBundleSkillsInputSchema, type CapabilityBundle } from './capability-bundle';
import { reviewChangesInputSchema, type ChangeReviewResult, type ReviewChangesInput } from './review';
import {
  evalCaseDeleteInputSchema,
  evalCaseInputSchema,
  evalListInputSchema,
  evalRunInputSchema,
  scheduleIdInputSchema,
  scheduleInputSchema,
  scheduleListInputSchema,
  type AgentScorecard,
  type EvalCase,
  type EvalCaseInput,
  type EvalOverview,
  type EvalResult,
  type EvalRunInput,
  type Schedule,
  type ScheduleInput,
} from './automation';
import { type PermissionRule } from './permission-rules';
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
  type AgentRunState,
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
import {
  equalizerImageInputSchema,
  equalizerRunInputSchema,
  equalizerScreensInputSchema,
  type EqualizerImageInput,
  type EqualizerProgress,
  type EqualizerReport,
  type EqualizerRunInput,
  type EqualizerScreens,
} from './equalizer';
import { setupGuideAnswerInputSchema, setupStatusSchema, type AgentConfigImportPreview, type SetupGuideAnswer, type SetupGuideAnswerInput, type SetupStatus } from './setup';
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
  conversationBranchResultSchema,
  conversationForkInputSchema,
  conversationRecordV1Schema,
  conversationRewindInputSchema,
  mcpServerSettingsSchema,
  type AppSettings,
  type McpServerSettings,
  type ConversationBranchResult,
  type ConversationRecord,
  type ProjectPreferences,
  type ProjectRecord,
  projectPreferencesV1Schema,
  projectRecordV1Schema,
  proxyServiceSettingsSchema,
  learningTutorSettingsSchema,
  experienceCaptureSettingsSchema,
} from './domain';
import { webSearchSettingsSchema, webSearchSourceSchema, webSearchTestResultSchema, type WebSearchSource, type WebSearchTestResult } from './web-search';
import { connectorCatalogEntrySchema, connectorInstallInputSchema, type ConnectorCatalogEntry } from './catalog';
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
  previewProjectInputSchema,
  previewStartInputSchema,
  type PreviewInfo,
  type PreviewStartInput,
  type PreviewState,
} from './preview';
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
  executionRuleInjectionReportSchema,
  executionRuleSaveInputSchema,
  type ExecutionRuleDocument,
  type ExecutionRuleInjectionReport,
  type ExecutionRuleSaveInput,
} from './rules';
import { coordinationOverviewSchema, preflightInputSchema, preflightResultSchema, type CoordinationOverview, type PreflightResult } from './coordination';
import { globalSearchInputSchema, globalSearchResultSchema, type GlobalSearchResult } from './search';
import { updateSettingsSchema, updateStateSchema, type UpdateState } from './updates';
import {
  terminalEventSchema,
  terminalResizeInputSchema,
  terminalBufferInputSchema,
  terminalSessionSchema,
  terminalStartInputSchema,
  terminalStopInputSchema,
  terminalWriteInputSchema,
  type TerminalEvent,
  type TerminalSession,
} from './terminal';
import { planSchema, type Plan } from './plan';
import { conventionsGetInputSchema, conventionsMuteInputSchema, conventionsReferenceInputSchema, conventionsRuleAddInputSchema, conventionsRuleRemoveInputSchema, type ConventionsState } from './conventions';
import { crewAnswerInputSchema, crewControlInputSchema, crewDefaultsInputSchema, crewDesignInputSchema, crewStartInputSchema, type CrewAnswerInput, type CrewConfig, type CrewDesign, type CrewRun, type CrewStartInput } from './crew';
import { gitActionResultSchema, gitCheckoutInputSchema, gitGithubStateSchema, gitCommitInputSchema, gitCreateBranchInputSchema, gitCreateRepositoryInputSchema, gitBlameInputSchema, type GitBlameResult, type GitChangesResult, todoScanInputSchema, type TodoScanResult, gitCreateRepositoryResultSchema, gitDiffInputSchema, gitOverviewSchema, gitPullRequestInputSchema, gitPullRequestResultSchema, gitStageInputSchema, gitSyncInputSchema, gitTeamBranchInputSchema, gitTeamCloneInputSchema, type GitActionResult, type GitCreateRepositoryResult, type GitGithubState, type GitOverview, type GitRepositoryVisibility, type GitSyncAction } from './git';
import { importAddCardsInputSchema, importScanInputSchema, type ImportReport } from './import';
import { verificationOverviewSchema, verificationRunInputSchema, verificationRunSchema, type VerificationOverview, type VerificationRun } from './verification';
import { editorDocumentRemoveSchema, editorDocumentStateSchema, editorSavedDocumentSchema, editorWindowSnapshotSchema, fileChangedInputSchema, fileMutationResultSchema, filePathInputSchema, fileReadInputSchema, fileRenameInputSchema, fileWriteInputSchema, openedFileSchema, projectFileTreeSchema, rejectHunksInputSchema, writtenFileSchema, type EditorDocumentRemove, type EditorDocumentState, type EditorSavedDocument, type EditorWindowSnapshot, type FileMutationResult, type FilePathInput, type FileRenameInput, type FileWriteInput, type OpenedFile, type ProjectFileTree, type WrittenFile } from './files';
import {
  codeFormatInputSchema,
  codeInstallFormatterInputSchema,
  codeFormatResultSchema,
  gitFileInfoSchema,
  learningEvaluationResultSchema,
  learningCheckEvidenceInputSchema,
  learningExplainBackHelpInputSchema,
  learningExplainBackHelpSchema,
  learningExplainBackInputSchema,
  learningExplainBackResultSchema,
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
  type CodeInstallFormatterInput,
  type CodeFormatResult,
  type GitFileInfo,
  type LearningEvaluationResult,
  type LearningCheckEvidenceInput,
  type LearningExplainBackHelp,
  type LearningExplainBackHelpInput,
  type LearningExplainBackInput,
  type LearningExplainBackResult,
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
import {
  securityFindingSaveInputSchema,
  securityFindingSchema,
  securityFindingStatusUpdateInputSchema,
  type SecurityFinding,
  type SecurityFindingSaveInput,
  type SecurityFindingStatusUpdateInput,
} from './security-findings';
import { securityScanInputSchema, type SecurityScanInput, type SecurityScanResult } from './security-audit';
import {
  teamPlanDraftSchema,
  teamPlanInputSchema,
  teamStartInputSchema,
  agentTeamSchema,
  type TeamPlanDraft,
  type TeamPlanInput,
  type TeamStartInput,
} from './team';
import { recoveryListingSchema, recoveryRecapSchema, recoveryRecordSchema, recoveryResumeSchema, stopAllRunsResultSchema, type RecoveryListing, type RecoveryRecap, type RecoveryRecord, type RecoveryResume, type StopAllRunsResult } from './recovery';
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
  'projects:clear',
  'settings:get',
  'settings:update',
  'providers:list-models',
  'web-search:test',
  'catalog:list',
  'catalog:install',
  'services:status',
  'services:start',
  'services:stop',
  'services:restart',
  'services:rotate-token',
  'services:copy-token',
  'brain:overview',
  'brain:mirror-now',
  'brain:search',
  'brain:update-field',
  'brain:import',
  'brain:git-status',
  'brain:git-sync',
  'cognitive1:tool',
  'cognitive1:operation',
  'rules:get',
  'rules:save',
  'rules:inject-projects',
  'permission-rules:suggest',
  'skills:list',
  'skills:bundle-content',
  'files:choose',
  'files:search',
  'files:tree',
  'files:read',
  'files:image',
  'mockup:inline',
  'mockup:file',
  'files:write',
  'files:changed',
  'files:delete',
  'files:rename',
  'files:folder',
  'files:reveal',
  'editor:update-document',
  'editor:remove-document',
  'editor:update-window',
  'learning:progress',
  'learning:understood',
  'learning:record-check-evidence',
  'learning:explain-back',
  'learning:explain-back-help',
  'learning:readiness',
  'learning:update-preferences',
  'learning:evaluate',
  'learning:cancel',
  'learning:record-lesson',
  'learning:teaching-library',
  'learning:save-teaching-entry',
  'learning:delete-teaching-entry',
  'learning:reset-teaching-entry',
  'learning:generate-teaching-draft',
  'learning:security-findings',
  'learning:save-security-finding',
  'learning:update-security-finding-status',
  'learning:security-scan',
  'code:format',
  'code:install-formatter',
  'code:guide-read',
  'code:guide-explain',
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
  'crew:list',
  'crew:start',
  'crew:approve',
  'crew:answer',
  'crew:pause',
  'crew:resume',
  'crew:stop',
  'crew:defaults',
  'crew:save-defaults',
  'conventions:get',
  'conventions:reference',
  'conventions:rule-add',
  'conventions:rule-remove',
  'conventions:mute',
  'conventions:seen',
  'crew:design',
  'team:plan',
  'team:plan-from-parts',
  'prompt-guide:readiness',
  'prompt-guide:refine',
  'prompt-guide:refine-prompt',
  'studio:readiness',
  'equalizer:screens',
  'equalizer:run',
  'equalizer:image',
  'design:openpencil-status',
  'design:openpencil-save',
  'design:openpencil-test',
  'studio:projects-list',
  'studio:project-archive',
  'studio:project-remove',
  'studio:project-link',
  'studio:project-folder',
  'studio:project-launch',
  'studio:interview-read',
  'studio:interview-start',
  'studio:interview-answer',
  'studio:interview-correct',
  'studio:interview-assumption',
  'studio:interview-assumed-topics',
  'studio:interview-topic-ask',
  'studio:interview-finish',
  'studio:interview-confirm',
  'studio:interview-reopen',
  'studio:interview-reset',
  'studio:interview-extend',
  'studio:interview-resume',
  'studio:interview-draft',
  'studio:artifacts-read',
  'studio:artifacts-files',
  'studio:artifacts-text',
  'studio:brief-export',
  'studio:artifacts-save',
  'studio:style-refs-read',
  'studio:style-refs-add',
  'studio:style-refs-remove',
  'studio:style-refs-describe',
  'studio:artifacts-generate',
  'studio:artifacts-generate-all',
  'studio:artifacts-generate-selected',
  'studio:artifacts-mark-edited',
  'studio:board-read',
  'import:scan',
  'import:add-cards',
  'studio:board-plan',
  'studio:board-arrange',
  'studio:board-next',
  'studio:board-move',
  'studio:board-review',
  'studio:board-acceptance-rule',
  'studio:board-route',
  'studio:board-claim',
  'studio:board-check-ui',
  'studio:board-team-plan',
  'studio:guide-read',
  'studio:guide-explain',
  'studio:board-work',
  'autopilot:start',
  'autopilot:stop',
  'autopilot:status',
  'autopilot:requeue',
  'autopilot:interrupted',
  'autopilot:audit',
  'autopilot:interrupted-resume',
  'autopilot:interrupted-release',
  'auto:start',
  'auto:stop',
  'auto:status',
  'auto:pause',
  'auto:resume',
  'architect:run',
  'architect:stop',
  'architect:answer',
  'architect:status',
  'architect:ready',
  'studio:design-pull',
  'studio:design-read',
  'studio:design-status',
  'studio:design-build-step',
  'studio:design-chat',
  'studio:design-screenshot',
  'studio:board-repair-routes',
  'studio:design-build-cancel',
  'studio:design-page-rename',
  'studio:design-page-delete',
  'studio:plan-chat',
  'studio:plan-apply',
  'team:start',
  'team:record',
  'team:clear-record',
  'schedules:list',
  'schedules:save',
  'schedules:delete',
  'schedules:run-now',
  'evals:list',
  'evals:save-case',
  'evals:delete-case',
  'evals:run',
  'scorecards:summary',
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
  'composer-queue:load',
  'composer-queue:add',
  'composer-queue:claim',
  'composer-queue:update',
  'composer-queue:hold-all',
  'composer-queue:remove-conversation',
  'prompt-presets:list',
  'prompt-presets:save',
  'prompt-presets:delete',
  'conversations:get',
  'conversations:create',
  'conversations:compact',
  'conversations:save',
  'conversations:delete',
  'conversations:fork',
  'conversations:rewind',
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
  'agents:interject',
  'agents:cancel',
  'agents:pause',
  'agents:resume',
  'agents:sign-in',
  'agents:install',
  'agents:approval-response',
  'agents:api-capability',
  'context:preview',
  'preview:info',
  'preview:status',
  'preview:start',
  'preview:stop',
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
  'setup:agent-config-preview',
  'setup:agent-config-import',
  'setup:guide-answer',
  'terminal:start',
  'terminal:write',
  'terminal:resize',
  'terminal:stop',
  'terminal:buffer',
  'plan:read',
  'git:overview',
  'git:init',
  'git:stage',
  'git:commit',
  'git:checkout',
  'git:create-branch',
  'git:create-repository',
  'git:github-status',
  'git:sync',
  'git:pull-team-branch',
  'git:clone-team-repository',
  'git:diff',
  'git:blame',
  'git:changes',
  'files:todos',
  'review:change',
  'review:changes',
  'experiences:count',
  'experiences:suggestions',
  'experiences:suggestions:review',
  'experiences:export',
  'experiences:clear',
  'git:pull-request',
  'verification:overview',
  'verification:run',
  'recovery:list',
  'recovery:recap',
  'recovery:resume',
  'recovery:discard',
  // The escape hatch for a run the renderer can no longer control: stops every live run and clears the records
  // that dead runs left behind. Deliberately desktop-only, so it is absent from the remote gateway's allowlist.
  'runs:stop-all',
  'diagnostics:report',
  'diagnostics:data-locations',
  'projects:knowledge',
  'diagnostics:recent-logs',
  'window:state',
  'playwright:viewport-status',
  'playwright:viewport-repair',
  'window:new',
  'window:title-bar-overlay',
  'remote:status',
  'remote:windows',
  'remote:devices',
  'remote:pair-device',
  'remote:revoke-device',
  // The phone's own reads. Kept apart from the `remote:*` settings channels above, which belong to the
  // desktop panel: these exist only so a paired phone can see a section the console shows.
  'remote:tasks',
] as const;

export type IpcChannel = (typeof ipcChannels)[number];

const emptyInputSchema = z.object({}).strict();

export const ipcInputSchemas = {
  'app:get-bootstrap': emptyInputSchema,
  'projects:choose': emptyInputSchema,
  'projects:open': z.object({ id: z.string().min(1) }).strict(),
  'projects:remove': z.object({ id: z.string().min(1) }).strict(),
  'projects:clear': emptyInputSchema,
  'settings:get': emptyInputSchema,
  'settings:update': z
    .object({
      defaultAgent: agentIdSchema.optional(),
      defaultRoute: routeModeSchema.optional(),
      defaultAutonomy: autonomyModeSchema.optional(),
      experienceLevel: experienceLevelSchema.optional(),
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
      webSearch: webSearchSettingsSchema.partial().strict().optional(),
      experienceCapture: experienceCaptureSettingsSchema.partial().strict().optional(),
      promptGuide: promptGuideSettingsSchema.partial().strict().optional(),
      editor: z
        .object({
          autoSave: z.boolean().optional(),
          autoSaveDelayMs: z.number().int().min(300).max(10_000).optional(),
          formatOnSave: z.boolean().optional(),
          bracketColors: z.boolean().optional(),
          guides: z.boolean().optional(),
          stickyScroll: z.boolean().optional(),
          ligatures: z.boolean().optional(),
          smoothScrolling: z.boolean().optional(),
          minimap: z.boolean().optional(),
          wordWrap: z.boolean().optional(),
          errorLens: z.boolean().optional(),
          gitBlame: z.boolean().optional(),
          todoHighlight: z.boolean().optional(),
          colorSwatches: z.boolean().optional(),
          linkedTagEditing: z.boolean().optional(),
          inlayHints: z.boolean().optional(),
          fileIcons: z.boolean().optional(),
          changeBars: z.boolean().optional(),
        })
        .strict()
        .optional(),
      cognitive1: cognitive1ServiceSettingsSchema.partial().strict().optional(),
      proxy: proxyServiceSettingsSchema.partial().strict().optional(),
      remote: remoteAccessSettingsSchema.partial().strict().optional(),
      usageBudget: usageBudgetSchema.partial().strict().optional(),
      notifications: notificationSettingsSchema.partial().strict().optional(),
      updates: updateSettingsSchema.partial().strict().optional(),
      agentModels: z.record(agentIdSchema, cliModelNameSchema).optional(),
      cliApiKeys: z.record(agentIdSchema, z.boolean()).optional(),
      autoModel: autoModelSettingsSchema.optional(),
      agentTeam: agentTeamSchema.optional(),
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
  'web-search:test': z
    .object({
      source: webSearchSourceSchema,
      endpoint: z.string().url(),
      credentialId: z.string().max(200),
    })
    .strict(),
  'catalog:list': emptyInputSchema,
  'catalog:install': connectorInstallInputSchema,
  'services:status': emptyInputSchema,
  'services:start': z.object({ kind: serviceKindSchema }).strict(),
  'services:stop': z.object({ kind: serviceKindSchema }).strict(),
  'services:restart': z.object({ kind: serviceKindSchema }).strict(),
  'services:rotate-token': z.object({ kind: serviceKindSchema }).strict(),
  'services:copy-token': z.object({ kind: serviceKindSchema }).strict(),
  'brain:overview': emptyInputSchema,
  'brain:mirror-now': brainMirrorInputSchema,
  'brain:search': brainSearchInputSchema,
  'brain:update-field': brainFieldUpdateInputSchema,
  'brain:import': emptyInputSchema,
  'brain:git-status': emptyInputSchema,
  'brain:git-sync': z.object({ action: z.enum(['init', 'commit', 'pull', 'push']) }).strict(),
  'cognitive1:tool': cognitive1McpToolInputSchema,
  'cognitive1:operation': cognitive1OperationInputSchema,
  'rules:get': emptyInputSchema,
  'rules:save': executionRuleSaveInputSchema,
  'rules:inject-projects': emptyInputSchema,
  'permission-rules:suggest': z.object({ projectId: z.string().min(1) }).strict(),
  'skills:list': z.object({ projectId: z.string().min(1).optional() }).strict(),
  'skills:bundle-content': capabilityBundleSkillsInputSchema,
  'files:choose': z.object({ projectId: z.string().min(1) }).strict(),
  'files:search': contextSearchInputSchema,
  'files:tree': z.object({ projectId: z.string().min(1) }).strict(),
  'files:read': fileReadInputSchema,
  'files:image': filePathInputSchema,
  'mockup:inline': z.object({ html: z.string().min(1).max(2_000_000) }).strict(),
  'mockup:file': filePathInputSchema,
  'files:write': fileWriteInputSchema,
  'files:changed': fileChangedInputSchema,
  'files:delete': filePathInputSchema,
  'files:rename': fileRenameInputSchema,
  'files:folder': filePathInputSchema,
  'files:reveal': filePathInputSchema,
  'editor:update-document': editorDocumentStateSchema,
  'editor:remove-document': editorDocumentRemoveSchema,
  'editor:update-window': editorWindowSnapshotSchema,
  'learning:understood': z.object({ projectId: z.string().min(1), lessonId: z.string().min(1) }).strict(),
  'learning:record-check-evidence': learningCheckEvidenceInputSchema,
  'learning:explain-back': learningExplainBackInputSchema,
  'learning:explain-back-help': learningExplainBackHelpInputSchema,
  'learning:progress': z.object({ projectId: z.string().min(1) }).strict(),
  'learning:readiness': emptyInputSchema,
  'learning:update-preferences': learningPreferencesInputSchema,
  'learning:evaluate': learningTutorRequestSchema,
  'learning:cancel': z.object({ requestId: z.string().min(1) }).strict(),
  'learning:record-lesson': learningLessonRecordInputSchema,
  'learning:teaching-library': emptyInputSchema,
  'learning:save-teaching-entry': teachingLibrarySaveInputSchema,
  'learning:delete-teaching-entry': teachingLibraryEntryInputSchema,
  'learning:reset-teaching-entry': teachingLibraryEntryInputSchema,
  'learning:generate-teaching-draft': teachingDraftGenerateInputSchema,
  'learning:security-findings': emptyInputSchema,
  'learning:save-security-finding': securityFindingSaveInputSchema,
  'learning:update-security-finding-status': securityFindingStatusUpdateInputSchema,
  'learning:security-scan': securityScanInputSchema,
  'code:format': codeFormatInputSchema,
  'code:install-formatter': codeInstallFormatterInputSchema,
  'code:guide-read': studioProjectInputSchema,
  'code:guide-explain': studioProjectInputSchema,
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
  'crew:list': z.object({ projectId: z.string().min(1).optional() }).strict(),
  'crew:start': crewStartInputSchema,
  'crew:approve': crewControlInputSchema,
  'crew:answer': crewAnswerInputSchema,
  'crew:pause': crewControlInputSchema,
  'crew:resume': crewControlInputSchema,
  'crew:stop': crewControlInputSchema,
  'crew:defaults': z.object({ projectId: z.string().min(1).optional() }).strict(),
  'crew:save-defaults': crewDefaultsInputSchema,
  'conventions:get': conventionsGetInputSchema,
  'conventions:reference': conventionsReferenceInputSchema,
  'conventions:rule-add': conventionsRuleAddInputSchema,
  'conventions:rule-remove': conventionsRuleRemoveInputSchema,
  'conventions:mute': conventionsMuteInputSchema,
  'conventions:seen': emptyInputSchema,
  'crew:design': crewDesignInputSchema,
  'team:plan': teamPlanInputSchema,
  'team:plan-from-parts': teamPlanFromPartsInputSchema,
  'prompt-guide:readiness': emptyInputSchema,
  'prompt-guide:refine': promptGuideInputSchema,
  'prompt-guide:refine-prompt': promptRefineInputSchema,
  'studio:readiness': emptyInputSchema,
  'equalizer:screens': equalizerScreensInputSchema,
  'equalizer:run': equalizerRunInputSchema,
  'equalizer:image': equalizerImageInputSchema,
  'design:openpencil-status': emptyInputSchema,
  'design:openpencil-save': openPencilSaveInputSchema,
  'design:openpencil-test': emptyInputSchema,
  'studio:projects-list': emptyInputSchema,
  'studio:project-archive': studioProjectArchiveInputSchema,
  'studio:project-remove': interviewProjectInputSchema,
  'studio:project-link': z.object({ projectId: z.string().min(1), linkedProjectId: z.string().min(1).nullable() }).strict(),
  'studio:project-folder': studioProjectFolderInputSchema,
  'studio:project-launch': studioProjectLaunchInputSchema,
  'studio:interview-read': interviewProjectInputSchema,
  'studio:interview-start': interviewStartInputSchema,
  'studio:interview-answer': interviewAnswerInputSchema,
  'studio:interview-correct': interviewCorrectionInputSchema,
  'studio:interview-assumption': interviewAssumptionInputSchema,
  'studio:interview-assumed-topics': interviewProjectInputSchema,
  'studio:interview-topic-ask': interviewTopicAskInputSchema,
  'studio:interview-finish': interviewProjectInputSchema,
  'studio:interview-confirm': interviewProjectInputSchema,
  'studio:interview-reopen': interviewProjectInputSchema,
  'studio:interview-reset': interviewProjectInputSchema,
  'studio:interview-extend': interviewProjectInputSchema,
  'studio:interview-resume': interviewProjectInputSchema,
  'studio:interview-draft': interviewDraftInputSchema,
  'studio:artifacts-read': studioProjectInputSchema,
  'studio:artifacts-files': studioProjectInputSchema,
  'studio:artifacts-text': studioArtifactInputSchema,
  'studio:brief-export': studioProjectInputSchema,
  'studio:artifacts-save': studioArtifactSaveInputSchema,
  'studio:style-refs-read': studioProjectInputSchema,
  'studio:style-refs-add': studioStyleReferenceAddInputSchema,
  'studio:style-refs-remove': studioStyleReferenceRemoveInputSchema,
  'studio:style-refs-describe': studioProjectInputSchema,
  'studio:artifacts-generate': studioArtifactInputSchema,
  'studio:artifacts-generate-all': studioProjectInputSchema,
  'studio:artifacts-generate-selected': studioArtifactsGenerateSelectedInputSchema,
  'studio:artifacts-mark-edited': studioArtifactInputSchema,
  'studio:board-read': studioProjectInputSchema,
  'import:scan': importScanInputSchema,
  'import:add-cards': importAddCardsInputSchema,
  'studio:board-plan': studioProjectInputSchema,
  'studio:board-arrange': studioProjectInputSchema,
  'studio:board-next': studioProjectInputSchema,
  'studio:board-move': studioBoardMoveInputSchema,
  'studio:board-review': boardCardReviewInputSchema,
  'studio:board-acceptance-rule': studioBoardAcceptanceInputSchema,
  'studio:board-route': studioBoardRouteInputSchema,
  'studio:board-claim': studioBoardClaimInputSchema,
  'studio:board-check-ui': studioBoardCardInputSchema,
  'studio:board-team-plan': studioProjectInputSchema,
  'studio:guide-read': studioProjectInputSchema,
  'studio:guide-explain': studioProjectInputSchema,
  'studio:board-work': studioBoardWorkInputSchema,
  'autopilot:start': autopilotStartInputSchema,
  'autopilot:stop': autopilotProjectInputSchema,
  'autopilot:status': autopilotProjectInputSchema,
  'autopilot:requeue': autopilotProjectInputSchema,
  'autopilot:interrupted': emptyInputSchema,
  'autopilot:audit': autopilotAuditInputSchema,
  'autopilot:interrupted-resume': autopilotInterruptedInputSchema,
  'autopilot:interrupted-release': autopilotInterruptedInputSchema,
  'auto:start': autoStartInputSchema,
  'auto:stop': autoConversationInputSchema,
  'auto:status': autoConversationInputSchema,
  'auto:pause': autoConversationInputSchema,
  'auto:resume': autoConversationInputSchema,
  'architect:run': architectRunInputSchema,
  'architect:stop': architectConversationInputSchema,
  'architect:answer': architectAnswerInputSchema,
  'architect:status': architectConversationInputSchema,
  'architect:ready': architectReadinessInputSchema,
  'studio:design-pull': studioDesignPullInputSchema,
  'studio:design-read': studioProjectInputSchema,
  'studio:design-status': studioProjectInputSchema,
  'studio:design-build-step': studioDesignBuildStepInputSchema,
  'studio:design-chat': studioDesignChatInputSchema,
  'studio:design-screenshot': studioDesignScreenshotInputSchema,
  'studio:board-repair-routes': studioRouteRepairInputSchema,
  'studio:design-build-cancel': studioDesignBuildCancelInputSchema,
  'studio:design-page-rename': studioDesignPageRenameInputSchema,
  'studio:design-page-delete': studioDesignPageDeleteInputSchema,
  'studio:plan-chat': studioPlanChatInputSchema,
  'studio:plan-apply': studioPlanApplyInputSchema,
  'team:start': teamStartInputSchema,
  'team:record': teamRecordQuerySchema,
  'team:clear-record': z.object({}).strict(),
  'schedules:list': scheduleListInputSchema,
  'schedules:save': scheduleInputSchema,
  'schedules:delete': scheduleIdInputSchema,
  'schedules:run-now': scheduleIdInputSchema,
  'evals:list': evalListInputSchema,
  'evals:save-case': evalCaseInputSchema,
  'evals:delete-case': evalCaseDeleteInputSchema,
  'evals:run': evalRunInputSchema,
  'scorecards:summary': z.object({}).strict(),
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
  'composer-queue:load': z.object({ legacy: composerQueueSchema.optional() }).strict(),
  'composer-queue:add': composerQueueAddInputSchema,
  'composer-queue:claim': composerQueueClaimInputSchema,
  'composer-queue:update': composerQueueUpdateInputSchema,
  'composer-queue:hold-all': composerQueueHoldInputSchema,
  'composer-queue:remove-conversation': composerQueueConversationInputSchema,
  'prompt-presets:list': emptyInputSchema,
  'prompt-presets:save': promptPresetSaveInputSchema,
  'prompt-presets:delete': promptPresetDeleteInputSchema,
  'conversations:get': z.object({ id: z.string().min(1) }).strict(),
  'conversations:create': z.object({ projectId: z.string().nullable(), firstPrompt: z.string().max(20_000) }).strict(),
  'conversations:compact': z.object({ conversationId: z.string().min(1) }).strict(),
  'conversations:save': conversationRecordV1Schema,
  'conversations:delete': z.object({ id: z.string().min(1) }).strict(),
  'conversations:fork': conversationForkInputSchema,
  'conversations:rewind': conversationRewindInputSchema,
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
  // Chips travel with a steer for the same reason they travel with a send: an image, a selection or terminal output
  // attached beside the words is part of what the person said, and a message that dropped them would answer a
  // different question than the one asked.
  'agents:interject': z
    .object({
      conversationId: z.string().min(1),
      text: z.string().min(1).max(20_000),
      contextChips: z.array(contextChipSchema).max(50).optional(),
    })
    .strict(),
  'agents:cancel': agentCancelInputSchema,
  'agents:pause': agentCancelInputSchema,
  'agents:resume': agentCancelInputSchema,
  'agents:sign-in': agentSignInInputSchema,
  'agents:install': agentSignInInputSchema,
  'agents:approval-response': agentApprovalResponseInputSchema,
  'agents:api-capability': emptyInputSchema,
  'context:preview': contextPreviewInputSchema,
  'preview:info': previewProjectInputSchema,
  'preview:status': previewProjectInputSchema,
  'preview:start': previewStartInputSchema,
  'preview:stop': previewProjectInputSchema,
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
  'setup:agent-config-preview': emptyInputSchema,
  'setup:agent-config-import': z.object({ agent: z.enum(['codex', 'claude']) }).strict(),
  'setup:guide-answer': setupGuideAnswerInputSchema,
  'terminal:start': terminalStartInputSchema,
  'terminal:write': terminalWriteInputSchema,
  'terminal:resize': terminalResizeInputSchema,
  'terminal:stop': terminalStopInputSchema,
  'terminal:buffer': terminalBufferInputSchema,
  'plan:read': z.object({ projectId: z.string().min(1), conversationId: z.string().min(1) }).strict(),
  'git:overview': z.object({ projectId: z.string().min(1) }).strict(),
  'git:init': z.object({ projectId: z.string().min(1) }).strict(),
  'git:stage': gitStageInputSchema,
  'git:commit': gitCommitInputSchema,
  'git:checkout': gitCheckoutInputSchema,
  'git:create-branch': gitCreateBranchInputSchema,
  'git:create-repository': gitCreateRepositoryInputSchema,
  'git:github-status': z.object({ projectId: z.string().min(1) }).strict(),
  'git:sync': gitSyncInputSchema,
  'git:pull-team-branch': gitTeamBranchInputSchema,
  'git:clone-team-repository': gitTeamCloneInputSchema,
  'git:diff': gitDiffInputSchema,
  'git:blame': gitBlameInputSchema,
  'git:changes': gitBlameInputSchema,
  'files:todos': todoScanInputSchema,
  'review:change': z.object({ request: z.string().max(4_000), diff: z.string().max(100_000), mode: z.enum(['novice', 'intermediate', 'expert']) }).strict(),
  'review:changes': reviewChangesInputSchema,
  'experiences:count': emptyInputSchema,
  'experiences:suggestions': emptyInputSchema,
  'experiences:suggestions:review': memoryImprovementSuggestionReviewInputSchema,
  'experiences:export': emptyInputSchema,
  'experiences:clear': emptyInputSchema,
  'git:pull-request': gitPullRequestInputSchema,
  'verification:overview': z.object({ projectId: z.string().min(1) }).strict(),
  'verification:run': verificationRunInputSchema,
  'recovery:list': emptyInputSchema,
  'recovery:recap': z.object({ conversationId: z.string().min(1) }).strict(),
  'recovery:resume': z.object({ conversationId: z.string().min(1) }).strict(),
  'recovery:discard': z.object({ conversationId: z.string().min(1) }).strict(),
  'runs:stop-all': emptyInputSchema,
  'diagnostics:report': z.object({ copy: z.boolean() }).strict(),
  'diagnostics:data-locations': emptyInputSchema,
  'projects:knowledge': z.object({ projectId: z.string().min(1) }).strict(),
  'diagnostics:recent-logs': z.object({ count: z.number().int().min(1).max(1000).optional() }).strict(),
  'window:state': emptyInputSchema,
  'playwright:viewport-status': emptyInputSchema,
  'playwright:viewport-repair': emptyInputSchema,
  'window:new': z.object({ projectId: z.string().min(1).optional() }).strict(),

  // The window's title-bar controls are drawn by the operating system, not by the page, so they cannot be styled by
  // CSS: their colours are set on the window itself and have to be pushed here whenever the theme changes. Hex only,
  // because that is what the overlay accepts.
  'window:title-bar-overlay': z
    .object({
      color: z.string().regex(/^#[0-9a-f]{6}$/i),
      symbolColor: z.string().regex(/^#[0-9a-f]{6}$/i),
    })
    .strict(),
  'remote:status': emptyInputSchema,
  'remote:windows': emptyInputSchema,
  'remote:devices': emptyInputSchema,
  'remote:pair-device': remotePairDeviceInputSchema,
  'remote:revoke-device': z.object({ id: z.string().min(1) }).strict(),
  'remote:tasks': remoteTasksInputSchema,
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
export const executionRuleInjectionReportResponseSchema = executionRuleInjectionReportSchema;
export const skillSummaryListResponseSchema = z.array(skillSummarySchema);
export const capabilityBundleSkillsResponseSchema = z.array(capabilityBundleSkillSchema);
export const selectedFilesResponseSchema = z.array(z.string().min(1));
export const gitDiffStatResponseSchema = gitDiffStatResultSchema;
export const attachmentResultSchema = contextChipSchema;
export const workflowTemplateListResponseSchema = z.array(workflowTemplateSchema);
export const workflowRunListResponseSchema = z.array(workflowRunSchema);
export const teamPlanResponseSchema = teamPlanDraftSchema;
export const promptRefineResponseSchema = promptRefineResultSchema;
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
export const memoryImprovementSuggestionsResponseSchema = z.array(memoryImprovementSuggestionSchema);
export const agentRunResponseSchema = agentRunResultSchema;
export const agentCancelResponseSchema = z.boolean();
export const agentSignInResponseSchema = agentSignInResultSchema;
export const directApiCapabilityResponseSchema = directApiCapabilitySchema;
export const providerModelCatalogResponseSchema = providerModelCatalogSchema;
export const webSearchTestResponseSchema = webSearchTestResultSchema;
export const conversationBranchResultResponseSchema = conversationBranchResultSchema;
export const connectorCatalogResponseSchema = z.array(connectorCatalogEntrySchema);
export const contextPreviewResponseSchema = contextPreviewSchema;
export const usageSummaryResponseSchema = usageSummarySchema;
export const projectFileTreeResponseSchema = projectFileTreeSchema;
export const openedFileResponseSchema = openedFileSchema;
export const writtenFileResponseSchema = writtenFileSchema;
export const learningProgressResponseSchema = learningProgressSchema;
export const learningReadinessResponseSchema = learningReadinessSchema;
export const learningEvaluationResponseSchema = learningEvaluationResultSchema;
export const learningExplainBackResponseSchema = learningExplainBackResultSchema;
export const learningExplainBackHelpResponseSchema = learningExplainBackHelpSchema;
export const learningLessonRecordResponseSchema = learningLessonRecordResultSchema;
export const teachingLibraryResponseSchema = teachingLibrarySchema;
export const teachingDraftResponseSchema = teachingDraftSchema;
export const securityFindingsResponseSchema = z.array(securityFindingSchema);
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
export const gitCreateRepositoryResponseSchema = gitCreateRepositoryResultSchema;
export const gitGithubStatusResponseSchema = gitGithubStateSchema;
export const verificationOverviewResponseSchema = verificationOverviewSchema;
export const verificationRunResponseSchema = verificationRunSchema;
export const recoveryListResponseSchema = recoveryListingSchema;
export const recoveryRecapResponseSchema = recoveryRecapSchema;
export const recoveryResumeResponseSchema = recoveryResumeSchema;
export const stopAllRunsResponseSchema = stopAllRunsResultSchema;
export const studioArtifactsResponseSchema = studioArtifactsSchema;
export const studioArtifactsGenerationResponseSchema = studioArtifactsGenerationResultSchema;
export const studioPlanChatResponseSchema = studioPlanChatResultSchema;
export const studioPlanApplyResponseSchema = studioPlanApplyResultSchema;
export const studioProjectSummariesResponseSchema = z.array(studioProjectSummarySchema);
export const studioProjectFolderResponseSchema = studioProjectFolderResultSchema;
export const studioProjectLaunchResponseSchema = studioProjectLaunchResultSchema;
export const studioBoardResponseSchema = studioBoardSchema;
/** A project's task plan, or null when it has none. */
export const planResponseSchema = planSchema.nullable();
export const studioBoardCardResponseSchema = boardCardSchema.nullable();
export const studioUiCheckResponseSchema = studioUiCheckResultSchema;
export const studioDesignResponseSchema = studioDesignSchema;
export const studioDesignChatResponseSchema = studioDesignChatResultSchema;
export const studioDesignScreenshotResponseSchema = studioDesignScreenshotResultSchema;
export const studioRouteRepairResponseSchema = studioRouteRepairResultSchema;
export const studioDesignPullResponseSchema = studioDesignPullSchema;
export const studioDesignBuildStepResponseSchema = studioDesignBuildStepResultSchema;
/** The cards one "work the board" run touched, in the order they ran. */
export const studioBoardWorkResponseSchema = z.array(boardCardSchema);
export const autopilotResponseSchema = autopilotStatusResponseSchema;
export const autopilotInterruptedResponseSchema = z.array(autopilotRunRecordSchema);
export const autopilotAuditResponseSchema = z.array(autopilotAuditEntrySchema);
export const brainMirrorResponseSchema = brainMirrorOutcomeSchema;
export const conversationCompactionResponseSchema = conversationRecordV1Schema;
export const editorSavedDocumentResponseSchema = z.array(editorSavedDocumentSchema);
export const remoteStatusResponseSchema = remoteAccessStatusSchema;
export const remoteWindowsResponseSchema = z.array(remoteWindowSummarySchema);
export const remoteTokenResponseSchema = remoteTokenResultSchema;
export const remoteDeviceListResponseSchema = z.array(remoteDeviceSchema);

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
  /** Electron webContents id; scopes renderer-only drafts and tabs to this window. */
  windowId: number;
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
  experienceLevel?: AppSettings['experienceLevel'];
  theme?: AppSettings['theme'];
  logRetentionEntries?: number;
  diagnosticsEnabled?: boolean;
  mcpServers?: AppSettings['mcpServers'];
  directApi?: Partial<AppSettings['directApi']>;
  webSearch?: Partial<AppSettings['webSearch']>;
  learningTutor?: Partial<AppSettings['learningTutor']>;
  experienceCapture?: Partial<AppSettings['experienceCapture']>;
  promptGuide?: Partial<AppSettings['promptGuide']>;
  editor?: Partial<AppSettings['editor']>;
  cognitive1?: Partial<AppSettings['cognitive1']>;
  proxy?: Partial<AppSettings['proxy']>;
  remote?: Partial<AppSettings['remote']>;
  usageBudget?: Partial<AppSettings['usageBudget']>;
  notifications?: Partial<AppSettings['notifications']>;
  updates?: Partial<AppSettings['updates']>;
  agentModels?: AppSettings['agentModels'];
  cliApiKeys?: AppSettings['cliApiKeys'];
  autoModel?: AppSettings['autoModel'];
  agentTeam?: AppSettings['agentTeam'];
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
  /** Forgets every project in the list. The folders themselves are untouched. */
  clearProjects(): Promise<IpcResponse<BootstrapPayload>>;
  getSettings(): Promise<IpcResponse<AppSettings>>;
  updateSettings(update: SettingsUpdate): Promise<IpcResponse<AppSettings>>;
  onSharedDesktopState(listener: (state: SharedDesktopState) => void): () => void;
  onPlaywrightViewportStatus(listener: (status: PlaywrightViewportStatus) => void): () => void;
  playwrightViewportStatus(): Promise<IpcResponse<PlaywrightViewportStatus>>;
  repairPlaywrightViewport(): Promise<IpcResponse<PlaywrightViewportStatus>>;
  loadComposerQueue(legacy?: ComposerQueue): Promise<IpcResponse<ComposerQueue>>;
  addQueuedPrompt(item: QueuedPrompt, first?: boolean): Promise<IpcResponse<ComposerQueue>>;
  claimQueuedPrompt(conversationId: string, id: string): Promise<IpcResponse<{ claimed: boolean; queue: ComposerQueue }>>;
  updateQueuedPrompt(input: z.infer<typeof composerQueueUpdateInputSchema>): Promise<IpcResponse<ComposerQueue>>;
  holdQueuedPrompts(error: string): Promise<IpcResponse<ComposerQueue>>;
  removeQueuedConversation(conversationId: string): Promise<IpcResponse<ComposerQueue>>;
  onComposerQueueChanged(listener: (queue: ComposerQueue) => void): () => void;
  listPromptPresets(): Promise<IpcResponse<PromptPresetList>>;
  savePromptPreset(slot: number, label: string, text: string): Promise<IpcResponse<PromptPresetList>>;
  deletePromptPreset(slot: number): Promise<IpcResponse<PromptPresetList>>;
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
  injectRulesIntoProjects(): Promise<IpcResponse<ExecutionRuleInjectionReport>>;
  listSkills(projectId?: string): Promise<IpcResponse<SkillSummary[]>>;
  readCapabilityBundleSkills(request: { projectId: string; names: string[] }): Promise<IpcResponse<CapabilityBundle['skills']>>;
  chooseFiles(projectId: string): Promise<IpcResponse<string[]>>;
  searchFiles(request: ContextSearchInput): Promise<IpcResponse<string[]>>;
  suggestPermissionRules(projectId: string): Promise<IpcResponse<PermissionRule[]>>;
  projectFileTree(projectId: string): Promise<IpcResponse<ProjectFileTree>>;
  readProjectFile(projectId: string, path: string): Promise<IpcResponse<OpenedFile>>;
  /** Where a sandboxed, running copy of an HTML mockup can be framed (an agent's design in HTML, CSS and script). */
  publishInlineMockup(html: string): Promise<IpcResponse<{ url: string }>>;
  publishProjectMockup(projectId: string, path: string): Promise<IpcResponse<{ url: string }>>;
  /** A picture inside the project as a `data:` URL, for showing mockups the agent saved. */
  readProjectImage(projectId: string, path: string): Promise<IpcResponse<{ dataUrl: string; mime: string; size: number }>>;
  writeProjectFile(request: FileWriteInput): Promise<IpcResponse<WrittenFile>>;
  /** Deletes one file or folder, after the renderer has confirmed it. */
  deleteProjectPath(request: FilePathInput): Promise<IpcResponse<FileMutationResult>>;
  /** Renames or moves a file or folder inside the project. */
  renameProjectPath(request: FileRenameInput): Promise<IpcResponse<FileMutationResult>>;
  /** Creates a folder, including any missing parents. */
  createProjectFolder(request: FilePathInput): Promise<IpcResponse<FileMutationResult>>;
  /** Shows the file or folder in the operating system's file manager. */
  revealProjectPath(request: FilePathInput): Promise<IpcResponse<{ revealed: boolean }>>;
  projectFileChanged(projectId: string, path: string, expectedHash: string): Promise<IpcResponse<boolean>>;
  updateEditorDocument(document: EditorDocumentState): Promise<IpcResponse<boolean>>;
  removeEditorDocument(document: EditorDocumentRemove): Promise<IpcResponse<boolean>>;
  updateEditorWindow(snapshot: EditorWindowSnapshot): Promise<IpcResponse<boolean>>;
  onEditorDocumentsSaved(listener: (documents: EditorSavedDocument[]) => void): () => void;
  markLearningUnderstood(projectId: string, lessonId: string): Promise<IpcResponse<LearningProgress>>;
  recordLearningCheckEvidence(input: LearningCheckEvidenceInput): Promise<IpcResponse<LearningProgress>>;
  explainLearningBack(input: LearningExplainBackInput): Promise<IpcResponse<LearningExplainBackResult>>;
  explainLearningBackHelp(input: LearningExplainBackHelpInput): Promise<IpcResponse<LearningExplainBackHelp>>;
  learningProgress(projectId: string): Promise<IpcResponse<LearningProgress>>;
  learningReadiness(): Promise<IpcResponse<LearningReadiness>>;
  updateLearningPreferences(input: LearningPreferencesInput): Promise<IpcResponse<LearningProgress>>;
  evaluateLearning(request: LearningTutorRequest): Promise<IpcResponse<LearningEvaluationResult>>;
  cancelLearning(requestId: string): Promise<IpcResponse<boolean>>;
  recordLearningLesson(input: LearningLessonRecordInput): Promise<IpcResponse<LearningLessonRecordResult>>;
  teachingLibrary(): Promise<IpcResponse<TeachingLibrary>>;
  saveTeachingEntry(input: TeachingLibrarySaveInput): Promise<IpcResponse<TeachingLibrary>>;
  deleteTeachingEntry(input: TeachingLibraryEntryInput): Promise<IpcResponse<TeachingLibrary>>;
  resetTeachingEntry(input: TeachingLibraryEntryInput): Promise<IpcResponse<TeachingLibrary>>;
  generateTeachingDraft(input: TeachingDraftGenerateInput): Promise<IpcResponse<TeachingDraft>>;
  securityFindings(): Promise<IpcResponse<SecurityFinding[]>>;
  saveSecurityFinding(input: SecurityFindingSaveInput): Promise<IpcResponse<SecurityFinding>>;
  updateSecurityFindingStatus(input: SecurityFindingStatusUpdateInput): Promise<IpcResponse<SecurityFinding | null>>;
  /** Runs one audit recipe as a real agent task, then returns the whole findings log. Local only. */
  runSecurityScan(input: SecurityScanInput): Promise<IpcResponse<SecurityScanResult>>;
  formatCode(input: CodeFormatInput): Promise<IpcResponse<CodeFormatResult>>;
  installCodeFormatter(input: CodeInstallFormatterInput): Promise<IpcResponse<{ message: string }>>;
  /**
   * Where this code project is, from the rules alone — the repository, the files, what has been studied, the board.
   * Free, so the strip above the editor can ask whenever anything it reads moves.
   */
  readCodeGuide(projectId: string): Promise<IpcResponse<CodeGuideView>>;
  /**
   * The same, with the walkthrough. Spends only when the stored one no longer fits what is on screen.
   */
  explainCodeGuide(projectId: string): Promise<IpcResponse<CodeGuideView>>;
  gitFileInfo(projectId: string, path: string): Promise<IpcResponse<GitFileInfo>>;
  rejectCheckpointHunks(conversationId: string, turnId: string, filePath: string, hunkIds: number[]): Promise<IpcResponse<CheckpointRestoreResult>>;
  gitDiffStat(projectId: string): Promise<IpcResponse<GitDiffStatResult>>;
  saveAttachment(name: string, dataUrl: string): Promise<IpcResponse<ContextChip>>;
  listWorkflowTemplates(projectId?: string): Promise<IpcResponse<WorkflowTemplate[]>>;
  listWorkflowRuns(projectId?: string): Promise<IpcResponse<WorkflowRun[]>>;
  startWorkflow(request: WorkflowStartInput): Promise<IpcResponse<WorkflowRun>>;
  /** Asks the orchestrator to split a goal into parts and assigns an agent to each. Runs nothing. */
  planTeam(request: TeamPlanInput): Promise<IpcResponse<TeamPlanDraft>>;
  /** Builds a plan from parts the user already has (from the Prompt Guide), skipping the orchestrator. Runs nothing. */
  planTeamFromParts(request: TeamPlanFromPartsInput): Promise<IpcResponse<TeamPlanDraft>>;
  promptGuideReadiness(): Promise<IpcResponse<PromptGuideReadiness>>;
  /** Turns a rough idea into a clear goal, open questions and one prompt per teammate. */
  refineIdea(request: PromptGuideInput): Promise<IpcResponse<PromptGuideResult>>;
  /** Rewrites a composer draft into a clearer prompt without sending it. */
  refinePrompt(request: PromptRefineInput): Promise<IpcResponse<PromptRefineResult>>;
  /** The Project Studio's interview: the step that turns a paragraph into `.kai/spec/brief.md`. */
  studioReadiness(): Promise<IpcResponse<StudioReadiness>>;
  /** Projects created in Studio, whether the discussion is still open or the brief is already written. */
  studioProjects(): Promise<IpcResponse<StudioProjectSummary[]>>;
  setStudioProjectArchived(request: StudioProjectArchiveInput): Promise<IpcResponse<StudioProjectSummary>>;
  deleteStudioProject(projectId: string): Promise<IpcResponse<null>>;
  /** Opens a folder picker and deliberately attaches this Studio plan to the folder the user creates or chooses. */
  chooseStudioProjectFolder(request: StudioProjectFolderInput): Promise<IpcResponse<StudioProjectFolderResult | null>>;
  /** Materialises an independent Studio workspace when needed, then returns the project and composer prompt. */
  launchStudioProject(request: StudioProjectLaunchInput): Promise<IpcResponse<StudioProjectLaunchResult>>;
  studioInterview(projectId: string): Promise<IpcResponse<InterviewState | null>>;
  startStudioInterview(request: InterviewStartInput): Promise<IpcResponse<InterviewState>>;
  /** Records the answers on screen and asks the next round, or writes the brief when there is nothing left to ask. */
  answerStudioInterview(request: InterviewAnswerInput): Promise<IpcResponse<InterviewState>>;
  /** Replaces an answer already given and asks again from that point, dropping the rounds that followed it. */
  correctStudioInterviewAnswer(request: InterviewCorrectionInput): Promise<IpcResponse<InterviewState>>;
  actOnStudioAssumption(request: InterviewAssumptionInput): Promise<IpcResponse<InterviewState>>;
  askStudioAssumedTopics(projectId: string): Promise<IpcResponse<InterviewState>>;
  askStudioTopic(request: InterviewTopicAskInput): Promise<IpcResponse<InterviewState>>;
  finishStudioInterview(projectId: string): Promise<IpcResponse<InterviewState>>;
  /** Writes the reviewed brief after the user confirms the summary. */
  confirmStudioInterview(projectId: string): Promise<IpcResponse<InterviewState>>;
  /** Returns from review to the saved questions and answers. */
  reopenStudioInterview(projectId: string): Promise<IpcResponse<InterviewState>>;
  resetStudioInterview(projectId: string): Promise<IpcResponse<null>>;
  /** Lets the interview ask five more questions, up to twenty in all, for someone who wants to be walked through. */
  extendStudioInterview(projectId: string): Promise<IpcResponse<InterviewState>>;
  /** Retries the step a failed or interrupted model call left pending, without re-asking anything already saved. */
  resumeStudioInterview(projectId: string): Promise<IpcResponse<InterviewState>>;
  /** Keeps answers typed for the open round so they survive leaving the screen. */
  saveStudioInterviewDraft(request: InterviewDraftInput): Promise<IpcResponse<InterviewState>>;
  /** The artifact catalog: what exists under `.kai/spec`, who wrote it, and what went stale. */
  studioArtifacts(projectId: string): Promise<IpcResponse<StudioArtifacts>>;
  /** Every file the studio has written under `.kai/spec`, for a UI that lists real files rather than guesses. */
  studioArtifactFiles(projectId: string): Promise<IpcResponse<string[]>>;
  /** The screens a project can be checked on, from its pages list, and which are already drawn in open-pencil. */
  equalizerScreens(projectId: string): Promise<IpcResponse<EqualizerScreens>>;
  /** Compares built screens with their design and writes a report. It never changes the project. */
  runEqualizer(input: EqualizerRunInput): Promise<IpcResponse<EqualizerReport>>;
  /** One of a report's pictures as a data URL, or null when it is not there. */
  equalizerImage(input: EqualizerImageInput): Promise<IpcResponse<string | null>>;
  /** Progress while a run is under way. */
  onEqualizerProgress(listener: (payload: EqualizerProgress) => void): () => void;
  /** Whether KAI is set up to reach open-pencil. The token is never returned. */
  openPencilStatus(): Promise<IpcResponse<OpenPencilStatus>>;
  /** Saves the open-pencil address and token and turns the connection on or off. */
  saveOpenPencil(input: OpenPencilSaveInput): Promise<IpcResponse<OpenPencilStatus>>;
  /** Asks the editor for its pages, so a wrong address or token is found here and not mid-pull. */
  testOpenPencil(): Promise<IpcResponse<OpenPencilTestResult>>;
  /** One artifact's text, or null when it has not been written yet. */
  studioArtifactText(input: StudioArtifactInput): Promise<IpcResponse<string | null>>;
  /** Saves the reviewed brief (including its coverage table) as a shareable Markdown file. */
  exportStudioBrief(projectId: string): Promise<IpcResponse<{ canceled: boolean; path?: string }>>;
  /** Saves a hand edit of one artifact and flags everything that reads it as stale. */
  saveStudioArtifact(input: StudioArtifactSaveInput): Promise<IpcResponse<StudioArtifacts>>;
  /** The reference images for the project's look, and the description written from them. */
  studioStyleReferences(projectId: string): Promise<IpcResponse<StudioStyleReferences>>;
  addStudioStyleReference(input: StudioStyleReferenceAddInput): Promise<IpcResponse<StudioStyleReferences>>;
  removeStudioStyleReference(input: StudioStyleReferenceRemoveInput): Promise<IpcResponse<StudioStyleReferences>>;
  /** Has a model that can read images describe the references, so the style guide is written from them. */
  describeStudioStyle(projectId: string): Promise<IpcResponse<StudioStyleReferences>>;
  /** Generates one artifact from the artifacts it reads. Runs one model call. */
  generateStudioArtifact(input: StudioArtifactInput): Promise<IpcResponse<StudioArtifacts>>;
  /** Generates every artifact that is missing or stale, in dependency order. Runs one model call per artifact. */
  generateStudioArtifacts(projectId: string): Promise<IpcResponse<StudioArtifacts>>;
  /**
   * Writes only the chosen artifacts, in dependency order. `pages` and `style-guide` fall back to the brief when
   * `stories`, `flows` or `stack` have not been written, which is what makes "just the design" possible.
   */
  generateStudioArtifactsSelected(input: StudioArtifactsGenerateSelectedInput): Promise<IpcResponse<StudioArtifactsGenerationResult>>;
  /** Records a hand edit, so the artifacts that read this one are shown as stale rather than trusted. */
  markStudioArtifactEdited(input: StudioArtifactInput): Promise<IpcResponse<StudioArtifacts>>;
  /** The board of cards built from the stories. */
  studioBoard(projectId: string): Promise<IpcResponse<StudioBoard>>;
  /** Rebuilds the board from the artifacts and the design, keeping the work already done. Runs one model call. */
  planStudioBoard(projectId: string): Promise<IpcResponse<StudioBoard>>;
  /**
   * Points a Studio plan at a folder, or at none at all. Needed when the folder it was linked to is renamed or moved:
   * without it the plan is stranded on a path that no longer exists and there is no way to say where it went.
   */
  linkStudioProject(request: { projectId: string; linkedProjectId: string | null }): Promise<IpcResponse<StudioProjectSummary>>;
  /** Puts an existing board in a sensible build order and sets the dependencies that hold it. Runs one model call. */
  arrangeStudioBoard(projectId: string): Promise<IpcResponse<StudioBoard>>;
  /** The next card an agent should pick up, or null when nothing is ready. */
  nextStudioCard(projectId: string): Promise<IpcResponse<BoardCard | null>>;
  /** Moves a card; `done` is refused unless the check still covers the working tree. */
  moveStudioCard(input: StudioBoardMoveInput): Promise<IpcResponse<BoardCard>>;
  reviewStudioBoardCard(input: BoardCardReviewInput): Promise<IpcResponse<BoardCard>>;
  setStudioBoardAcceptance(input: StudioBoardAcceptanceInput): Promise<IpcResponse<StudioBoard>>;
  /** Sets the route a component or page card is checked at. Without one it can never pass, so it can never be done. */
  setStudioCardRoute(input: StudioBoardRouteInput): Promise<IpcResponse<BoardCard>>;
  /** Reserves a card for one agent, so two agents never take the same one. */
  claimStudioCard(input: StudioBoardClaimInput): Promise<IpcResponse<BoardCard>>;
  /** Runs the visual check on a component or page card: screenshots, tokens, states, keyboard, flow. */
  checkStudioCardUi(projectId: string, cardId: string): Promise<IpcResponse<StudioUiCheckResult>>;
  /** A team plan with one part per `ready` card, for the user to review before anything runs. */
  planStudioTeam(projectId: string): Promise<IpcResponse<TeamPlanDraft>>;
  /**
   * Where the project is, from the rules alone. Free, so the board's strip can ask on every redraw.
   */
  readStudioGuide(projectId: string): Promise<IpcResponse<StudioGuideView>>;
  /**
   * The same, with the explanation. Spends only when the stored one no longer fits what is on screen.
   */
  explainStudioGuide(projectId: string): Promise<IpcResponse<StudioGuideView>>;
  /** Runs ready cards, one agent per card. A card ends in review or blocked, never done. */
  workStudioBoard(request: StudioBoardWorkInput): Promise<IpcResponse<BoardCard[]>>;
  /** Starts Autopilot on a project's board. It keeps going, resting when a provider rate-limits, until the board is done or it is stopped. */
  startAutopilot(request: AutopilotStartInput): Promise<IpcResponse<AutopilotStatus>>;
  stopAutopilot(request: AutopilotProjectInput): Promise<IpcResponse<AutopilotStatus | null>>;
  autopilotStatus(request: AutopilotProjectInput): Promise<IpcResponse<AutopilotStatus | null>>;
  /** Puts the cards a stopped or failed Autopilot run left blocked back in the queue. */
  requeueAutopilot(request: AutopilotProjectInput): Promise<IpcResponse<{ requeued: number }>>;
  /**
   * Runs KAI was closed in the middle of, newest first. An Autopilot run writes one small file while it is going,
   * so anything still there at startup is a run that never got to finish — and the board still holds its card.
   */
  autopilotInterrupted(): Promise<IpcResponse<AutopilotRunRecord[]>>;
  autopilotAudit(request: AutopilotAuditInput): Promise<IpcResponse<AutopilotAuditEntry[]>>;
  /** Starts a recorded run again. The loop takes back the card it was still holding rather than starting a new one. */
  resumeInterruptedAutopilot(request: AutopilotInterruptedInput): Promise<IpcResponse<AutopilotStatus>>;
  /** Puts the card an interrupted run was holding back in the queue, for someone who would rather start clean. */
  releaseInterruptedAutopilot(request: AutopilotInterruptedInput): Promise<IpcResponse<{ released: boolean }>>;
  onAutopilotChanged(listener: (status: AutopilotStatus) => void): () => void;
  /**
   * Starts Auto mode on one composer task. It carries the task across turns until the check command passes, cooling
   * on a burst limit and moving to the API model when the CLI's usage window is spent.
   */
  startAuto(request: AutoStartRequest): Promise<IpcResponse<AutoStatus>>;
  stopAuto(request: AutoConversationInput): Promise<IpcResponse<AutoStatus | null>>;
  autoStatus(request: AutoConversationInput): Promise<IpcResponse<AutoStatus | null>>;
  /** Stops Auto from starting another turn; the turn in flight is left alone. */
  pauseAuto(request: AutoConversationInput): Promise<IpcResponse<AutoStatus | null>>;
  /** Picks a paused Auto back up, re-checking that there is a provider to run on. */
  resumeAuto(request: AutoConversationInput): Promise<IpcResponse<AutoStatus | null>>;
  onAutoChanged(listener: (status: AutoStatus) => void): () => void;
  /**
   * Runs one send through the Architect / Implementer split: the Architect plans, the Implementer builds, the
   * Architect reviews and sends work back until it is right.
   */
  runArchitect(request: ArchitectRunInput): Promise<IpcResponse<ArchitectStatus>>;
  stopArchitect(request: ArchitectConversationInput): Promise<IpcResponse<ArchitectStatus | null>>;
  /** The person's answer to "continue or finish here?" */
  answerArchitect(request: ArchitectAnswerInput): Promise<IpcResponse<ArchitectStatus | null>>;
  architectStatus(request: ArchitectConversationInput): Promise<IpcResponse<ArchitectStatus | null>>;
  /** Whether one role's choice can run right now, and why not when it cannot. */
  architectReady(target: RoleTarget): Promise<IpcResponse<ArchitectReadiness>>;
  onArchitectChanged(listener: (status: ArchitectStatus) => void): () => void;
  /** What KAI last read from open-pencil. */
  studioDesign(projectId: string): Promise<IpcResponse<StudioDesign>>;
  studioDesignStatus(projectId: string): Promise<IpcResponse<StudioDesignStatus>>;
  /** Reads the design from open-pencil: tokens, components, pages, and staleness for the cards it moved. */
  pullStudioDesign(projectId: string, adopt?: boolean): Promise<IpcResponse<StudioDesignPull>>;
  /**
   * Renames one screen in `pages.md` and, when it is drawn, in open-pencil too, so the checklist goes on matching it.
   * The route is left as it was. Answers with the design as it now stands, so the caller need not pull again.
   */
  renameStudioDesignPage(input: StudioDesignPageRenameInput): Promise<IpcResponse<StudioDesignPull>>;
  /**
   * Deletes one screen's page from open-pencil. It cannot be undone from KAI; the screen stays in `pages.md` and
   * reads as still to draw, which is how a page that errored or is named so nothing matches it is cleared.
   */
  deleteStudioDesignPage(input: StudioDesignPageDeleteInput): Promise<IpcResponse<StudioDesignPull>>;
  /**
   * Runs one design-build prompt (the foundation, or one screen) as a real agent turn against open-pencil's own
   * tools, launching the editor first if it is not already running. The caller pulls the design afterward to see
   * what the turn actually drew — this only reports whether the turn itself finished. `stepId` is minted by the
   * caller before this is sent, so `onAgentEvent` can be subscribed to it in time to show the turn's tool calls
   * live, on the same channel a composer run's own events already arrive on.
   */
  buildStudioDesignStep(projectId: string, prompt: string, stepId: string): Promise<IpcResponse<StudioDesignBuildStepResult>>;
  /** Sends a conversational correction to the Design agent, optionally with a screenshot. */
  chatWithStudioDesign(input: StudioDesignChatInput): Promise<IpcResponse<StudioDesignChatResult>>;
  /**
   * One screenshot of a page exactly as open-pencil currently shows it, for the Design tab's per-page preview.
   * Switches the editor to that page first, so this is not instant and not free to call on every keystroke.
   */
  captureStudioDesignScreenshot(input: StudioDesignScreenshotInput): Promise<IpcResponse<StudioDesignScreenshotResult>>;
  /**
   * Explains what a drawn page is, or what is missing from the plan, and answers with a change set. Writes nothing:
   * the person approves the set before `applyStudioPlanChanges` runs it.
   */
  chatWithStudioPlan(input: StudioPlanChatInput): Promise<IpcResponse<StudioPlanChatResult>>;
  /** Which part of the chat turn is running: reading, asking, extracting or done. */
  onStudioPlanProgress(listener: (payload: StudioPlanProgress) => void): () => void;
  /** Applies the approved changes. Each action is independent, so one failure does not discard the rest. */
  applyStudioPlanChanges(input: StudioPlanApplyInput): Promise<IpcResponse<StudioPlanApplyResult>>;
  /** Suggests routes using the page inventory, pulled Open Pencil pages, and project source context. Does not apply them. */
  suggestStudioRouteRepairs(projectId: string): Promise<IpcResponse<StudioRouteRepairResult>>;
  /** Stops the turn one design-build step started. Answers whether a turn was actually running to stop. */
  cancelStudioDesignStep(projectId: string, stepId: string): Promise<IpcResponse<boolean>>;
  /** Redraws the board when a card moves, whichever window or agent moved it. */
  onStudioBoardChanged(listener: (payload: { projectId: string; board: StudioBoard }) => void): () => void;
  /** Starts the approved plan as a workflow, one part at a time. */
  startTeam(request: TeamStartInput): Promise<IpcResponse<WorkflowRun>>;
  teamRecord(request: TeamRecordQuery): Promise<IpcResponse<TeamRecordAdvice[]>>;
  clearTeamRecord(): Promise<IpcResponse<null>>;
  listSchedules(projectId: string): Promise<IpcResponse<Schedule[]>>;
  saveSchedule(request: ScheduleInput): Promise<IpcResponse<Schedule>>;
  deleteSchedule(id: string): Promise<IpcResponse<{ deleted: boolean }>>;
  runScheduleNow(id: string): Promise<IpcResponse<Schedule>>;
  listEvals(projectId: string): Promise<IpcResponse<EvalOverview>>;
  saveEvalCase(request: EvalCaseInput): Promise<IpcResponse<EvalCase>>;
  deleteEvalCase(projectId: string, caseId: string): Promise<IpcResponse<{ deleted: boolean }>>;
  runEval(request: EvalRunInput): Promise<IpcResponse<EvalResult>>;
  scorecards(): Promise<IpcResponse<AgentScorecard[]>>;
  stopWorkflow(workflowId: string): Promise<IpcResponse<WorkflowRun>>;
  resumeWorkflow(workflowId: string): Promise<IpcResponse<WorkflowRun>>;
  onWorkflowChanged(listener: (run: WorkflowRun) => void): () => void;
  listCrewRuns(projectId?: string): Promise<IpcResponse<CrewRun[]>>;
  startCrew(request: CrewStartInput): Promise<IpcResponse<CrewRun>>;
  approveCrew(runId: string): Promise<IpcResponse<CrewRun>>;
  answerCrew(runId: string, answer: CrewAnswerInput['answer'], guidance?: string): Promise<IpcResponse<CrewRun>>;
  pauseCrew(runId: string): Promise<IpcResponse<CrewRun>>;
  resumeCrew(runId: string): Promise<IpcResponse<CrewRun>>;
  stopCrew(runId: string): Promise<IpcResponse<CrewRun>>;
  onCrewChanged(listener: (run: CrewRun) => void): () => void;
  crewDefaults(projectId?: string): Promise<IpcResponse<CrewConfig | null>>;
  saveCrewDefaults(config: CrewConfig | null, projectId?: string): Promise<IpcResponse<CrewConfig | null>>;
  conventionsState(refresh?: boolean): Promise<IpcResponse<ConventionsState>>;
  setConventionReference(path: string, reference: boolean): Promise<IpcResponse<ConventionsState>>;
  addConventionRule(text: string): Promise<IpcResponse<ConventionsState>>;
  removeConventionRule(id: string): Promise<IpcResponse<ConventionsState>>;
  muteConvention(key: string, muted: boolean): Promise<IpcResponse<ConventionsState>>;
  markConventionsSeen(): Promise<IpcResponse<ConventionsState>>;
  onConventionsChanged(listener: (state: ConventionsState) => void): () => void;
  crewDesign(launch?: boolean): Promise<IpcResponse<CrewDesign>>;
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
  forkConversation(request: { conversationId: string; throughTurnId?: string }): Promise<IpcResponse<ConversationBranchResult>>;
  rewindConversation(request: { conversationId: string; turnId: string; restoreFiles: boolean }): Promise<IpcResponse<ConversationBranchResult>>;
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
  testWebSearch(request: { source: WebSearchSource; endpoint: string; credentialId: string }): Promise<IpcResponse<WebSearchTestResult>>;
  listConnectorCatalog(): Promise<IpcResponse<ConnectorCatalogEntry[]>>;
  installConnector(id: string): Promise<IpcResponse<McpServerSettings>>;
  previewContext(request: ContextPreviewInput): Promise<IpcResponse<ContextPreview>>;
  previewInfo(projectId: string): Promise<IpcResponse<PreviewInfo>>;
  previewStatus(projectId: string): Promise<IpcResponse<PreviewState>>;
  startPreview(request: PreviewStartInput): Promise<IpcResponse<PreviewState>>;
  stopPreview(projectId: string): Promise<IpcResponse<PreviewState>>;
  runAgent(request: AgentRunRequest): Promise<IpcResponse<AgentRunResult>>;
  cancelAgent(conversationId: string): Promise<IpcResponse<boolean>>;
  /**
   * Says something to a run that is already going, answered at its next turn rather than waiting for the run to end
   * or cancelling it. Only a run KAI loops itself can take one; a CLI run has no turn to interrupt.
   */
  interjectAgent(request: { conversationId: string; text: string; contextChips?: ContextChip[] }): Promise<IpcResponse<{ queued: boolean }>>;
  pauseAgent(conversationId: string): Promise<IpcResponse<boolean>>;
  resumeAgent(conversationId: string): Promise<IpcResponse<boolean>>;
  signInAgent(agent: AgentRunRequest['agent']): Promise<IpcResponse<AgentSignInResult>>;
  /** Opens a terminal window running the CLI's official install command. */
  installAgent(agent: AgentRunRequest['agent']): Promise<IpcResponse<AgentSignInResult>>;
  respondToApproval(request: AgentApprovalResponseInput): Promise<IpcResponse<boolean>>;
  onAgentEvent(listener: (payload: AgentRunEvent) => void): () => void;
  /**
   * Told when a run starts and when it ends, whoever started it. The composer only ever took up the runs it began
   * itself; this is how a window takes up one it did not — Auto carrying a task, the board working a card, a
   * schedule firing — so the conversation shows what is being done to it.
   */
  onAgentRunState(listener: (payload: AgentRunState) => void): () => void;
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
  agentConfigImportPreview(): Promise<IpcResponse<AgentConfigImportPreview[]>>;
  importAgentConfig(agent: 'codex' | 'claude'): Promise<IpcResponse<AgentConfigImportPreview>>;
  answerSetupGuide(input: SetupGuideAnswerInput): Promise<IpcResponse<SetupGuideAnswer>>;
  startTerminal(projectId: string, shell: TerminalSession['shell'], cols: number, rows: number): Promise<IpcResponse<TerminalSession>>;
  writeTerminal(id: string, data: string): Promise<IpcResponse<boolean>>;
  resizeTerminal(id: string, cols: number, rows: number): Promise<IpcResponse<boolean>>;
  stopTerminalCommand(id: string): Promise<IpcResponse<boolean>>;
  /** What a session has printed so far, so the dock can pick up an agent's session part-way through. */
  terminalBuffer(id: string): Promise<IpcResponse<string>>;
  onTerminalEvent(listener: (event: TerminalEvent) => void): () => void;
  brainGitStatus(): Promise<IpcResponse<BrainGitStatus>>;
  brainGitSync(action: 'init' | 'commit' | 'pull' | 'push'): Promise<IpcResponse<BrainGitSyncResult>>;
  /** Copies this brain's entries into the other one, so switching the mirror on does not leave earlier work behind. */
  mirrorBrain(request: BrainMirrorInput): Promise<IpcResponse<BrainMirrorOutcome>>;
  gitOverview(projectId: string): Promise<IpcResponse<GitOverview>>;
  /** The plan the agent is working to for this project, so it can be shown rather than inferred. */
  readTaskPlan(projectId: string, conversationId: string): Promise<IpcResponse<Plan | null>>;
  /** Starts a repository in the project folder. Safe to call when one already exists. */
  gitInit(projectId: string): Promise<IpcResponse<GitOverview>>;
  gitStage(projectId: string, paths: string[], stage: boolean): Promise<IpcResponse<GitActionResult>>;
  gitCommit(projectId: string, message: string): Promise<IpcResponse<GitActionResult>>;
  gitCheckout(projectId: string, branch: string): Promise<IpcResponse<GitActionResult>>;
  gitCreateBranch(projectId: string, name: string, checkout: boolean): Promise<IpcResponse<GitActionResult>>;
  /** Creates a repository on GitHub under the signed-in account and sets it as `origin`. Uploads nothing. */
  gitCreateRepository(projectId: string, name: string, visibility: GitRepositoryVisibility): Promise<IpcResponse<GitCreateRepositoryResult>>;
  /**
   * Whether `gh` is installed and signed in. The Git page asks for this when the project has no GitHub remote, so it
   * can offer to create one; the overview itself does not run `gh` for a project that has nowhere to publish to.
   */
  gitGithubStatus(projectId: string): Promise<IpcResponse<GitGithubState>>;
  gitSync(projectId: string, action: GitSyncAction): Promise<IpcResponse<GitActionResult>>;
  gitPullTeamBranch(projectId: string, repository: string, branch: string): Promise<IpcResponse<GitActionResult>>;
  gitCloneTeamRepository(repository: string): Promise<IpcResponse<{ projectId: string; path: string } | null>>;
  gitDiff(projectId: string, path: string, staged: boolean): Promise<IpcResponse<GitActionResult>>;
  gitBlame(projectId: string, path: string): Promise<IpcResponse<GitBlameResult>>;
  gitChanges(projectId: string, path: string): Promise<IpcResponse<GitChangesResult>>;
  scanTodos(projectId: string): Promise<IpcResponse<TodoScanResult>>;
  reviewChange(request: string, diff: string, mode: 'novice' | 'intermediate' | 'expert'): Promise<IpcResponse<string | null>>;
  /** Reads the diffs of several changed files and returns findings that each name their file. */
  reviewChanges(request: ReviewChangesInput): Promise<IpcResponse<ChangeReviewResult>>;
  experienceCount(): Promise<IpcResponse<number>>;
  experienceSuggestions(): Promise<IpcResponse<MemoryImprovementSuggestion[]>>;
  markExperienceSuggestionsReviewed(recordIds: string[]): Promise<IpcResponse<boolean>>;
  exportExperiences(): Promise<IpcResponse<{ count: number; path: string } | null>>;
  clearExperiences(): Promise<IpcResponse<boolean>>;
  gitPullRequest(projectId: string, title: string, body: string): Promise<IpcResponse<{ url: string }>>;
  verificationOverview(projectId: string): Promise<IpcResponse<VerificationOverview>>;
  importScan(projectId: string): Promise<IpcResponse<ImportReport>>;
  importAddCards(projectId: string, findingIds: string[]): Promise<IpcResponse<{ added: string[]; report: ImportReport }>>;
  runVerification(projectId: string, command: string): Promise<IpcResponse<VerificationRun>>;
  /** Every run left over from a close, including the ones whose record is too damaged to offer anything from. */
  listInterruptedRuns(): Promise<IpcResponse<RecoveryListing>>;
  interruptedRunRecap(conversationId: string): Promise<IpcResponse<RecoveryRecap>>;
  resumeInterruptedRun(conversationId: string): Promise<IpcResponse<RecoveryResume>>;
  discardInterruptedRun(conversationId: string): Promise<IpcResponse<boolean>>;
  /**
   * Stops every live run and clears the leftover records of runs that already died. For a renderer that has lost
   * control of a run, this is the way out; it reports what it actually stopped rather than assuming success.
   */
  stopAllRuns(): Promise<IpcResponse<StopAllRunsResult>>;
  onOpenConversation(listener: (event: OpenConversationEvent) => void): () => void;
  /** Another KAI window forked or rewound a conversation; refresh it. */
  onConversationChanged(listener: (event: { conversationId: string }) => void): () => void;
  diagnosticsReport(copy: boolean): Promise<IpcResponse<{ text: string }>>;
  dataLocations(): Promise<IpcResponse<DataLocation[]>>;
  /** What KAI has learned about a project (its folders, what is being worked on, what earlier runs did), in plain text. */
  projectKnowledge(projectId: string): Promise<IpcResponse<string>>;
  recentLogs(count?: number): Promise<IpcResponse<LogEntry[]>>;
  windowState(): Promise<IpcResponse<{ maximized: boolean }>>;
  /** Opens a new window, optionally already pointed at a project and its composer. */
  newWindow(projectId?: string): Promise<IpcResponse<boolean>>;
  /** Scales the whole window's text and controls (1 is normal). Applied in the page itself, so it needs no round trip. */
  setZoomFactor(factor: number): void;
  /** Recolours the operating system's window controls to match the theme. Hex, because that is what the overlay takes. */
  setTitleBarOverlay(color: string, symbolColor: string): Promise<IpcResponse<boolean>>;
  /** How KAI Remote is doing: whether it is listening, on what, and how many phones are attached. */
  remoteStatus(): Promise<IpcResponse<RemoteAccessStatus>>;
  /** The desktop windows a phone can target, so its UI can offer a choice. */
  remoteWindows(): Promise<IpcResponse<RemoteWindowSummary[]>>;
  /** Pairs another device, returning its own token once so the user can hand it over on a link. */
  pairRemoteDevice(label: string): Promise<IpcResponse<RemoteTokenResult>>;
  /** The paired devices, without their tokens. */
  remoteDevices(): Promise<IpcResponse<RemoteDeviceSummary[]>>;
  /** Un-pairs one device. The rest keep working. */
  revokeRemoteDevice(id: string): Promise<IpcResponse<RemoteDeviceSummary[]>>;
}
