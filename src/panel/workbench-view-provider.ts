import * as vscode from 'vscode';
import { createEventId, nowIso, type WorkbenchEvent } from '../core/events';
import type { AgentId, AutonomyMode, RouteMode, WorkbenchState } from '../core/types';
import { estimateCost } from '../core/cost-estimator';
import type { WorkbenchOrchestrator } from '../orchestrator/orchestrator';
import type { Plan } from '../core/plan';
import type { PlanEvent } from '../orchestrator/plan-runner';
import type { PlanTemplate } from '../core/plan-templates';
import { listPlanTemplates, savePlanTemplate, deletePlanTemplate, templateToPlan } from '../core/plan-templates';
import * as path from 'path';

interface WebviewMessage {
  type: 'ready' | 'startTask' | 'setAgent' | 'setRoute' | 'setAutonomy' | 'stop'
    | 'refreshCapabilities' | 'handoff' | 'approveDiff' | 'rejectDiff' | 'estimateCost' | 'openTab'
    | 'executePlan' | 'pausePlan' | 'resumePlan' | 'abortPlan' | 'compareTask'
    | 'loadTemplates' | 'saveTemplate' | 'deleteTemplate' | 'loadTemplate'
    | 'retryStep' | 'skipStep';
  prompt?: string;
  agent?: AgentId;
  route?: RouteMode;
  autonomy?: AutonomyMode;
  targetAgent?: AgentId;
  eventId?: string;
  value?: string;
}

const AGENT_IDS: AgentId[] = ['claude', 'codex', 'qwen', 'gemini'];

export class WorkbenchViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'kai.workbench';

  /** All live webviews (sidebar view + any editor-tab panels), kept in sync. */
  private readonly webviews = new Set<vscode.Webview>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly orchestrator: WorkbenchOrchestrator,
  ) {
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
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.attachWebview(webviewView.webview);
    webviewView.onDidDispose(() => this.detachWebview(webviewView.webview));
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
    for (const webview of this.webviews) {
      void webview.postMessage({ type: 'event', event });
    }
  }

  private async handleMessage(message: WebviewMessage, webview: vscode.Webview): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.postState();
        await this.postCapabilities();
        break;
      case 'openTab':
        await vscode.commands.executeCommand('kai.openChatTab');
        break;
      case 'refreshCapabilities':
        await this.postCapabilities();
        break;
      case 'startTask':
        if (message.prompt?.trim()) {
          try {
            await this.orchestrator.startTask({
              prompt: message.prompt.trim(),
              agent: message.agent,
              route: message.route,
              autonomy: message.autonomy,
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
            await this.orchestrator.retryPlanStep(message.eventId, message.value);
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
    }
  }

  postState(): Promise<void> {
    const state = this.orchestrator.getState();
    const plan = this.orchestrator.getPlan();
    return this.broadcast({ type: 'state', state, plan });
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
    const agentIdsJson = JSON.stringify(AGENT_IDS);

    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'src', 'panel', 'workbench.css'),
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
      <button id="newChat" class="ghost-btn" title="Start a new chat (clears this transcript)">＋ New</button>
      <button id="openTab" class="ghost-btn" title="Open KAI as a full editor tab (maximize / split screen)">⤢ Tab</button>
      <button id="detailsToggle" class="ghost-btn" title="Show agent activity log (lifecycle, memory, raw, cost)">Details</button>
    </div>

    <div class="chat" id="chat">
      <div class="empty-state" id="emptyState">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 3l1.9 4.3L18 9l-4.1 1.7L12 15l-1.9-4.3L6 9l4.1-1.7z"/>
          <path d="M19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9z"/>
        </svg>
        <div class="empty-title">Ready when you are</div>
        <div class="empty-sub">Send a message to KAI, or pick a template below. Switch to <strong>Plan</strong> mode for multi-step agent workflows.</div>
      </div>
    </div>

    <div class="composer">
      <div class="plan-editor" id="planEditor" style="display:none;">
        <div class="plan-header">
          <div class="plan-template-row"><input type="text" id="planTitle" class="plan-title-input" placeholder="Plan title…" /><select id="planTemplate" class="plan-template-select"><option value="">Load template…</option></select></div>
          <span class="plan-step-count" id="planStepCount">0 steps</span>
        </div>
        <div class="plan-steps" id="planSteps"></div>
        <div class="plan-actions">
          <button id="addStep" class="plan-btn secondary">+ Add step</button>
          <button id="saveTemplateBtn" class="plan-btn secondary template-save-btn">Save template</button><button id="runPlan" class="plan-btn primary">▶ Run plan</button>
        </div>
      </div>

      <div class="plan-progress" id="planProgress" style="display:none;"></div>

      <div class="templates" id="templates">
        <button data-tpl="review">Review</button>
        <button data-tpl="implement">Implement</button>
        <button data-tpl="debug">Debug</button>
        <button data-tpl="explain">Explain</button>
        <button data-tpl="test">Test</button>
      </div>
      <div class="controls">
        <select id="agentB" class="compare-agent" title="Compare agent" style="display:none;"><option value="claude">Claude</option><option value="codex">Codex</option><option value="qwen">Qwen</option><option value="gemini">Gemini</option></select><select id="agent" title="Agent">
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
          <option value="qwen">Qwen</option>
          <option value="gemini">Gemini</option>
        </select>
        <select id="route" title="Route">
          <option value="direct">Direct</option>
          <option value="proxy">Proxy</option>
        </select>
        <select id="autonomy" title="Autonomy">
          <option value="review">Review</option>
          <option value="auto">Auto</option>
          <option value="custom">Custom</option>
        </select>
      </div>
      <div class="input-row">
        <textarea id="prompt" rows="1" placeholder="Message KAI…  (Enter to send, Shift+Enter for newline)"></textarea>
        <button id="compareBtn" class="plan-toggle compare-btn" title="Compare: run two agents on the same prompt side-by-side">⇶</button><button id="planToggle" class="plan-toggle" title="Plan mode: define multi-step agent workflows">≡</button>
        <button id="send">Send</button>
      </div>
      <div class="cost-estimate" id="costEstimate"></div>
      <div class="slash-hint">
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
    window.__KAI_AGENT_IDS__ = ${agentIdsJson};
  </script>
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