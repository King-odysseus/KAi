import { contextBridge, ipcRenderer } from 'electron';
import type { AgentRunEvent, KaiDesktopBridge } from '@kai/contracts';

const bridge: KaiDesktopBridge = {
  bootstrap: () => ipcRenderer.invoke('app:get-bootstrap', {}),
  chooseProject: () => ipcRenderer.invoke('projects:choose', {}),
  openProject: (id) => ipcRenderer.invoke('projects:open', { id }),
  removeProject: (id) => ipcRenderer.invoke('projects:remove', { id }),
  getSettings: () => ipcRenderer.invoke('settings:get', {}),
  updateSettings: (update) => ipcRenderer.invoke('settings:update', update),
  serviceStatus: () => ipcRenderer.invoke('services:status', {}),
  startService: (kind) => ipcRenderer.invoke('services:start', { kind }),
  stopService: (kind) => ipcRenderer.invoke('services:stop', { kind }),
  restartService: (kind) => ipcRenderer.invoke('services:restart', { kind }),
  rotateServiceToken: (kind) => ipcRenderer.invoke('services:rotate-token', { kind }),
  copyServiceToken: (kind) => ipcRenderer.invoke('services:copy-token', { kind }),
  brainOverview: () => ipcRenderer.invoke('brain:overview', {}),
  searchBrain: (request) => ipcRenderer.invoke('brain:search', request),
  updateBrainField: (request) => ipcRenderer.invoke('brain:update-field', request),
  proxyOverview: () => ipcRenderer.invoke('proxy:overview', {}),
  proxyHistory: (request) => ipcRenderer.invoke('proxy:history', request ?? {}),
  proxyHistoryDetail: (id) => ipcRenderer.invoke('proxy:history-detail', { id }),
  clearProxyHistory: () => ipcRenderer.invoke('proxy:clear-history', {}),
  getPreferences: (projectId) => ipcRenderer.invoke('preferences:get', { projectId }),
  updatePreferences: (preferences) => ipcRenderer.invoke('preferences:update', preferences),
  credentialStatus: () => ipcRenderer.invoke('credentials:status', {}),
  setCredential: (id, value) => ipcRenderer.invoke('credentials:set', { id, value }),
  clearCredential: (id) => ipcRenderer.invoke('credentials:clear', { id }),
  listConversations: () => ipcRenderer.invoke('conversations:list', {}),
  getConversation: (id) => ipcRenderer.invoke('conversations:get', { id }),
  createConversation: (projectId, firstPrompt) =>
    ipcRenderer.invoke('conversations:create', { projectId, firstPrompt }),
  saveConversation: (conversation) => ipcRenderer.invoke('conversations:save', conversation),
  deleteConversation: (id) => ipcRenderer.invoke('conversations:delete', { id }),
  agentCapabilities: () => ipcRenderer.invoke('agents:capabilities', {}),
  directApiCapability: () => ipcRenderer.invoke('agents:api-capability', {}),
  previewContext: (request) => ipcRenderer.invoke('context:preview', request),
  runAgent: (request) => ipcRenderer.invoke('agents:run', request),
  cancelAgent: (conversationId) => ipcRenderer.invoke('agents:cancel', { conversationId }),
  signInAgent: (agent) => ipcRenderer.invoke('agents:sign-in', { agent }),
  respondToApproval: (request) => ipcRenderer.invoke('agents:approval-response', request),
  onAgentEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: AgentRunEvent): void => listener(payload);
    ipcRenderer.on('agents:event', handler);
    return () => ipcRenderer.removeListener('agents:event', handler);
  },
  dataLocations: () => ipcRenderer.invoke('diagnostics:data-locations', {}),
  recentLogs: (count) => ipcRenderer.invoke('diagnostics:recent-logs', { count }),
  windowState: () => ipcRenderer.invoke('window:state', {}),
};

contextBridge.exposeInMainWorld('kaiDesktop', bridge);
