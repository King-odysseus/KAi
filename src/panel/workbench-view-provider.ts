import * as vscode from 'vscode';
import { createEventId, nowIso, type WorkbenchEvent } from '../core/events';
import type { AgentId, AutonomyMode, RouteMode, WorkbenchState } from '../core/types';
import { estimateCost } from '../core/cost-estimator';
import type { WorkbenchOrchestrator } from '../orchestrator/orchestrator';

interface WebviewMessage {
  type: 'ready' | 'startTask' | 'setAgent' | 'setRoute' | 'setAutonomy' | 'stop'
    | 'refreshCapabilities' | 'handoff' | 'approveDiff' | 'rejectDiff' | 'estimateCost';
  prompt?: string;
  agent?: AgentId;
  route?: RouteMode;
  autonomy?: AutonomyMode;
  targetAgent?: AgentId;
  eventId?: string;
}

const AGENT_IDS: AgentId[] = ['claude', 'codex', 'qwen', 'gemini'];

export class WorkbenchViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'kai.workbench';

  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly orchestrator: WorkbenchOrchestrator,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.handleMessage(message);
    });
  }

  postEvent(event: WorkbenchEvent): void {
    void this.view?.webview.postMessage({ type: 'event', event });
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.postState();
        await this.postCapabilities();
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
          void this.view?.webview.postMessage({ type: 'costEstimate', estimate: est });
        }
        break;
      case 'stop':
        await this.orchestrator.stopActiveTask();
        await this.postState();
        break;
    }
  }

  private async postState(): Promise<void> {
    const state = this.orchestrator.getState();
    await this.view?.webview.postMessage({ type: 'state', state });
  }

  private async postCapabilities(): Promise<void> {
    const capabilities = await this.orchestrator.getCapabilities();
    const cognitive1 = await this.orchestrator.getCognitive1Health();
    await this.view?.webview.postMessage({ type: 'capabilities', capabilities, cognitive1 });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const state = JSON.stringify(this.orchestrator.getState()).replace(/</g, '\\u003c');
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
    </div>

    <div class="chat" id="chat">
      <div class="empty-state" id="emptyState">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 3l1.9 4.3L18 9l-4.1 1.7L12 15l-1.9-4.3L6 9l4.1-1.7z"/>
          <path d="M19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9z"/>
        </svg>
        <div class="empty-title">Ready when you are</div>
        <div class="empty-sub">Send a message to KAI, or pick a template below. Agents, keys and the proxy are in the <strong>Settings</strong> tab.</div>
      </div>
    </div>

    <div class="composer">
      <div class="templates" id="templates">
        <button data-tpl="review">Review</button>
        <button data-tpl="implement">Implement</button>
        <button data-tpl="debug">Debug</button>
        <button data-tpl="explain">Explain</button>
        <button data-tpl="test">Test</button>
      </div>
      <div class="controls">
        <select id="agent" title="Agent">
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
