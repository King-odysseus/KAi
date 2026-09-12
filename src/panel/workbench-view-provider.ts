import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import { createEventId, nowIso, type WorkbenchEvent } from '../core/events';
import type { AgentId, AutonomyMode, PermissionKey, RouteMode, WorkbenchState } from '../core/types';
import { estimateCost, getModelName, getContextWindow } from '../core/cost-estimator';
import { buildPromptWithContext, type ContextChip } from '../core/prompt-builder';
import type { WorkbenchOrchestrator } from '../orchestrator/orchestrator';
import { buildSkillPrompt, discoverSkills, skillCatalog, type SkillDefinition } from '../core/skills';
import type { GoalInput } from '../core/goal';
import type { Plan } from '../core/plan';
import type { PlanEvent } from '../orchestrator/plan-runner';
import type { PlanTemplate } from '../core/plan-templates';
import { listPlanTemplates, savePlanTemplate, deletePlanTemplate, templateToPlan } from '../core/plan-templates';
import { AGENT_PROVIDERS } from '../config/agent-catalog';
import { PERMISSION_KEY_INFO } from '../core/permissions';
import type { ProjectPreferences } from '../config/project-preferences';
import { diffFromCheckpoint } from '../orchestrator/checkpoints';
import { ConversationStore, type Conversation } from './conversation-store';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface WebviewMessage {
  type: 'ready' | 'startTask' | 'setAgent' | 'setRoute' | 'setAutonomy' | 'stop'
    | 'refreshCapabilities' | 'handoff' | 'approveDiff' | 'rejectDiff' | 'estimateCost' | 'openTab'
    | 'executePlan' | 'pausePlan' | 'resumePlan' | 'abortPlan' | 'compareTask'
    | 'loadTemplates' | 'saveTemplate' | 'deleteTemplate' | 'loadTemplate'
    | 'retryStep' | 'skipStep' | 'openLink'
    | 'searchFiles' | 'requestSelection' | 'requestGitDiffStat' | 'requestMemorySearch'
    | 'listSkills'
    | 'attachImage' | 'setCustomPermissions' | 'queueOverflow'
    | 'setGoal' | 'clearGoal' | 'pauseGoal' | 'resumeGoal' | 'completeGoal'
    | 'reviewChanges' | 'undoAllChanges' | 'rewindToHere' | 'respondToApproval'
    | 'newConversation' | 'listConversations' | 'searchConversations' | 'loadConversation'
    | 'renameConversation' | 'archiveConversation' | 'unarchiveConversation' | 'forkConversation'
    | 'pickCompareWinner' | 'discardCompare' | 'openCompareWorktree' | 'openView';
  prompt?: string;
  goal?: GoalInput;
  skills?: string[];
  agent?: AgentId;
  route?: RouteMode;
  autonomy?: AutonomyMode;
  targetAgent?: AgentId;
  eventId?: string;
  value?: string;
  url?: string;
  query?: string;
  contextChips?: ContextChip[];
  dataUrl?: string;
  name?: string;
  allowed?: Partial<Record<PermissionKey, boolean>>;
  taskId?: string;
  response?: 'once' | 'always' | 'deny';
  conversationId?: string;
  compareId?: string;
  side?: 'left' | 'right';
  /** Which panel the gear menu asked for. */
  view?: 'settings' | 'engineRoom' | 'memory' | 'sessions';
}

const AGENT_IDS: AgentId[] = ['claude', 'codex', 'qwen', 'gemini'];

export class WorkbenchViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'kai.workbench';

  /** All live webviews (sidebar view + any editor-tab panels), kept in sync. */
  private readonly webviews = new Set<vscode.Webview>();

  /** The sidebar view specifically — the only one with `.visible`/`.badge`. */
  private sidebarView: vscode.WebviewView | undefined;
  private unseenCount = 0;

  /** taskId of the run we already announced turnMeta for, so state changes
   * that don't start a new run (e.g. a plain agent/route switch) don't
   * re-announce. */
  private lastAnnouncedTaskId: string | undefined;

  private readonly conversationStore: ConversationStore | undefined;
  private currentConversation: Conversation | null = null;
  private saveTimer: NodeJS.Timeout | undefined;
  private skillDefinitions: SkillDefinition[] = [];
  private pendingPanel: 'goal' | 'skills' | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly orchestrator: WorkbenchOrchestrator,
    private readonly prefs?: ProjectPreferences,
    private readonly attachmentsDir?: string,
    storageDir?: string,
  ) {
    this.conversationStore = storageDir ? new ConversationStore(storageDir) : undefined;
    // Forward plan events to all webviews
    this.orchestrator.on('planEvent', (planEvent: PlanEvent) => {
      for (const webview of this.webviews) {
        void webview.postMessage({ type: 'planEvent', planEvent });
      }
      // Also emit a plan.update workbench event
      const plan = this.orchestrator.getPlan();
      if (plan) {
        const event: WorkbenchEvent = {
          id: createEventId('plan'),
          type: 'plan.update',
          taskId: plan.id,
          timestamp: nowIso(),
          plan,
        };
        this.postEvent(event);
      }
    });

    // Announce agent/route/model for a run the moment it starts, so the
    // chat can show a reply header before the first content event arrives.
    this.orchestrator.on('state', (s: WorkbenchState) => {
      if (s.isRunning && s.activeTaskId && s.activeTaskId !== this.lastAnnouncedTaskId) {
        this.lastAnnouncedTaskId = s.activeTaskId;
        void this.broadcast({
          type: 'turnMeta',
          taskId: s.activeTaskId,
          agent: s.activeAgent,
          route: s.route,
          modelName: getModelName(s.activeAgent, s.route),
        });
      }
    });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.attachWebview(webviewView.webview);
    this.sidebarView = webviewView;
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.clearUnseen();
    });
    webviewView.onDidDispose(() => {
      this.detachWebview(webviewView.webview);
      if (this.sidebarView === webviewView) this.sidebarView = undefined;
    });
  }

  /** Registers the `kai-checkpoint:` scheme so "Review in editor" can open a
   * real VS Code diff editor against a task's checkpoint content. Call once
   * at activation and push the returned Disposable into subscriptions. */
  registerCheckpointContentProvider(): vscode.Disposable {
    return vscode.workspace.registerTextDocumentContentProvider('kai-checkpoint', {
      provideTextDocumentContent: async (uri: vscode.Uri): Promise<string> => {
        const segments = uri.path.split('/').filter(Boolean);
        const [taskId, ...fileParts] = segments;
        if (!taskId || fileParts.length === 0) return '';
        try {
          return await this.orchestrator.readCheckpointFile(taskId, fileParts.join('/'));
        } catch {
          return '';
        }
      },
    });
  }

  /** Whether the sidebar chat view is currently the visible one — used to
   * decide whether a finished run needs a notification/badge. */
  isSidebarVisible(): boolean {
    return this.sidebarView?.visible ?? false;
  }

  /** Bumps the activity-bar badge — call when something happened (a run
   * finished, an approval is waiting) while the sidebar wasn't visible.
   * No-op for editor-tab panels, which don't support badges. */
  notifyUnseen(): void {
    if (!this.sidebarView) return;
    this.unseenCount++;
    this.sidebarView.badge = { value: this.unseenCount, tooltip: 'KAI has updates' };
  }

  private clearUnseen(): void {
    this.unseenCount = 0;
    if (this.sidebarView) this.sidebarView.badge = undefined;
  }

  /** Wire a webview (sidebar or editor panel) to the shared chat controller. */
  attachWebview(webview: vscode.Webview): void {
    webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    webview.html = this.getHtml(webview);
    webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.handleMessage(message, webview);
    });
    this.webviews.add(webview);
  }

  detachWebview(webview: vscode.Webview): void {
    this.webviews.delete(webview);
  }

  postEvent(event: WorkbenchEvent): void {
    this.recordEvent(event);
    for (const webview of this.webviews) {
      void webview.postMessage({ type: 'event', event });
    }
  }

  /** Appends an event to the current conversation's persisted transcript
   * (lazily created from the first event of a run) and saves, debounced so
   * a fast stream of deltas doesn't write to disk on every token. */
  private recordEvent(event: WorkbenchEvent): void {
    if (!this.conversationStore) return;
    if (event.taskId === 'workbench') return; // pure UI-level errors, not part of any conversation
    if (!this.currentConversation) {
      this.currentConversation = this.conversationStore.create(this.orchestrator.getLastPrompt());
    }
    const conv = this.currentConversation;
    conv.goal = this.orchestrator.getGoal();
    conv.events.push(event);
    conv.updatedAt = new Date().toISOString();
    if (event.agent && !conv.agents.includes(event.agent)) conv.agents.push(event.agent);
    if (event.type === 'cost.update' && event.amountUsd != null) conv.costUsd = event.amountUsd;
    this.scheduleConversationSave();
  }

  private scheduleConversationSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      if (this.currentConversation) void this.conversationStore?.save(this.currentConversation);
    }, 500);
  }

  private persistGoal(): void {
    if (!this.conversationStore) return;
    const goal = this.orchestrator.getGoal();
    if (!this.currentConversation && !goal) return;
    if (!this.currentConversation) {
      this.currentConversation = this.conversationStore.create(goal?.outcome || 'Goal');
    }
    this.currentConversation.goal = goal;
    this.currentConversation.updatedAt = new Date().toISOString();
    void this.conversationStore.save(this.currentConversation);
  }

  /** Marks the current conversation unread (a run finished, or an approval
   * is waiting, while the sidebar wasn't visible) — see extension.ts. */
  markCurrentConversationUnread(): void {
    if (this.currentConversation) {
      this.currentConversation.unread = true;
      void this.conversationStore?.save(this.currentConversation);
    }
  }

  /** Pushed on every active-editor change so the composer can show/refresh
   * its "active file" context chip. `undefined` clears it (no editor open,
   * or an unsaved/non-file document). */
  postActiveFile(relativePath: string | undefined): void {
    void this.broadcast({ type: 'activeFile', path: relativePath });
  }

  /** Pushed by the `KAI: Add Selection to Chat` command — adds a selection
   * chip to whichever webview is currently focused/visible. */
  postAddSelection(relativePath: string, startLine: number, endLine: number): void {
    void this.broadcast({ type: 'addSelection', path: relativePath, startLine, endLine });
  }

  private async handleMessage(message: WebviewMessage, webview: vscode.Webview): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.postState();
        await this.postCapabilities();
        if (this.pendingPanel) {
          const type = this.pendingPanel === 'goal' ? 'openGoal' : 'openSkills';
          this.pendingPanel = undefined;
          void webview.postMessage({ type });
        }
        break;
      case 'openTab':
        await vscode.commands.executeCommand('kai.openChatTab');
        break;
      case 'openView': {
        const commands: Record<string, string> = {
          settings: 'kai.openSettings',
          engineRoom: 'kai.openEngineRoom',
          memory: 'kai.openMemory',
          sessions: 'kai.openSessions',
        };
        const command = message.view ? commands[message.view] : undefined;
        if (command) await vscode.commands.executeCommand(command);
        break;
      }
      case 'refreshCapabilities':
        await this.postCapabilities();
        break;
      case 'startTask':
        if (message.prompt?.trim()) {
          try {
            const contextPrompt = buildPromptWithContext(message.prompt, message.contextChips ?? []);
            const finalPrompt = buildSkillPrompt(this.resolveSkills(message.skills ?? []), contextPrompt);
            await this.orchestrator.startTask({
              prompt: finalPrompt,
              agent: message.agent,
              route: message.route,
              autonomy: message.autonomy,
              goal: message.goal,
            });
            await this.postState();
          } catch (error) {
            this.postEvent({
              id: createEventId(), type: 'error', taskId: 'workbench', timestamp: nowIso(),
              message: error instanceof Error ? error.message : String(error), recoverable: true,
            });
          }
        }
        break;
      case 'setGoal':
        if (message.goal) {
          try {
            this.orchestrator.setGoal(message.goal);
            await this.postState();
          } catch (error) {
            this.postEvent({
              id: createEventId(), type: 'error', taskId: 'workbench', timestamp: nowIso(),
              message: error instanceof Error ? error.message : String(error), recoverable: true,
            });
          }
        }
        break;
      case 'clearGoal':
        await this.orchestrator.clearGoal();
        await this.postState();
        break;
      case 'pauseGoal':
        await this.orchestrator.pauseGoal();
        await this.postState();
        break;
      case 'resumeGoal':
        await this.orchestrator.resumeGoal();
        await this.postState();
        break;
      case 'completeGoal':
        await this.orchestrator.completeGoal();
        await this.postState();
        break;
      case 'executePlan':
        if (message.value) {
          try {
            const plan: Plan = JSON.parse(message.value);
            await this.orchestrator.executePlan(plan);
            await this.postState();
          } catch (error) {
            this.postEvent({
              id: createEventId(), type: 'error', taskId: 'workbench', timestamp: nowIso(),
              message: error instanceof Error ? error.message : String(error), recoverable: true,
            });
          }
        }
        break;
      case 'pausePlan':
        try {
          await this.orchestrator.pausePlan();
          await this.postState();
        } catch (error) {
          this.postEvent({
            id: createEventId(), type: 'error', taskId: 'workbench', timestamp: nowIso(),
            message: error instanceof Error ? error.message : String(error), recoverable: true,
          });
        }
        break;
      case 'resumePlan':
        try {
          await this.orchestrator.resumePlan();
          await this.postState();
        } catch (error) {
          this.postEvent({
            id: createEventId(), type: 'error', taskId: 'workbench', timestamp: nowIso(),
            message: error instanceof Error ? error.message : String(error), recoverable: true,
          });
        }
        break;
      case 'abortPlan':
        try {
          await this.orchestrator.abortPlan();
          await this.postState();
        } catch (error) {
          this.postEvent({
            id: createEventId(), type: 'error', taskId: 'workbench', timestamp: nowIso(),
            message: error instanceof Error ? error.message : String(error), recoverable: true,
          });
        }
        break;
      case 'loadTemplates':
        try {
          const plansDir = path.join(this.orchestrator['projectPath'] || process.cwd(), '.kai', 'plans');
          const templates = await listPlanTemplates(plansDir);
          void webview.postMessage({ type: 'templates', templates });
        } catch (error) {
          void webview.postMessage({ type: 'templates', templates: [] });
        }
        break;
      case 'saveTemplate':
        if (message.value) {
          try {
            const template: PlanTemplate = JSON.parse(message.value);
            const plansDir = path.join(this.orchestrator['projectPath'] || process.cwd(), '.kai', 'plans');
            await savePlanTemplate(plansDir, template);
            const templates = await listPlanTemplates(plansDir);
            void webview.postMessage({ type: 'templates', templates });
          } catch (error) {
            this.postEvent({
              id: createEventId(), type: 'error', taskId: 'workbench', timestamp: nowIso(),
              message: error instanceof Error ? error.message : String(error), recoverable: true,
            });
          }
        }
        break;
      case 'deleteTemplate':
        if (message.value) {
          try {
            const plansDir = path.join(this.orchestrator['projectPath'] || process.cwd(), '.kai', 'plans');
            await deletePlanTemplate(plansDir, message.value);
            const templates = await listPlanTemplates(plansDir);
            void webview.postMessage({ type: 'templates', templates });
          } catch (error) {
            this.postEvent({
              id: createEventId(), type: 'error', taskId: 'workbench', timestamp: nowIso(),
              message: error instanceof Error ? error.message : String(error), recoverable: true,
            });
          }
        }
        break;
      case 'loadTemplate':
        if (message.value) {
          try {
            const template: PlanTemplate = JSON.parse(message.value);
            const plan = templateToPlan(template, this.orchestrator.getState().route, this.orchestrator.getState().autonomy);
            void webview.postMessage({ type: 'templateLoaded', plan });
          } catch (error) {
            this.postEvent({
              id: createEventId(), type: 'error', taskId: 'workbench', timestamp: nowIso(),
              message: error instanceof Error ? error.message : String(error), recoverable: true,
            });
          }
        }
        break;
      case 'retryStep':
        if (message.eventId) {
          try {
            await this.orchestrator.retryPlanStep(message.eventId, message.value, message.agent);
            await this.postState();
          } catch (error) {
            this.postEvent({
              id: createEventId(), type: 'error', taskId: 'workbench', timestamp: nowIso(),
              message: error instanceof Error ? error.message : String(error), recoverable: true,
            });
          }
        }
        break;
      case 'skipStep':
        if (message.eventId) {
          try {
            await this.orchestrator.skipPlanStep(message.eventId);
            await this.postState();
          } catch (error) {
            this.postEvent({
              id: createEventId(), type: 'error', taskId: 'workbench', timestamp: nowIso(),
              message: error instanceof Error ? error.message : String(error), recoverable: true,
            });
          }
        }
        break;
      case 'compareTask':
        if (message.prompt?.trim() && message.agent && message.targetAgent) {
          try {
            await this.orchestrator.compareTask(message.prompt.trim(), message.agent, message.targetAgent);
            await this.postState();
          } catch (error) {
            this.postEvent({
              id: createEventId(), type: 'error', taskId: 'workbench', timestamp: nowIso(),
              message: error instanceof Error ? error.message : String(error), recoverable: true,
            });
          }
        }
        break;
      case 'pickCompareWinner':
        if (message.compareId && message.side) {
          try {
            await this.orchestrator.pickCompareWinner(message.compareId, message.side);
            void vscode.window.showInformationMessage(`KAI: applied the ${message.side} side's changes.`);
          } catch (error) {
            void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
          }
        }
        break;
      case 'discardCompare':
        if (message.compareId) {
          try {
            await this.orchestrator.discardCompare(message.compareId);
          } catch (error) {
            void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
          }
        }
        break;
      case 'openCompareWorktree':
        if (message.compareId && message.side) {
          const wtPath = this.orchestrator.getCompareWorktreePath(message.compareId, message.side);
          if (wtPath) {
            await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wtPath), { forceNewWindow: true });
          }
        }
        break;
      case 'handoff':
        if (message.targetAgent) {
          try {
            await this.orchestrator.handoff(message.targetAgent);
            await this.postState();
          } catch (error) {
            this.postEvent({
              id: createEventId(), type: 'error', taskId: 'workbench', timestamp: nowIso(),
              message: error instanceof Error ? error.message : String(error), recoverable: true,
            });
          }
        }
        break;
      case 'approveDiff':
        if (message.eventId) {
          try {
            await this.orchestrator.approveDiff(message.eventId);
            await this.postState();
          } catch (error) {
            this.postEvent({
              id: createEventId(), type: 'error', taskId: 'workbench', timestamp: nowIso(),
              message: error instanceof Error ? error.message : String(error), recoverable: true,
            });
          }
        }
        break;
      case 'rejectDiff':
        if (message.eventId) {
          try {
            this.orchestrator.rejectDiff(message.eventId);
            await this.postState();
          } catch (error) {
            this.postEvent({
              id: createEventId(), type: 'error', taskId: 'workbench', timestamp: nowIso(),
              message: error instanceof Error ? error.message : String(error), recoverable: true,
            });
          }
        }
        break;
      case 'setAgent':
        if (message.agent) { this.orchestrator.setAgent(message.agent); await this.postState(); }
        break;
      case 'setRoute':
        if (message.route) { this.orchestrator.setRoute(message.route); await this.postState(); }
        break;
      case 'setAutonomy':
        if (message.autonomy) { this.orchestrator.setAutonomy(message.autonomy); await this.postState(); }
        break;
      case 'estimateCost':
        if (message.prompt) {
          const est = estimateCost(
            message.prompt,
            message.agent || this.orchestrator.getState().activeAgent,
            message.route || this.orchestrator.getState().route,
          );
          void webview.postMessage({ type: 'costEstimate', estimate: est });
        }
        break;
      case 'stop':
        await this.orchestrator.stopActiveTask();
        await this.postState();
        break;
      case 'openLink':
        if (message.url && /^https?:\/\//i.test(message.url)) {
          await vscode.env.openExternal(vscode.Uri.parse(message.url));
        }
        break;
      case 'searchFiles':
        await this.handleSearchFiles(message.query ?? '', webview);
        break;
      case 'requestSelection':
        this.handleRequestSelection(webview);
        break;
      case 'requestGitDiffStat':
        await this.handleRequestGitDiffStat(webview);
        break;
      case 'requestMemorySearch':
        if (message.query?.trim()) {
          try {
            const summary = await this.orchestrator.searchMemory(message.query.trim());
            void webview.postMessage({ type: 'memorySearchResult', query: message.query.trim(), summary });
          } catch (error) {
            void webview.postMessage({
              type: 'memorySearchResult', query: message.query.trim(),
              summary: `Memory search failed: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }
        break;
      case 'listSkills':
        await this.sendSkills(webview);
        break;
      case 'attachImage':
        await this.handleAttachImage(message, webview);
        break;
      case 'setCustomPermissions':
        if (message.allowed) {
          this.orchestrator.setCustomPermissions(message.allowed);
          void this.prefs?.setCustomPermissions(message.allowed);
        }
        break;
      case 'reviewChanges':
        if (message.taskId) await this.handleReviewChanges(message.taskId);
        break;
      case 'undoAllChanges':
      case 'rewindToHere':
        if (message.taskId) {
          try {
            const result = await this.orchestrator.restoreToCheckpoint(message.taskId);
            const total = result.restored.length + result.deleted.length;
            void vscode.window.showInformationMessage(`KAI: reverted ${total} file${total === 1 ? '' : 's'}.`);
          } catch (error) {
            void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
          }
        }
        break;
      case 'respondToApproval':
        if (message.eventId && message.response) {
          try {
            await this.orchestrator.respondToApproval(message.eventId, message.response);
          } catch (error) {
            this.postEvent({
              id: createEventId(), type: 'error', taskId: 'workbench', timestamp: nowIso(),
              message: error instanceof Error ? error.message : String(error), recoverable: true,
            });
          }
        }
        break;
      case 'newConversation':
        this.orchestrator.startNewConversation();
        this.currentConversation = null;
        break;
      case 'listConversations':
        await this.sendConversationList(webview, '');
        break;
      case 'searchConversations':
        await this.sendConversationList(webview, message.query ?? '');
        break;
      case 'loadConversation':
        if (message.conversationId && this.conversationStore) {
          const conversation = await this.conversationStore.get(message.conversationId);
          if (conversation) {
            await this.conversationStore.setUnread(conversation.id, false);
            this.currentConversation = conversation;
            this.orchestrator.restoreGoal(conversation.goal ?? null);
            void webview.postMessage({ type: 'conversationLoaded', conversation });
          }
        }
        break;
      case 'renameConversation':
        if (message.conversationId && message.value && this.conversationStore) {
          await this.conversationStore.rename(message.conversationId, message.value);
          await this.sendConversationList(webview, '');
        }
        break;
      case 'archiveConversation':
        if (message.conversationId && this.conversationStore) {
          await this.conversationStore.setArchived(message.conversationId, true);
          await this.sendConversationList(webview, '');
        }
        break;
      case 'unarchiveConversation':
        if (message.conversationId && this.conversationStore) {
          await this.conversationStore.setArchived(message.conversationId, false);
          await this.sendConversationList(webview, '');
        }
        break;
      case 'forkConversation':
        if (message.conversationId && this.conversationStore) {
          await this.conversationStore.fork(message.conversationId);
          await this.sendConversationList(webview, '');
        }
        break;
    }
  }

  private async sendConversationList(webview: vscode.Webview, query: string): Promise<void> {
    if (!this.conversationStore) {
      void webview.postMessage({ type: 'conversationsList', conversations: [] });
      return;
    }
    const conversations = query ? await this.conversationStore.search(query) : await this.conversationStore.list();
    void webview.postMessage({ type: 'conversationsList', conversations });
  }

  private async sendSkills(webview: vscode.Webview): Promise<void> {
    try {
      this.skillDefinitions = await discoverSkills(this.orchestrator['projectPath']);
      void webview.postMessage({ type: 'skills', skills: skillCatalog(this.skillDefinitions) });
    } catch (error) {
      void webview.postMessage({
        type: 'skills',
        skills: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private resolveSkills(names: string[]): SkillDefinition[] {
    if (names.length === 0) return [];
    const wanted = new Set(names);
    return this.skillDefinitions.filter((skill) => wanted.has(skill.name));
  }

  /** Opens a read-only diff (checkpoint content vs current file) for every
   * changed file in a task, via the kai-checkpoint: content provider. */
  private async handleReviewChanges(taskId: string): Promise<void> {
    const checkpoint = this.orchestrator.getCheckpoint(taskId);
    const projectPath = this.orchestrator['projectPath'];
    if (!checkpoint || !projectPath) {
      void vscode.window.showWarningMessage('KAI: no checkpoint recorded for this task.');
      return;
    }
    const files = await diffFromCheckpoint(projectPath, checkpoint);
    for (const file of files) {
      const leftUri = vscode.Uri.parse(`kai-checkpoint:/${taskId}/${file.path}`);
      const rightUri = vscode.Uri.file(path.join(projectPath, file.path));
      await vscode.commands.executeCommand(
        'vscode.diff', leftUri, rightUri, `${file.path} (Before ↔ Agent's edit)`,
      );
    }
  }

  /** Fuzzy-ish file search for the composer's @ menu: substring match on the
   * workspace-relative path, capped at 20 results. */
  private async handleSearchFiles(query: string, webview: vscode.Webview): Promise<void> {
    try {
      const found = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,out,dist,coverage}/**', 200);
      const q = query.trim().toLowerCase();
      const folder = vscode.workspace.workspaceFolders?.[0];
      const results = found
        .map((uri) => ({ uri, rel: folder ? vscode.workspace.asRelativePath(uri, false) : uri.fsPath }))
        .filter((f) => !q || f.rel.toLowerCase().includes(q))
        .slice(0, 20)
        .map((f) => ({ path: f.rel }));
      void webview.postMessage({ type: 'searchFilesResult', query, files: results });
    } catch (error) {
      void webview.postMessage({ type: 'searchFilesResult', query, files: [], error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Reads the active editor's current selection for the "Current selection"
   * @ menu entry. Replies with `none: true` when there is no real selection. */
  private handleRequestSelection(webview: vscode.Webview): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void webview.postMessage({ type: 'selectionResult', none: true });
      return;
    }
    const rel = vscode.workspace.asRelativePath(editor.document.uri, false);
    void webview.postMessage({
      type: 'selectionResult',
      none: false,
      path: rel,
      startLine: editor.selection.start.line + 1,
      endLine: editor.selection.end.line + 1,
    });
  }

  /** Runs `git diff --stat` (including untracked files) for the "Uncommitted
   * changes" @ menu entry. */
  private async handleRequestGitDiffStat(webview: vscode.Webview): Promise<void> {
    const cwd = this.orchestrator['projectPath'];
    if (!cwd) {
      void webview.postMessage({ type: 'gitDiffStatResult', stat: '', error: 'No workspace folder open.' });
      return;
    }
    try {
      const { stdout } = await execAsync('git diff --stat HEAD', { cwd, timeout: 5000 });
      const stat = stdout.trim();
      void webview.postMessage({ type: 'gitDiffStatResult', stat: stat || 'No uncommitted changes.' });
    } catch (error) {
      void webview.postMessage({ type: 'gitDiffStatResult', stat: '', error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Saves a pasted/dropped image (data: URI from the webview) to the
   * extension's global storage so it survives across sessions, and hands
   * back a stable id the composer keeps as an 'image' context chip. */
  private async handleAttachImage(message: WebviewMessage, webview: vscode.Webview): Promise<void> {
    if (!message.dataUrl || !this.attachmentsDir) {
      void webview.postMessage({ type: 'attachImageResult', ok: false, error: 'Attachments are not available.' });
      return;
    }
    const match = /^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/.exec(message.dataUrl);
    if (!match) {
      void webview.postMessage({ type: 'attachImageResult', ok: false, error: 'Unsupported image type.' });
      return;
    }
    try {
      await fs.mkdir(this.attachmentsDir, { recursive: true });
      const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
      const id = createEventId('img');
      const filePath = path.join(this.attachmentsDir, `${id}.${ext}`);
      await fs.writeFile(filePath, Buffer.from(match[2], 'base64'));
      void webview.postMessage({ type: 'attachImageResult', ok: true, id, name: message.name || `${id}.${ext}`, path: filePath });
    } catch (error) {
      void webview.postMessage({ type: 'attachImageResult', ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  postState(): Promise<void> {
    this.persistGoal();
    const state = this.orchestrator.getState();
    const plan = this.orchestrator.getPlan();
    const goal = this.orchestrator.getGoal();
    return this.broadcast({ type: 'state', state, plan, goal });
  }

  /** Opens Goal mode from the command palette or a keybinding. */
  async openGoalEditor(): Promise<void> {
    if (this.webviews.size > 0) {
      await this.broadcast({ type: 'openGoal' });
      return;
    }
    this.pendingPanel = 'goal';
    await vscode.commands.executeCommand('kai.openWorkbench');
  }

  /** Opens the Skills browser from the command palette or a keybinding. */
  async openSkillsBrowser(): Promise<void> {
    if (this.webviews.size > 0) {
      await this.broadcast({ type: 'openSkills' });
      return;
    }
    this.pendingPanel = 'skills';
    await vscode.commands.executeCommand('kai.openWorkbench');
  }

  private async postCapabilities(): Promise<void> {
    const capabilities = await this.orchestrator.getCapabilities();
    const cognitive1 = await this.orchestrator.getCognitive1Health();
    await this.broadcast({ type: 'capabilities', capabilities, cognitive1 });
  }

  private async broadcast(message: unknown): Promise<void> {
    for (const webview of this.webviews) {
      await webview.postMessage(message);
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const state = JSON.stringify(this.orchestrator.getState()).replace(/</g, '\\u003c');
    const plan = JSON.stringify(this.orchestrator.getPlan()).replace(/</g, '\\u003c');
    const goal = JSON.stringify(this.orchestrator.getGoal()).replace(/</g, '\\u003c');
    const agentIdsJson = JSON.stringify(AGENT_IDS);
    const agentNames: Record<AgentId, string> = {
      claude: AGENT_PROVIDERS.claude.displayName,
      codex: AGENT_PROVIDERS.codex.displayName,
      qwen: AGENT_PROVIDERS.qwen.displayName,
      gemini: AGENT_PROVIDERS.gemini.displayName,
    };
    const agentNamesJson = JSON.stringify(agentNames);
    const agentMeta: Record<AgentId, { direct: string; proxy: string }> = {
      claude: { direct: getModelName('claude', 'direct'), proxy: getModelName('claude', 'proxy') },
      codex: { direct: getModelName('codex', 'direct'), proxy: getModelName('codex', 'proxy') },
      qwen: { direct: getModelName('qwen', 'direct'), proxy: getModelName('qwen', 'proxy') },
      gemini: { direct: getModelName('gemini', 'direct'), proxy: getModelName('gemini', 'proxy') },
    };
    const agentMetaJson = JSON.stringify(agentMeta);
    const contextWindows: Record<AgentId, { direct: number; proxy: number }> = {
      claude: { direct: getContextWindow('claude', 'direct'), proxy: getContextWindow('claude', 'proxy') },
      codex: { direct: getContextWindow('codex', 'direct'), proxy: getContextWindow('codex', 'proxy') },
      qwen: { direct: getContextWindow('qwen', 'direct'), proxy: getContextWindow('qwen', 'proxy') },
      gemini: { direct: getContextWindow('gemini', 'direct'), proxy: getContextWindow('gemini', 'proxy') },
    };
    const contextWindowsJson = JSON.stringify(contextWindows);
    const permissionKeyInfoJson = JSON.stringify(PERMISSION_KEY_INFO);
    const customPermissionsJson = JSON.stringify(this.prefs?.getCustomPermissions() ?? {});

    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'src', 'panel', 'workbench.css'),
    );
    const markdownUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'src', 'panel', 'markdown.js'),
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'src', 'panel', 'workbench.js'),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};">
  <link rel="stylesheet" href="${styleUri}">
  <title>KAI Agent Workbench</title>
</head>
<body>
  <div class="app">
    <div class="topbar">
      <svg class="brand-mark" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect width="128" height="128" rx="24" fill="#111827"/>
        <path d="M30 84V44H40V60L55 44H68L50 62L70 84H57L40 65V84H30Z" fill="#F9FAFB"/>
        <path d="M73 84L88 44H100L115 84H104L101 75H87L84 84H73ZM90 66H98L94 54L90 66Z" fill="#38BDF8"/>
      </svg>
      <span class="brand-title">K<span class="accent">A</span>I</span>
      <span class="topbar-spacer"></span>
      <span id="statePill"></span>
      <span id="costPill"></span>
      <button id="goalBtn" class="ghost-btn icon-only" title="Start or edit a goal (/goal)" aria-label="Goal">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>
      </button>
      <button id="skillsBtn" class="ghost-btn icon-only" title="Browse skills" aria-label="Skills">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7z"/><path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8z"/></svg>
      </button>
      <button id="newChat" class="ghost-btn" title="Start a new chat (clears this transcript)">＋ New</button>
      <button id="gearBtn" class="ghost-btn gear-btn" title="History, details, and settings" aria-haspopup="menu" aria-expanded="false">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3.2"/>
          <path d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.5-2-3.4-2.3 1a7.6 7.6 0 0 0-1.7-1l-.3-2.5h-4l-.3 2.5a7.6 7.6 0 0 0-1.7 1l-2.3-1-2 3.4L4.6 11a7.6 7.6 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a7.6 7.6 0 0 0 1.7 1l.3 2.5h4l.3-2.5a7.6 7.6 0 0 0 1.7-1l2.3 1 2-3.4z"/>
        </svg>
      </button>
    </div>

    <div class="history-panel" id="historyPanel" style="display:none;">
      <div class="history-header">
        <input type="text" id="historySearch" placeholder="Search conversations…" />
        <button id="historyClose" class="ibtn" title="Close">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div class="history-list" id="historyList"></div>
    </div>

    <div class="skills-panel" id="skillsPanel" style="display:none;">
      <div class="history-header">
        <input type="text" id="skillsSearch" placeholder="Search skills…" />
        <button id="skillsClose" class="ibtn" title="Close">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div class="skills-list" id="skillsList"></div>
    </div>

    <div class="chat" id="chat">
      <div class="empty-state" id="emptyState">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 3l1.9 4.3L18 9l-4.1 1.7L12 15l-1.9-4.3L6 9l4.1-1.7z"/>
          <path d="M19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9z"/>
        </svg>
        <div class="empty-title">Ready when you are</div>
        <div class="empty-sub">Send a message to KAI, use <code>/goal</code> for durable work, or type <code>$</code> to invoke a skill.</div>
      </div>
    </div>

    <div class="composer">
      <div class="goal-editor" id="goalEditor" style="display:none;">
        <div class="goal-editor-head">
          <span class="goal-editor-title">Goal</span>
          <span class="goal-editor-note">Outcome, constraints, and proof of completion</span>
        </div>
        <label class="goal-field"><span>Outcome</span><textarea id="goalOutcome" rows="2" placeholder="What should be true when this work is done?"></textarea></label>
        <label class="goal-field"><span>Constraints</span><textarea id="goalConstraints" rows="2" placeholder="Required tools, boundaries, or approaches to avoid"></textarea></label>
        <label class="goal-field"><span>Verification</span><textarea id="goalVerification" rows="2" placeholder="Tests, measurements, or review criteria that prove completion"></textarea></label>
        <div class="goal-editor-actions">
          <button id="goalCancel" class="plan-btn secondary" type="button">Cancel</button>
          <button id="goalSave" class="plan-btn secondary" type="button">Save</button>
          <button id="goalStart" class="plan-btn primary" type="button">Start goal</button>
        </div>
      </div>

      <div class="plan-editor" id="planEditor" style="display:none;">
        <div class="plan-header">
          <div class="plan-template-row"><input type="text" id="planTitle" class="plan-title-input" placeholder="Workflow title…" /><select id="planTemplate" class="plan-template-select"><option value="">Load template…</option></select></div>
          <span class="plan-step-count" id="planStepCount">0 steps</span>
        </div>
        <div class="plan-steps" id="planSteps"></div>
        <div class="plan-actions">
          <button id="addStep" class="plan-btn secondary">+ Add step</button>
          <button id="saveTemplateBtn" class="plan-btn secondary template-save-btn">Save template</button><button id="runPlan" class="plan-btn primary">▶ Run workflow</button>
        </div>
      </div>

      <div class="plan-progress" id="planProgress" style="display:none;"></div>

      <div class="goal-progress" id="goalProgress" style="display:none;"></div>

      <div class="queue-list" id="queueList"></div>

      <div class="ctx-chip-row" id="ctxChipRow" style="display:none;"></div>

      <div class="composer-box" id="composerBox">
        <textarea id="prompt" rows="1" placeholder="Ask KAI, /goal for a target, $ for skills"></textarea>
        <div class="composer-toolbar">
          <button id="attachBtn" class="ibtn" type="button" title="Attach an image">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11l-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7"/></svg>
          </button>
          <input type="file" id="imageFileInput" accept="image/png,image/jpeg,image/gif,image/webp" style="display:none;" />
          <button id="atBtn" class="ibtn" type="button" title="Add context">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1"/></svg>
          </button>
          <button id="modeChip" class="chip-btn" type="button" title="Permission mode (Shift+Tab to cycle)"></button>
          <button id="agentChip" class="chip-btn" type="button" title="Agent and route"></button>
          <span class="ctx-meter" id="ctxMeter" title="Context used" style="display:none;"></span>
          <select id="compareAgentB" class="chip-btn" title="Compare against" style="display:none;">
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
            <option value="qwen">Qwen</option>
            <option value="gemini">Gemini</option>
          </select>
          <button id="compareToggle" class="plan-toggle" type="button" title="Compare: run two agents on the same prompt side by side">⇶</button>
          <button id="planToggle" class="plan-toggle" type="button" title="Workflow mode: define multi-step agent runs">≡</button>
          <button id="send" type="button">Send</button>
        </div>
      </div>
      <div class="cost-estimate" id="costEstimate"></div>
      <div class="composer-footer">
        <span>Enter to send · Ctrl+Shift+Enter to steer now</span>
        <span id="sessionMeta"></span>
      </div>
      <div class="slash-hint">
        <code>/goal</code> <code>/skills</code>
        <code>/agent</code> <code>/route</code> <code>/handoff</code>
        <code>/review</code> <code>/implement</code> <code>/debug</code>
        <code>/explain</code> <code>/test</code>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    // Seed initial state before loading the main script
    window.__KAI_INITIAL_STATE__ = ${state};
    window.__KAI_INITIAL_PLAN__ = ${plan};
    window.__KAI_INITIAL_GOAL__ = ${goal};
    window.__KAI_AGENT_IDS__ = ${agentIdsJson};
    window.__KAI_AGENT_NAMES__ = ${agentNamesJson};
    window.__KAI_AGENT_MODELS__ = ${agentMetaJson};
    window.__KAI_CONTEXT_WINDOWS__ = ${contextWindowsJson};
    window.__KAI_PERMISSION_KEYS__ = ${permissionKeyInfoJson};
    window.__KAI_CUSTOM_PERMISSIONS__ = ${customPermissionsJson};
  </script>
  <script nonce="${nonce}" src="${markdownUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i += 1) nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  return nonce;
}
