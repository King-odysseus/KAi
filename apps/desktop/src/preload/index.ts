import { contextBridge, ipcRenderer } from 'electron';
import type { AgentRunEvent, KaiDesktopBridge, OpenConversationEvent, ProxyLiveEvent, SharedDesktopState, TerminalEvent, UpdateState } from '@kai/contracts';

const bridge: KaiDesktopBridge = {
  bootstrap: () => ipcRenderer.invoke('app:get-bootstrap', {}),
  chooseProject: () => ipcRenderer.invoke('projects:choose', {}),
  openProject: (id) => ipcRenderer.invoke('projects:open', { id }),
  removeProject: (id) => ipcRenderer.invoke('projects:remove', { id }),
  getSettings: () => ipcRenderer.invoke('settings:get', {}),
  updateSettings: (update) => ipcRenderer.invoke('settings:update', update),
  onSharedDesktopState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: SharedDesktopState): void => listener(payload);
    ipcRenderer.on('app:shared-state', handler);
    return () => ipcRenderer.removeListener('app:shared-state', handler);
  },
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
  brainGitSync: (action) => ipcRenderer.invoke('brain:git-sync', { action }),
  cognitive1Tool: (request) => ipcRenderer.invoke('cognitive1:tool', request),
  cognitive1Operation: (request) => ipcRenderer.invoke('cognitive1:operation', request),
  getRules: () => ipcRenderer.invoke('rules:get', {}),
  saveRule: (request) => ipcRenderer.invoke('rules:save', request),
  listSkills: (projectId) => ipcRenderer.invoke('skills:list', projectId ? { projectId } : {}),
  chooseFiles: (projectId) => ipcRenderer.invoke('files:choose', { projectId }),
  searchFiles: (request) => ipcRenderer.invoke('files:search', request),
  projectFileTree: (projectId) => ipcRenderer.invoke('files:tree', { projectId }),
  readProjectFile: (projectId, path) => ipcRenderer.invoke('files:read', { projectId, path }),
  writeProjectFile: (request) => ipcRenderer.invoke('files:write', request),
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
  explainLearningBack: (input) => ipcRenderer.invoke('learning:explain-back', input),
  explainLearningBackHelp: (input) => ipcRenderer.invoke('learning:explain-back-help', input),
  learningProgress: (projectId) => ipcRenderer.invoke('learning:progress', { projectId }),
  learningReadiness: () => ipcRenderer.invoke('learning:readiness', {}),
  updateLearningPreferences: (input) => ipcRenderer.invoke('learning:update-preferences', input),
  evaluateLearning: (request) => ipcRenderer.invoke('learning:evaluate', request),
  recordLearningLesson: (input) => ipcRenderer.invoke('learning:record-lesson', input),
  teachingLibrary: () => ipcRenderer.invoke('learning:teaching-library', {}),
  saveTeachingEntry: (input) => ipcRenderer.invoke('learning:save-teaching-entry', input),
  deleteTeachingEntry: (input) => ipcRenderer.invoke('learning:delete-teaching-entry', input),
  resetTeachingEntry: (input) => ipcRenderer.invoke('learning:reset-teaching-entry', input),
  generateTeachingDraft: (input) => ipcRenderer.invoke('learning:generate-teaching-draft', input),
  formatCode: (input) => ipcRenderer.invoke('code:format', input),
  gitFileInfo: (projectId, path) => ipcRenderer.invoke('git:file-info', { projectId, path }),
  rejectCheckpointHunks: (conversationId, turnId, filePath, hunkIds) => ipcRenderer.invoke('checkpoints:reject-hunks', { conversationId, turnId, filePath, hunkIds }),
  gitDiffStat: (projectId) => ipcRenderer.invoke('context:git-diff', { projectId }),
  saveAttachment: (name, dataUrl) => ipcRenderer.invoke('attachments:save', { name, dataUrl }),
  listWorkflowTemplates: (projectId) => ipcRenderer.invoke('workflows:list-templates', projectId ? { projectId } : {}),
  listWorkflowRuns: (projectId) => ipcRenderer.invoke('workflows:list-runs', projectId ? { projectId } : {}),
  startWorkflow: (request) => ipcRenderer.invoke('workflows:start', request),
  planTeam: (request) => ipcRenderer.invoke('team:plan', request),
  startTeam: (request) => ipcRenderer.invoke('team:start', request),
  teamRecord: (request) => ipcRenderer.invoke('team:record', request),
  clearTeamRecord: () => ipcRenderer.invoke('team:clear-record', {}),
  stopWorkflow: (workflowId) => ipcRenderer.invoke('workflows:stop', { workflowId }),
  resumeWorkflow: (workflowId) => ipcRenderer.invoke('workflows:resume', { workflowId }),
  onWorkflowChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, run: import('@kai/contracts').WorkflowRun): void => listener(run);
    ipcRenderer.on('workflows:changed', handler);
    return () => ipcRenderer.removeListener('workflows:changed', handler);
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
  previewContext: (request) => ipcRenderer.invoke('context:preview', request),
  previewInfo: (projectId) => ipcRenderer.invoke('preview:info', { projectId }),
  previewStatus: (projectId) => ipcRenderer.invoke('preview:status', { projectId }),
  startPreview: (request) => ipcRenderer.invoke('preview:start', request),
  stopPreview: (projectId) => ipcRenderer.invoke('preview:stop', { projectId }),
  runAgent: (request) => ipcRenderer.invoke('agents:run', request),
  cancelAgent: (conversationId) => ipcRenderer.invoke('agents:cancel', { conversationId }),
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
  onUpdateState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: UpdateState): void => listener(payload);
    ipcRenderer.on('app:update-state', handler);
    return () => ipcRenderer.removeListener('app:update-state', handler);
  },
  startTerminal: (projectId, shell, cols, rows) => ipcRenderer.invoke('terminal:start', { projectId, shell, cols, rows }),
  writeTerminal: (id, data) => ipcRenderer.invoke('terminal:write', { id, data }),
  resizeTerminal: (id, cols, rows) => ipcRenderer.invoke('terminal:resize', { id, cols, rows }),
  stopTerminalCommand: (id) => ipcRenderer.invoke('terminal:stop', { id }),
  onTerminalEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: TerminalEvent): void => listener(payload);
    ipcRenderer.on('terminal:event', handler);
    return () => ipcRenderer.removeListener('terminal:event', handler);
  },
  gitOverview: (projectId) => ipcRenderer.invoke('git:overview', { projectId }),
  gitStage: (projectId, paths, stage) => ipcRenderer.invoke('git:stage', { projectId, paths, stage }),
  gitCommit: (projectId, message) => ipcRenderer.invoke('git:commit', { projectId, message }),
  gitCheckout: (projectId, branch) => ipcRenderer.invoke('git:checkout', { projectId, branch }),
  gitCreateBranch: (projectId, name, checkout) => ipcRenderer.invoke('git:create-branch', { projectId, name, checkout }),
  gitSync: (projectId, action) => ipcRenderer.invoke('git:sync', { projectId, action }),
  gitDiff: (projectId, path, staged) => ipcRenderer.invoke('git:diff', { projectId, path, staged }),
  gitPullRequest: (projectId, title, body) => ipcRenderer.invoke('git:pull-request', { projectId, title, body }),
  verificationOverview: (projectId) => ipcRenderer.invoke('verification:overview', { projectId }),
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
  diagnosticsReport: (copy) => ipcRenderer.invoke('diagnostics:report', { copy }),
  dataLocations: () => ipcRenderer.invoke('diagnostics:data-locations', {}),
  recentLogs: (count) => ipcRenderer.invoke('diagnostics:recent-logs', { count }),
  windowState: () => ipcRenderer.invoke('window:state', {}),
  newWindow: () => ipcRenderer.invoke('window:new', {}),
};

contextBridge.exposeInMainWorld('kaiDesktop', bridge);
