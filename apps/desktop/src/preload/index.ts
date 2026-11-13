import { contextBridge, ipcRenderer, webFrame } from 'electron';
import type { AgentRunEvent, AgentRunState, KaiDesktopBridge, OpenConversationEvent, ProxyLiveEvent, SharedDesktopState, StudioPlanProgress, TerminalEvent, UpdateState } from '@kai/contracts';

const bridge: KaiDesktopBridge = {
  bootstrap: () => ipcRenderer.invoke('app:get-bootstrap', {}),
  chooseProject: () => ipcRenderer.invoke('projects:choose', {}),
  openProject: (id) => ipcRenderer.invoke('projects:open', { id }),
  removeProject: (id) => ipcRenderer.invoke('projects:remove', { id }),
  clearProjects: () => ipcRenderer.invoke('projects:clear', {}),
  getSettings: () => ipcRenderer.invoke('settings:get', {}),
  updateSettings: (update) => ipcRenderer.invoke('settings:update', update),
  onSharedDesktopState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: SharedDesktopState): void => listener(payload);
    ipcRenderer.on('app:shared-state', handler);
    return () => ipcRenderer.removeListener('app:shared-state', handler);
  },
  playwrightViewportStatus: () => ipcRenderer.invoke('playwright:viewport-status', {}),
  repairPlaywrightViewport: () => ipcRenderer.invoke('playwright:viewport-repair', {}),
  onPlaywrightViewportStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: import('@kai/contracts').PlaywrightViewportStatus): void => listener(status);
    ipcRenderer.on('app:playwright-viewport', handler);
    return () => ipcRenderer.removeListener('app:playwright-viewport', handler);
  },
  loadComposerQueue: (legacy) => ipcRenderer.invoke('composer-queue:load', legacy ? { legacy } : {}),
  addQueuedPrompt: (item, first) => ipcRenderer.invoke('composer-queue:add', { item, first }),
  claimQueuedPrompt: (conversationId, id) => ipcRenderer.invoke('composer-queue:claim', { conversationId, id }),
  updateQueuedPrompt: (input) => ipcRenderer.invoke('composer-queue:update', input),
  holdQueuedPrompts: (error) => ipcRenderer.invoke('composer-queue:hold-all', { error }),
  removeQueuedConversation: (conversationId) => ipcRenderer.invoke('composer-queue:remove-conversation', { conversationId }),
  onComposerQueueChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, queue: import('@kai/contracts').ComposerQueue): void => listener(queue);
    ipcRenderer.on('app:composer-queue-changed', handler);
    return () => ipcRenderer.removeListener('app:composer-queue-changed', handler);
  },
  listPromptPresets: () => ipcRenderer.invoke('prompt-presets:list', {}),
  savePromptPreset: (slot, label, text) => ipcRenderer.invoke('prompt-presets:save', { slot, label, text }),
  deletePromptPreset: (slot) => ipcRenderer.invoke('prompt-presets:delete', { slot }),
  serviceStatus: () => ipcRenderer.invoke('services:status', {}),
  startService: (kind) => ipcRenderer.invoke('services:start', { kind }),
  stopService: (kind) => ipcRenderer.invoke('services:stop', { kind }),
  restartService: (kind) => ipcRenderer.invoke('services:restart', { kind }),
  rotateServiceToken: (kind) => ipcRenderer.invoke('services:rotate-token', { kind }),
  copyServiceToken: (kind) => ipcRenderer.invoke('services:copy-token', { kind }),
  brainOverview: () => ipcRenderer.invoke('brain:overview', {}),
  searchBrain: (request) => ipcRenderer.invoke('brain:search', request),
  updateBrainField: (request) => ipcRenderer.invoke('brain:update-field', request),
  importBrain: () => ipcRenderer.invoke('brain:import', {}),
  brainGitStatus: () => ipcRenderer.invoke('brain:git-status', {}),
  mirrorBrain: (request) => ipcRenderer.invoke('brain:mirror-now', request),
  brainGitSync: (action) => ipcRenderer.invoke('brain:git-sync', { action }),
  cognitive1Tool: (request) => ipcRenderer.invoke('cognitive1:tool', request),
  cognitive1Operation: (request) => ipcRenderer.invoke('cognitive1:operation', request),
  getRules: () => ipcRenderer.invoke('rules:get', {}),
  saveRule: (request) => ipcRenderer.invoke('rules:save', request),
  injectRulesIntoProjects: () => ipcRenderer.invoke('rules:inject-projects', {}),
  listSkills: (projectId) => ipcRenderer.invoke('skills:list', projectId ? { projectId } : {}),
  chooseFiles: (projectId) => ipcRenderer.invoke('files:choose', { projectId }),
  searchFiles: (request) => ipcRenderer.invoke('files:search', request),
  suggestPermissionRules: (projectId) => ipcRenderer.invoke('permission-rules:suggest', { projectId }),
  projectFileTree: (projectId) => ipcRenderer.invoke('files:tree', { projectId }),
  readProjectFile: (projectId, path) => ipcRenderer.invoke('files:read', { projectId, path }),
  publishInlineMockup: (html) => ipcRenderer.invoke('mockup:inline', { html }),
  publishProjectMockup: (projectId, path) => ipcRenderer.invoke('mockup:file', { projectId, path }),
  readProjectImage: (projectId, path) => ipcRenderer.invoke('files:image', { projectId, path }),
  writeProjectFile: (request) => ipcRenderer.invoke('files:write', request),
  deleteProjectPath: (request) => ipcRenderer.invoke('files:delete', request),
  renameProjectPath: (request) => ipcRenderer.invoke('files:rename', request),
  createProjectFolder: (request) => ipcRenderer.invoke('files:folder', request),
  revealProjectPath: (request) => ipcRenderer.invoke('files:reveal', request),
  projectFileChanged: (projectId, path, expectedHash) => ipcRenderer.invoke('files:changed', { projectId, path, expectedHash }),
  updateEditorDocument: (document) => ipcRenderer.invoke('editor:update-document', document),
  removeEditorDocument: (document) => ipcRenderer.invoke('editor:remove-document', document),
  updateEditorWindow: (snapshot) => ipcRenderer.invoke('editor:update-window', snapshot),
  onEditorDocumentsSaved: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: import('@kai/contracts').EditorSavedDocument[]): void => listener(payload);
    ipcRenderer.on('editor:documents-saved', handler);
    return () => ipcRenderer.removeListener('editor:documents-saved', handler);
  },
  markLearningUnderstood: (projectId, lessonId) => ipcRenderer.invoke('learning:understood', { projectId, lessonId }),
  recordLearningCheckEvidence: (input) => ipcRenderer.invoke('learning:record-check-evidence', input),
  explainLearningBack: (input) => ipcRenderer.invoke('learning:explain-back', input),
  explainLearningBackHelp: (input) => ipcRenderer.invoke('learning:explain-back-help', input),
  learningProgress: (projectId) => ipcRenderer.invoke('learning:progress', { projectId }),
  learningReadiness: () => ipcRenderer.invoke('learning:readiness', {}),
  updateLearningPreferences: (input) => ipcRenderer.invoke('learning:update-preferences', input),
  evaluateLearning: (request) => ipcRenderer.invoke('learning:evaluate', request),
  cancelLearning: (requestId) => ipcRenderer.invoke('learning:cancel', { requestId }),
  recordLearningLesson: (input) => ipcRenderer.invoke('learning:record-lesson', input),
  teachingLibrary: () => ipcRenderer.invoke('learning:teaching-library', {}),
  saveTeachingEntry: (input) => ipcRenderer.invoke('learning:save-teaching-entry', input),
  deleteTeachingEntry: (input) => ipcRenderer.invoke('learning:delete-teaching-entry', input),
  resetTeachingEntry: (input) => ipcRenderer.invoke('learning:reset-teaching-entry', input),
  generateTeachingDraft: (input) => ipcRenderer.invoke('learning:generate-teaching-draft', input),
  securityFindings: () => ipcRenderer.invoke('learning:security-findings', {}),
  saveSecurityFinding: (input) => ipcRenderer.invoke('learning:save-security-finding', input),
  updateSecurityFindingStatus: (input) => ipcRenderer.invoke('learning:update-security-finding-status', input),
  runSecurityScan: (input) => ipcRenderer.invoke('learning:security-scan', input),
  formatCode: (input) => ipcRenderer.invoke('code:format', input),
  installCodeFormatter: (input) => ipcRenderer.invoke('code:install-formatter', input),
  gitFileInfo: (projectId, path) => ipcRenderer.invoke('git:file-info', { projectId, path }),
  rejectCheckpointHunks: (conversationId, turnId, filePath, hunkIds) => ipcRenderer.invoke('checkpoints:reject-hunks', { conversationId, turnId, filePath, hunkIds }),
  gitDiffStat: (projectId) => ipcRenderer.invoke('context:git-diff', { projectId }),
  saveAttachment: (name, dataUrl) => ipcRenderer.invoke('attachments:save', { name, dataUrl }),
  listWorkflowTemplates: (projectId) => ipcRenderer.invoke('workflows:list-templates', projectId ? { projectId } : {}),
  listWorkflowRuns: (projectId) => ipcRenderer.invoke('workflows:list-runs', projectId ? { projectId } : {}),
  startWorkflow: (request) => ipcRenderer.invoke('workflows:start', request),
  planTeam: (request) => ipcRenderer.invoke('team:plan', request),
  planTeamFromParts: (request) => ipcRenderer.invoke('team:plan-from-parts', request),
  promptGuideReadiness: () => ipcRenderer.invoke('prompt-guide:readiness', {}),
  refineIdea: (request) => ipcRenderer.invoke('prompt-guide:refine', request),
  refinePrompt: (request) => ipcRenderer.invoke('prompt-guide:refine-prompt', request),
  equalizerScreens: (projectId) => ipcRenderer.invoke('equalizer:screens', { projectId }),
  runEqualizer: (input) => ipcRenderer.invoke('equalizer:run', input),
  equalizerImage: (input) => ipcRenderer.invoke('equalizer:image', input),
  onEqualizerProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]): void => listener(payload);
    ipcRenderer.on('equalizer:progress', handler);
    return () => ipcRenderer.removeListener('equalizer:progress', handler);
  },
  openPencilStatus: () => ipcRenderer.invoke('design:openpencil-status', {}),
  saveOpenPencil: (input) => ipcRenderer.invoke('design:openpencil-save', input),
  testOpenPencil: () => ipcRenderer.invoke('design:openpencil-test', {}),
  studioReadiness: () => ipcRenderer.invoke('studio:readiness', {}),
  studioProjects: () => ipcRenderer.invoke('studio:projects-list', {}),
  linkStudioProject: (request) => ipcRenderer.invoke('studio:project-link', request),
  setStudioProjectArchived: (request) => ipcRenderer.invoke('studio:project-archive', request),
  deleteStudioProject: (projectId) => ipcRenderer.invoke('studio:project-remove', { projectId }),
  chooseStudioProjectFolder: (request) => ipcRenderer.invoke('studio:project-folder', request),
  launchStudioProject: (request) => ipcRenderer.invoke('studio:project-launch', request),
  studioInterview: (projectId) => ipcRenderer.invoke('studio:interview-read', { projectId }),
  startStudioInterview: (request) => ipcRenderer.invoke('studio:interview-start', request),
  answerStudioInterview: (request) => ipcRenderer.invoke('studio:interview-answer', request),
  correctStudioInterviewAnswer: (request) => ipcRenderer.invoke('studio:interview-correct', request),
  actOnStudioAssumption: (request) => ipcRenderer.invoke('studio:interview-assumption', request),
  askStudioAssumedTopics: (projectId) => ipcRenderer.invoke('studio:interview-assumed-topics', { projectId }),
  askStudioTopic: (request) => ipcRenderer.invoke('studio:interview-topic-ask', request),
  finishStudioInterview: (projectId) => ipcRenderer.invoke('studio:interview-finish', { projectId }),
  confirmStudioInterview: (projectId) => ipcRenderer.invoke('studio:interview-confirm', { projectId }),
  reopenStudioInterview: (projectId) => ipcRenderer.invoke('studio:interview-reopen', { projectId }),
  resetStudioInterview: (projectId) => ipcRenderer.invoke('studio:interview-reset', { projectId }),
  extendStudioInterview: (projectId) => ipcRenderer.invoke('studio:interview-extend', { projectId }),
  studioArtifacts: (projectId) => ipcRenderer.invoke('studio:artifacts-read', { projectId }),
  studioArtifactFiles: (projectId) => ipcRenderer.invoke('studio:artifacts-files', { projectId }),
  studioArtifactText: (input) => ipcRenderer.invoke('studio:artifacts-text', input),
  saveStudioArtifact: (input) => ipcRenderer.invoke('studio:artifacts-save', input),
  studioStyleReferences: (projectId) => ipcRenderer.invoke('studio:style-refs-read', { projectId }),
  addStudioStyleReference: (input) => ipcRenderer.invoke('studio:style-refs-add', input),
  removeStudioStyleReference: (input) => ipcRenderer.invoke('studio:style-refs-remove', input),
  describeStudioStyle: (projectId) => ipcRenderer.invoke('studio:style-refs-describe', { projectId }),
  generateStudioArtifact: (input) => ipcRenderer.invoke('studio:artifacts-generate', input),
  generateStudioArtifacts: (projectId) => ipcRenderer.invoke('studio:artifacts-generate-all', { projectId }),
  generateStudioArtifactsSelected: (input) => ipcRenderer.invoke('studio:artifacts-generate-selected', input),
  markStudioArtifactEdited: (input) => ipcRenderer.invoke('studio:artifacts-mark-edited', input),
  studioBoard: (projectId) => ipcRenderer.invoke('studio:board-read', { projectId }),
  planStudioBoard: (projectId) => ipcRenderer.invoke('studio:board-plan', { projectId }),
  arrangeStudioBoard: (projectId) => ipcRenderer.invoke('studio:board-arrange', { projectId }),
  nextStudioCard: (projectId) => ipcRenderer.invoke('studio:board-next', { projectId }),
  moveStudioCard: (input) => ipcRenderer.invoke('studio:board-move', input),
  reviewStudioBoardCard: (input) => ipcRenderer.invoke('studio:board-review', input),
  setStudioBoardAcceptance: (input) => ipcRenderer.invoke('studio:board-acceptance-rule', input),
  setStudioCardRoute: (input) => ipcRenderer.invoke('studio:board-route', input),
  suggestStudioRouteRepairs: (projectId) => ipcRenderer.invoke('studio:board-repair-routes', { projectId }),
  readStudioGuide: (projectId) => ipcRenderer.invoke('studio:guide-read', { projectId }),
  explainStudioGuide: (projectId) => ipcRenderer.invoke('studio:guide-explain', { projectId }),
  readCodeGuide: (projectId) => ipcRenderer.invoke('code:guide-read', { projectId }),
  explainCodeGuide: (projectId) => ipcRenderer.invoke('code:guide-explain', { projectId }),
  claimStudioCard: (input) => ipcRenderer.invoke('studio:board-claim', input),
  checkStudioCardUi: (projectId, cardId) => ipcRenderer.invoke('studio:board-check-ui', { projectId, cardId }),
  planStudioTeam: (projectId) => ipcRenderer.invoke('studio:board-team-plan', { projectId }),
  workStudioBoard: (request) => ipcRenderer.invoke('studio:board-work', request),
  startAutopilot: (request) => ipcRenderer.invoke('autopilot:start', request),
  stopAutopilot: (request) => ipcRenderer.invoke('autopilot:stop', request),
  autopilotStatus: (request) => ipcRenderer.invoke('autopilot:status', request),
  requeueAutopilot: (request) => ipcRenderer.invoke('autopilot:requeue', request),
  autopilotInterrupted: () => ipcRenderer.invoke('autopilot:interrupted', {}),
  autopilotAudit: (request) => ipcRenderer.invoke('autopilot:audit', request),
  resumeInterruptedAutopilot: (request) => ipcRenderer.invoke('autopilot:interrupted-resume', request),
  releaseInterruptedAutopilot: (request) => ipcRenderer.invoke('autopilot:interrupted-release', request),
  onAutopilotChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: import('@kai/contracts').AutopilotStatus): void => listener(payload);
    ipcRenderer.on('autopilot:changed', handler);
    return () => ipcRenderer.removeListener('autopilot:changed', handler);
  },
  startAuto: (request) => ipcRenderer.invoke('auto:start', request),
  stopAuto: (request) => ipcRenderer.invoke('auto:stop', request),
  autoStatus: (request) => ipcRenderer.invoke('auto:status', request),
  pauseAuto: (request) => ipcRenderer.invoke('auto:pause', request),
  resumeAuto: (request) => ipcRenderer.invoke('auto:resume', request),
  onAutoChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: import('@kai/contracts').AutoStatus): void => listener(payload);
    ipcRenderer.on('auto:changed', handler);
    return () => ipcRenderer.removeListener('auto:changed', handler);
  },
  runArchitect: (request) => ipcRenderer.invoke('architect:run', request),
  stopArchitect: (request) => ipcRenderer.invoke('architect:stop', request),
  answerArchitect: (request) => ipcRenderer.invoke('architect:answer', request),
  architectStatus: (request) => ipcRenderer.invoke('architect:status', request),
  architectReady: (target) => ipcRenderer.invoke('architect:ready', { target }),
  onArchitectChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: import('@kai/contracts').ArchitectStatus): void => listener(payload);
    ipcRenderer.on('architect:changed', handler);
    return () => ipcRenderer.removeListener('architect:changed', handler);
  },
  studioDesign: (projectId) => ipcRenderer.invoke('studio:design-read', { projectId }),
  studioDesignStatus: (projectId) => ipcRenderer.invoke('studio:design-status', { projectId }),
  pullStudioDesign: (projectId, adopt) => ipcRenderer.invoke('studio:design-pull', { projectId, ...(adopt ? { adopt } : {}) }),
  renameStudioDesignPage: (input) => ipcRenderer.invoke('studio:design-page-rename', input),
  deleteStudioDesignPage: (input) => ipcRenderer.invoke('studio:design-page-delete', input),
  buildStudioDesignStep: (projectId, prompt, stepId) => ipcRenderer.invoke('studio:design-build-step', { projectId, prompt, stepId }),
  chatWithStudioDesign: (input) => ipcRenderer.invoke('studio:design-chat', input),
  captureStudioDesignScreenshot: (input) => ipcRenderer.invoke('studio:design-screenshot', input),
  chatWithStudioPlan: (input) => ipcRenderer.invoke('studio:plan-chat', input),
  onStudioPlanProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: StudioPlanProgress): void => listener(payload);
    ipcRenderer.on('studio:plan-progress', handler);
    return () => ipcRenderer.removeListener('studio:plan-progress', handler);
  },
  applyStudioPlanChanges: (input) => ipcRenderer.invoke('studio:plan-apply', input),
  cancelStudioDesignStep: (projectId, stepId) => ipcRenderer.invoke('studio:design-build-cancel', { projectId, stepId }),
  onStudioBoardChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { projectId: string; board: import('@kai/contracts').StudioBoard }): void => listener(payload);
    ipcRenderer.on('studio:board-changed', handler);
    return () => ipcRenderer.removeListener('studio:board-changed', handler);
  },
  startTeam: (request) => ipcRenderer.invoke('team:start', request),
  teamRecord: (request) => ipcRenderer.invoke('team:record', request),
  clearTeamRecord: () => ipcRenderer.invoke('team:clear-record', {}),
  listSchedules: (projectId) => ipcRenderer.invoke('schedules:list', { projectId }),
  saveSchedule: (request) => ipcRenderer.invoke('schedules:save', request),
  deleteSchedule: (id) => ipcRenderer.invoke('schedules:delete', { id }),
  runScheduleNow: (id) => ipcRenderer.invoke('schedules:run-now', { id }),
  listEvals: (projectId) => ipcRenderer.invoke('evals:list', { projectId }),
  saveEvalCase: (request) => ipcRenderer.invoke('evals:save-case', request),
  deleteEvalCase: (projectId, caseId) => ipcRenderer.invoke('evals:delete-case', { projectId, caseId }),
  runEval: (request) => ipcRenderer.invoke('evals:run', request),
  scorecards: () => ipcRenderer.invoke('scorecards:summary', {}),
  stopWorkflow: (workflowId) => ipcRenderer.invoke('workflows:stop', { workflowId }),
  resumeWorkflow: (workflowId) => ipcRenderer.invoke('workflows:resume', { workflowId }),
  onWorkflowChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, run: import('@kai/contracts').WorkflowRun): void => listener(run);
    ipcRenderer.on('workflows:changed', handler);
    return () => ipcRenderer.removeListener('workflows:changed', handler);
  },
  listCrewRuns: (projectId) => ipcRenderer.invoke('crew:list', projectId ? { projectId } : {}),
  startCrew: (request) => ipcRenderer.invoke('crew:start', request),
  approveCrew: (runId) => ipcRenderer.invoke('crew:approve', { runId }),
  answerCrew: (runId, answer, guidance = '') => ipcRenderer.invoke('crew:answer', { runId, answer, guidance }),
  pauseCrew: (runId) => ipcRenderer.invoke('crew:pause', { runId }),
  resumeCrew: (runId) => ipcRenderer.invoke('crew:resume', { runId }),
  stopCrew: (runId) => ipcRenderer.invoke('crew:stop', { runId }),
  crewDefaults: (projectId) => ipcRenderer.invoke('crew:defaults', projectId ? { projectId } : {}),
  saveCrewDefaults: (config, projectId) => ipcRenderer.invoke('crew:save-defaults', { config, ...(projectId ? { projectId } : {}) }),
  conventionsState: (refresh = false) => ipcRenderer.invoke('conventions:get', { refresh }),
  setConventionReference: (path, reference) => ipcRenderer.invoke('conventions:reference', { path, reference }),
  addConventionRule: (text) => ipcRenderer.invoke('conventions:rule-add', { text }),
  removeConventionRule: (id) => ipcRenderer.invoke('conventions:rule-remove', { id }),
  muteConvention: (key, muted) => ipcRenderer.invoke('conventions:mute', { key, muted }),
  markConventionsSeen: () => ipcRenderer.invoke('conventions:seen', {}),
  onConventionsChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: import('@kai/contracts').ConventionsState): void => listener(state);
    ipcRenderer.on('conventions:changed', handler);
    return () => ipcRenderer.removeListener('conventions:changed', handler);
  },
  crewDesign: (launch = false) => ipcRenderer.invoke('crew:design', { launch }),
  onCrewChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, run: import('@kai/contracts').CrewRun): void => listener(run);
    ipcRenderer.on('crew:changed', handler);
    return () => ipcRenderer.removeListener('crew:changed', handler);
  },
  saveWorkflowTemplate: (request) => ipcRenderer.invoke('workflows:save-template', request),
  deleteWorkflowTemplate: (id) => ipcRenderer.invoke('workflows:delete-template', { id }),
  proxyOverview: () => ipcRenderer.invoke('proxy:overview', {}),
  proxyHistory: (request) => ipcRenderer.invoke('proxy:history', request ?? {}),
  proxyHistoryDetail: (id) => ipcRenderer.invoke('proxy:history-detail', { id }),
  clearProxyHistory: () => ipcRenderer.invoke('proxy:clear-history', {}),
  testProxyConnection: (agent) => ipcRenderer.invoke('proxy:test-connection', agent ? { agent } : {}),
  pingProxyProviders: () => ipcRenderer.invoke('proxy:ping-all', {}),
  dryRunProxy: (body) => ipcRenderer.invoke('proxy:dry-run', { body }),
  clearProxyCosts: () => ipcRenderer.invoke('proxy:clear-costs', {}),
  proxyCostSummary: (period) => ipcRenderer.invoke('proxy:cost-summary', { period }),
  previewProxyReplay: (id) => ipcRenderer.invoke('proxy:replay-preview', { id }),
  replayProxyRequest: (id) => ipcRenderer.invoke('proxy:replay', { id }),
  proxyModels: () => ipcRenderer.invoke('proxy:models', {}),
  proxyRoutes: () => ipcRenderer.invoke('proxy:routes', {}),
  routeProxyAgent: (agent, action, routeUntil) => ipcRenderer.invoke('proxy:route-action', {
    agent,
    action,
    ...(routeUntil === undefined ? {} : { routeUntil }),
  }),
  exportProxyConfig: () => ipcRenderer.invoke('proxy:export-config', {}),
  importProxyConfig: () => ipcRenderer.invoke('proxy:import-config', {}),
  copyProxyEnv: (agent) => ipcRenderer.invoke('proxy:copy-env', agent ? { agent } : {}),
  launchProxyAgent: (agent) => ipcRenderer.invoke('proxy:launch-agent', { agent }),
  resetClaudeCode: () => ipcRenderer.invoke('proxy:reset-claude', {}),
  openClaudeSettings: () => ipcRenderer.invoke('proxy:open-claude-settings', {}),
  startProxyLiveTail: () => ipcRenderer.invoke('proxy:start-live-tail', {}),
  stopProxyLiveTail: () => ipcRenderer.invoke('proxy:stop-live-tail', {}),
  onProxyLiveEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: ProxyLiveEvent): void => listener(payload);
    ipcRenderer.on('proxy:live-event', handler);
    return () => ipcRenderer.removeListener('proxy:live-event', handler);
  },
  getPreferences: (projectId) => ipcRenderer.invoke('preferences:get', { projectId }),
  updatePreferences: (preferences) => ipcRenderer.invoke('preferences:update', preferences),
  credentialStatus: () => ipcRenderer.invoke('credentials:status', {}),
  setCredential: (id, value) => ipcRenderer.invoke('credentials:set', { id, value }),
  clearCredential: (id) => ipcRenderer.invoke('credentials:clear', { id }),
  listConversations: () => ipcRenderer.invoke('conversations:list', {}),
  getConversation: (id) => ipcRenderer.invoke('conversations:get', { id }),
  createConversation: (projectId, firstPrompt) =>
    ipcRenderer.invoke('conversations:create', { projectId, firstPrompt }),
  compactConversation: (conversationId) => ipcRenderer.invoke('conversations:compact', { conversationId }),
  saveConversation: (conversation) => ipcRenderer.invoke('conversations:save', conversation),
  forkConversation: (request) => ipcRenderer.invoke('conversations:fork', request),
  rewindConversation: (request) => ipcRenderer.invoke('conversations:rewind', request),
  deleteConversation: (id) => ipcRenderer.invoke('conversations:delete', { id }),
  reviewCheckpoint: (conversationId, turnId) => ipcRenderer.invoke('checkpoints:review', { conversationId, turnId }),
  rejectCheckpointFile: (conversationId, turnId, filePath) => ipcRenderer.invoke('checkpoints:reject', { conversationId, turnId, filePath }),
  restoreCheckpoint: (conversationId, turnId) => ipcRenderer.invoke('checkpoints:restore', { conversationId, turnId }),
  startCompare: (request) => ipcRenderer.invoke('compare:start', request),
  pickCompareWinner: (id, side) => ipcRenderer.invoke('compare:pick', { id, side }),
  discardCompare: (id) => ipcRenderer.invoke('compare:discard', { id }),
  openCompareWorktree: (id, side) => ipcRenderer.invoke('compare:open', { id, side }),
  listBackups: () => ipcRenderer.invoke('backups:list', {}),
  createBackup: (name) => ipcRenderer.invoke('backups:create', name ? { name } : {}),
  restoreBackup: (id) => ipcRenderer.invoke('backups:restore', { id }),
  deleteBackup: (id) => ipcRenderer.invoke('backups:delete', { id }),
  agentCapabilities: () => ipcRenderer.invoke('agents:capabilities', {}),
  directApiCapability: () => ipcRenderer.invoke('agents:api-capability', {}),
  listProviderModels: (request) => ipcRenderer.invoke('providers:list-models', request),
  testWebSearch: (request) => ipcRenderer.invoke('web-search:test', request),
  listConnectorCatalog: () => ipcRenderer.invoke('catalog:list'),
  installConnector: (id) => ipcRenderer.invoke('catalog:install', { id }),
  previewContext: (request) => ipcRenderer.invoke('context:preview', request),
  previewInfo: (projectId) => ipcRenderer.invoke('preview:info', { projectId }),
  previewStatus: (projectId) => ipcRenderer.invoke('preview:status', { projectId }),
  startPreview: (request) => ipcRenderer.invoke('preview:start', request),
  stopPreview: (projectId) => ipcRenderer.invoke('preview:stop', { projectId }),
  runAgent: (request) => ipcRenderer.invoke('agents:run', request),
  interjectAgent: (request) => ipcRenderer.invoke('agents:interject', request),
  cancelAgent: (conversationId) => ipcRenderer.invoke('agents:cancel', { conversationId }),
  stopAllRuns: () => ipcRenderer.invoke('runs:stop-all', {}),
  pauseAgent: (conversationId) => ipcRenderer.invoke('agents:pause', { conversationId }),
  resumeAgent: (conversationId) => ipcRenderer.invoke('agents:resume', { conversationId }),
  signInAgent: (agent) => ipcRenderer.invoke('agents:sign-in', { agent }),
  installAgent: (agent) => ipcRenderer.invoke('agents:install', { agent }),
  respondToApproval: (request) => ipcRenderer.invoke('agents:approval-response', request),
  onAgentEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: AgentRunEvent): void => listener(payload);
    ipcRenderer.on('agents:event', handler);
    return () => ipcRenderer.removeListener('agents:event', handler);
  },
  onAgentRunState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: AgentRunState): void => listener(payload);
    ipcRenderer.on('agents:run-state', handler);
    return () => ipcRenderer.removeListener('agents:run-state', handler);
  },
  usageSummary: (conversationId) => ipcRenderer.invoke('usage:summary', conversationId ? { conversationId } : {}),
  reportView: (view, conversationId) => ipcRenderer.invoke('ui:report-view', { view, conversationId }),
  coordinationOverview: () => ipcRenderer.invoke('coordination:overview', {}),
  coordinationPreflight: (projectId, files) => ipcRenderer.invoke('coordination:preflight', { projectId, files }),
  globalSearch: (query) => ipcRenderer.invoke('search:global', { query }),
  updateState: () => ipcRenderer.invoke('updates:state', {}),
  checkForUpdates: () => ipcRenderer.invoke('updates:check', {}),
  downloadUpdate: () => ipcRenderer.invoke('updates:download', {}),
  installUpdate: () => ipcRenderer.invoke('updates:install', {}),
  setupStatus: () => ipcRenderer.invoke('setup:status', {}),
  completeSetup: (complete) => ipcRenderer.invoke('setup:complete', { complete }),
  agentConfigImportPreview: () => ipcRenderer.invoke('setup:agent-config-preview', {}),
  importAgentConfig: (agent) => ipcRenderer.invoke('setup:agent-config-import', { agent }),
  answerSetupGuide: (input) => ipcRenderer.invoke('setup:guide-answer', input),
  onUpdateState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: UpdateState): void => listener(payload);
    ipcRenderer.on('app:update-state', handler);
    return () => ipcRenderer.removeListener('app:update-state', handler);
  },
  startTerminal: (projectId, shell, cols, rows) => ipcRenderer.invoke('terminal:start', { projectId, shell, cols, rows }),
  writeTerminal: (id, data) => ipcRenderer.invoke('terminal:write', { id, data }),
  resizeTerminal: (id, cols, rows) => ipcRenderer.invoke('terminal:resize', { id, cols, rows }),
  stopTerminalCommand: (id) => ipcRenderer.invoke('terminal:stop', { id }),
  terminalBuffer: (id) => ipcRenderer.invoke('terminal:buffer', { id }),
  onTerminalEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: TerminalEvent): void => listener(payload);
    ipcRenderer.on('terminal:event', handler);
    return () => ipcRenderer.removeListener('terminal:event', handler);
  },
  readTaskPlan: (projectId, conversationId) => ipcRenderer.invoke('plan:read', { projectId, conversationId }),
  gitOverview: (projectId) => ipcRenderer.invoke('git:overview', { projectId }),
  gitInit: (projectId) => ipcRenderer.invoke('git:init', { projectId }),
  gitStage: (projectId, paths, stage) => ipcRenderer.invoke('git:stage', { projectId, paths, stage }),
  gitCommit: (projectId, message) => ipcRenderer.invoke('git:commit', { projectId, message }),
  gitCheckout: (projectId, branch) => ipcRenderer.invoke('git:checkout', { projectId, branch }),
  gitCreateBranch: (projectId, name, checkout) => ipcRenderer.invoke('git:create-branch', { projectId, name, checkout }),
  gitCreateRepository: (projectId, name, visibility) => ipcRenderer.invoke('git:create-repository', { projectId, name, visibility }),
  gitGithubStatus: (projectId) => ipcRenderer.invoke('git:github-status', { projectId }),
  gitSync: (projectId, action) => ipcRenderer.invoke('git:sync', { projectId, action }),
  gitPullTeamBranch: (projectId, repository, branch) => ipcRenderer.invoke('git:pull-team-branch', { projectId, repository, branch }),
  gitCloneTeamRepository: (repository) => ipcRenderer.invoke('git:clone-team-repository', { repository }),
  gitDiff: (projectId, path, staged) => ipcRenderer.invoke('git:diff', { projectId, path, staged }),
  gitBlame: (projectId, path) => ipcRenderer.invoke('git:blame', { projectId, path }),
  gitChanges: (projectId, path) => ipcRenderer.invoke('git:changes', { projectId, path }),
  scanTodos: (projectId) => ipcRenderer.invoke('files:todos', { projectId }),
  reviewChanges: (request) => ipcRenderer.invoke('review:changes', request),
  reviewChange: (request, diff, mode) => ipcRenderer.invoke('review:change', { request, diff, mode }),
  experienceCount: () => ipcRenderer.invoke('experiences:count', {}),
  exportExperiences: () => ipcRenderer.invoke('experiences:export', {}),
  clearExperiences: () => ipcRenderer.invoke('experiences:clear', {}),
  gitPullRequest: (projectId, title, body) => ipcRenderer.invoke('git:pull-request', { projectId, title, body }),
  verificationOverview: (projectId) => ipcRenderer.invoke('verification:overview', { projectId }),
  importScan: (projectId) => ipcRenderer.invoke('import:scan', { projectId }),
  importAddCards: (projectId, findingIds) => ipcRenderer.invoke('import:add-cards', { projectId, findingIds }),
  runVerification: (projectId, command) => ipcRenderer.invoke('verification:run', { projectId, command }),
  listInterruptedRuns: () => ipcRenderer.invoke('recovery:list', {}),
  interruptedRunRecap: (conversationId) => ipcRenderer.invoke('recovery:recap', { conversationId }),
  resumeInterruptedRun: (conversationId) => ipcRenderer.invoke('recovery:resume', { conversationId }),
  discardInterruptedRun: (conversationId) => ipcRenderer.invoke('recovery:discard', { conversationId }),
  onOpenConversation: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: OpenConversationEvent): void => listener(payload);
    ipcRenderer.on('app:open-conversation', handler);
    return () => ipcRenderer.removeListener('app:open-conversation', handler);
  },
  onConversationChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { conversationId: string }): void => listener(payload);
    ipcRenderer.on('app:conversation-changed', handler);
    return () => ipcRenderer.removeListener('app:conversation-changed', handler);
  },
  diagnosticsReport: (copy) => ipcRenderer.invoke('diagnostics:report', { copy }),
  dataLocations: () => ipcRenderer.invoke('diagnostics:data-locations', {}),
  projectKnowledge: (projectId) => ipcRenderer.invoke('projects:knowledge', { projectId }),
  recentLogs: (count) => ipcRenderer.invoke('diagnostics:recent-logs', { count }),
  windowState: () => ipcRenderer.invoke('window:state', {}),
  newWindow: (projectId) => ipcRenderer.invoke('window:new', { projectId }),
  setZoomFactor: (factor) => { if (Number.isFinite(factor)) webFrame.setZoomFactor(Math.min(2, Math.max(0.6, factor))); },
  setTitleBarOverlay: (color, symbolColor) => ipcRenderer.invoke('window:title-bar-overlay', { color, symbolColor }),
  remoteStatus: () => ipcRenderer.invoke('remote:status', {}),
  remoteWindows: () => ipcRenderer.invoke('remote:windows', {}),
  remoteDevices: () => ipcRenderer.invoke('remote:devices', {}),
  pairRemoteDevice: (label) => ipcRenderer.invoke('remote:pair-device', { label }),
  revokeRemoteDevice: (id) => ipcRenderer.invoke('remote:revoke-device', { id }),
};

contextBridge.exposeInMainWorld('kaiDesktop', bridge);
