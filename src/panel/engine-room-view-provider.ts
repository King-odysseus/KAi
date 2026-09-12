import * as vscode from 'vscode';
import type { BackupManager, BackupEntry } from '../config/backup-manager';
import type { WorkbenchOrchestrator } from '../orchestrator/orchestrator';
import type { AgentCapability } from '../core/types';
import type { ProxyManager, ProxyStatus } from '../proxy/proxy-manager';

interface EngineRoomMessage {
  type: 'ready' | 'refresh' | 'listBackups';
}

export class EngineRoomViewProvider {
  // More than one tab can be open at once, so every dashboard/backup push fans
  // out to all of them.
  private readonly webviews = new Set<vscode.Webview>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly orchestrator: WorkbenchOrchestrator,
    private readonly backupManager: BackupManager,
    private readonly configDir: string,
    private readonly proxyManager?: ProxyManager,
  ) {
    // Registered once here rather than in resolveWebviewView, which re-fires on
    // every sidebar reveal and would stack duplicate listeners.
    this.proxyManager?.on('status', () => {
      void this.postDashboard();
    });
  }

  /** Wire an editor-tab webview to this provider. */
  attachWebview(webview: vscode.Webview): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webview.html = this.getHtml(webview);
    webview.onDidReceiveMessage((message: EngineRoomMessage) => {
      if (message.type === 'ready' || message.type === 'refresh') {
        void this.postDashboard();
        void this.postBackups();
      }
      if (message.type === 'listBackups') {
        void this.postBackups();
      }
    });
    this.webviews.add(webview);
  }

  detachWebview(webview: vscode.Webview): void {
    this.webviews.delete(webview);
  }

  refresh(): void {
    void this.postDashboard();
    void this.postBackups();
  }

  private async postDashboard(): Promise<void> {
    const capabilities = await this.orchestrator.getCapabilities();
    const cognitive1 = await this.orchestrator.getCognitive1Health();
    const proxyStatus = this.proxyManager?.getStatus();
    const proxyHealth = this.proxyManager ? await this.proxyManager.health() : null;

    const message = {
      type: 'dashboard',
      capabilities,
      cognitive1,
      proxyStatus,
      proxyHealth,
    };
    for (const webview of this.webviews) {
      await webview.postMessage(message);
    }
  }

  private async postBackups(): Promise<void> {
    const backups = await this.backupManager.listBackups(this.configDir);
    for (const webview of this.webviews) {
      await webview.postMessage({ type: 'backups', backups });
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>KAI Engine Room</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      --kai-accent: #38bdf8;
      --kai-accent-strong: #0ea5e9;
      --kai-accent-soft: rgba(56, 189, 248, 0.14);
      --kai-border: color-mix(in srgb, var(--vscode-panel-border) 80%, transparent);
      --kai-surface: color-mix(in srgb, var(--vscode-editor-background) 88%, transparent);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 14px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 9px;
      margin-bottom: 16px;
    }
    .brand-mark {
      width: 26px;
      height: 26px;
      border-radius: 7px;
      flex: none;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2), 0 4px 12px rgba(0, 0, 0, 0.12);
    }
    .brand-title { font-size: 13px; font-weight: 700; letter-spacing: 0.2px; line-height: 1.1; }
    .brand-title .accent { color: var(--kai-accent); }
    .brand-sub {
      font-size: 10px;
      letter-spacing: 0.6px;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
    }
    h3 {
      margin: 0 0 8px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.6px;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
    }
    .section { margin-bottom: 18px; }
    .card {
      border: 1px solid var(--kai-border);
      border-radius: 8px;
      padding: 11px 12px;
      margin-bottom: 8px;
      background: var(--kai-surface);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
    }
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      margin-bottom: 7px;
    }
    .card-header strong { font-size: 13px; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 9px;
      border-radius: 999px;
      border: 1px solid var(--kai-border);
      white-space: nowrap;
    }
    .badge::before {
      content: '';
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
      flex: none;
    }
    .badge.ok {
      color: var(--vscode-testing-iconPassed);
      border-color: color-mix(in srgb, var(--vscode-testing-iconPassed) 45%, transparent);
      background: color-mix(in srgb, var(--vscode-testing-iconPassed) 10%, transparent);
    }
    .badge.warn {
      color: var(--vscode-testing-iconQueued);
      border-color: color-mix(in srgb, var(--vscode-testing-iconQueued) 45%, transparent);
      background: color-mix(in srgb, var(--vscode-testing-iconQueued) 10%, transparent);
    }
    .badge.err {
      color: var(--vscode-testing-iconFailed);
      border-color: color-mix(in srgb, var(--vscode-testing-iconFailed) 45%, transparent);
      background: color-mix(in srgb, var(--vscode-testing-iconFailed) 10%, transparent);
    }
    .detail { font-size: 12px; color: var(--vscode-descriptionForeground); line-height: 1.5; }
    .detail-row { display: flex; gap: 6px; font-size: 11px; flex-wrap: wrap; }
    .detail-row span {
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-textCodeBlock-background);
      border-radius: 4px;
      padding: 1px 7px;
    }
    button {
      cursor: pointer;
      color: #05202e;
      background: linear-gradient(180deg, var(--kai-accent) 0%, var(--kai-accent-strong) 100%);
      border: 1px solid var(--kai-accent-strong);
      border-radius: 6px;
      padding: 7px 16px;
      font: inherit;
      font-size: 12px;
      font-weight: 600;
      transition: filter 0.12s ease, box-shadow 0.12s ease;
    }
    button:hover { filter: brightness(1.06); box-shadow: 0 2px 8px var(--kai-accent-soft); }
    .backup-list { font-size: 12px; }
    .backup-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 0;
      border-bottom: 1px solid var(--kai-border);
    }
    .backup-item:last-child { border-bottom: none; }
    .backup-name { font-weight: 600; }
    .backup-meta { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .empty { color: var(--vscode-descriptionForeground); font-style: italic; font-size: 12px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="brand">
    <svg class="brand-mark" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect width="128" height="128" rx="24" fill="#111827"/>
      <path d="M30 84V44H40V60L55 44H68L50 62L70 84H57L40 65V84H30Z" fill="#F9FAFB"/>
      <path d="M73 84L88 44H100L115 84H104L101 75H87L84 84H73ZM90 66H98L94 54L90 66Z" fill="#38BDF8"/>
    </svg>
    <div>
      <div class="brand-title">K<span class="accent">A</span>I <span style="opacity:.7;font-weight:600;">Engine Room</span></div>
      <div class="brand-sub">Diagnostics &amp; Config</div>
    </div>
  </div>
  <div id="root"></div>
  <button id="refresh">Refresh</button>
  <script nonce="${nonce}">
    var vscode = acquireVsCodeApi();
    var root = document.getElementById('root');
    var state = {};

    function renderDashboard(data) {
      state.capabilities = data.capabilities;
      state.cognitive1 = data.cognitive1;
      state.proxyStatus = data.proxyStatus;
      state.proxyHealth = data.proxyHealth;
      renderAll();
    }

    function renderBackups(data) {
      state.backups = data.backups;
      renderAll();
    }

    function renderAll() {
      var html = '';

      // Proxy
      html += '<div class="section"><h3>Proxy</h3>';
      if (state.proxyStatus) {
        var cls = state.proxyStatus.running ? 'ok' : 'err';
        html += '<div class="card">';
        html += '<div class="card-header"><strong>ClaudeCode-Proxy</strong><span class="badge ' + cls + '">' + (state.proxyStatus.running ? 'Running' : 'Stopped') + '</span></div>';
        html += '<div class="detail-row">';
        html += '<span>Port: ' + state.proxyStatus.port + '</span>';
        if (state.proxyStatus.pid) html += '<span>PID: ' + state.proxyStatus.pid + '</span>';
        if (state.proxyStatus.uptimeMs) html += '<span>Uptime: ' + Math.round(state.proxyStatus.uptimeMs / 1000) + 's</span>';
        html += '</div>';
        if (state.proxyHealth) html += '<div class="detail" style="margin-top:4px;">Health: ' + state.proxyHealth.detail + '</div>';
        if (state.proxyStatus.error) html += '<div class="detail" style="color:var(--vscode-testing-iconFailed);">' + state.proxyStatus.error + '</div>';
        html += '</div>';
      } else {
        html += '<div class="card"><div class="detail">Proxy not configured. Set kai.proxyScript to enable.</div></div>';
      }
      html += '</div>';

      // C1
      if (state.cognitive1) {
        html += '<div class="section"><h3>Cognitive1</h3>';
        html += '<div class="card">';
        html += '<div class="card-header"><strong>Brain</strong><span class="badge ' + (state.cognitive1.available ? 'ok' : 'warn') + '">' + (state.cognitive1.available ? 'Online' : 'Offline') + '</span></div>';
        html += '<div class="detail">' + state.cognitive1.detail + '</div>';
        html += '</div></div>';
      }

      // Agents
      if (state.capabilities) {
        html += '<div class="section"><h3>Agents</h3>';
        for (var i = 0; i < state.capabilities.length; i++) {
          var c = state.capabilities[i];
          var ccls = c.available ? 'ok' : 'warn';
          html += '<div class="card">';
          html += '<div class="card-header"><strong>' + c.displayName + '</strong><span class="badge ' + ccls + '">' + (c.available ? (c.version || 'Ready') : 'Missing') + '</span></div>';
          html += '<div class="detail-row">';
          html += '<span>Routes: ' + c.supportsRoutes.join(', ') + '</span>';
          html += '<span>Autonomy: ' + c.supportsAutonomy.join(', ') + '</span>';
          html += '<span>Tools: ' + (c.supportsTools ? 'yes' : 'no') + '</span>';
          html += '<span>MCP: ' + (c.supportsMcp ? 'yes' : 'no') + '</span>';
          if (c.contextWindow) html += '<span>Context: ' + Math.round(c.contextWindow / 1000) + 'k</span>';
          html += '</div>';
          if (!c.available && c.unavailableReason) html += '<div class="detail" style="margin-top:4px;">' + c.unavailableReason + '</div>';
          html += '</div>';
        }
        html += '</div>';
      }

      // Backups
      html += '<div class="section"><h3>Config Backups</h3>';
      html += '<div class="card">';
      if (state.backups && state.backups.length > 0) {
        html += '<div class="backup-list">';
        for (var j = 0; j < state.backups.length; j++) {
          var b = state.backups[j];
          html += '<div class="backup-item">';
          html += '<div><div class="backup-name">' + b.originalName + '</div><div class="backup-meta">' + new Date(b.timestamp).toLocaleString() + ' \u00B7 ' + (b.size / 1024).toFixed(1) + ' KB</div></div>';
          html += '</div>';
        }
        html += '</div>';
      } else {
        html += '<div class="empty">No backups yet. They are created automatically when KAI writes config files.</div>';
      }
      html += '</div></div>';

      root.innerHTML = html;
    }

    window.addEventListener('message', function(event) {
      if (event.data.type === 'dashboard') renderDashboard(event.data);
      if (event.data.type === 'backups') renderBackups(event.data);
    });

    document.getElementById('refresh').addEventListener('click', function() {
      vscode.postMessage({ type: 'refresh' });
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
