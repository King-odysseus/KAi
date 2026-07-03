import * as vscode from 'vscode';
import type { AgentId } from '../core/types';
import type { WorkbenchOrchestrator } from '../orchestrator/orchestrator';
import type { ProxyManager } from '../proxy/proxy-manager';
import type { SecretStore } from '../config/secret-store';
import { AGENT_ORDER, AGENT_PROVIDERS } from '../config/agent-catalog';

interface SettingsMessage {
  type:
    | 'ready'
    | 'refresh'
    | 'install'
    | 'signin'
    | 'saveKey'
    | 'clearKey'
    | 'saveCommand'
    | 'saveProxy'
    | 'openDocs'
    | 'reload';
  agent?: AgentId;
  value?: string;
  port?: number;
  script?: string;
}

export class SettingsViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'kai.settings';

  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly orchestrator: WorkbenchOrchestrator,
    private readonly secretStore: SecretStore,
    private readonly proxyManager?: ProxyManager,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((m: SettingsMessage) => void this.handle(m));
  }

  refresh(): void {
    void this.postState();
  }

  private async handle(message: SettingsMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
      case 'refresh':
        await this.postState();
        break;
      case 'install':
        if (message.agent) this.runInTerminal(AGENT_PROVIDERS[message.agent].installCommand);
        break;
      case 'signin':
        if (message.agent) this.runInTerminal(AGENT_PROVIDERS[message.agent].signInCommand);
        break;
      case 'saveKey':
        if (message.agent && message.value !== undefined) {
          await this.secretStore.set(message.agent, message.value);
          void vscode.window.showInformationMessage(
            `Saved ${AGENT_PROVIDERS[message.agent].displayName} API key. Restart the proxy or reload to apply everywhere.`,
          );
          await this.postState();
        }
        break;
      case 'clearKey':
        if (message.agent) {
          await this.secretStore.delete(message.agent);
          await this.postState();
        }
        break;
      case 'saveCommand':
        if (message.agent && message.value !== undefined) {
          await vscode.workspace
            .getConfiguration('kai')
            .update(AGENT_PROVIDERS[message.agent].commandSetting, message.value.trim(), vscode.ConfigurationTarget.Global);
          void vscode.window.showInformationMessage('Saved command path. Reload the window to apply.');
          await this.postState();
        }
        break;
      case 'saveProxy':
        {
          const cfg = vscode.workspace.getConfiguration('kai');
          if (typeof message.port === 'number' && !Number.isNaN(message.port)) {
            await cfg.update('proxyPort', message.port, vscode.ConfigurationTarget.Global);
          }
          if (message.script !== undefined) {
            await cfg.update('proxyScript', message.script.trim(), vscode.ConfigurationTarget.Global);
          }
          void vscode.window.showInformationMessage('Saved proxy settings. Reload the window to apply.');
          await this.postState();
        }
        break;
      case 'openDocs':
        if (message.agent) {
          void vscode.env.openExternal(vscode.Uri.parse(AGENT_PROVIDERS[message.agent].keyDocsUrl));
        }
        break;
      case 'reload':
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
        break;
    }
  }

  private runInTerminal(command: string): void {
    const term =
      vscode.window.terminals.find((t) => t.name === 'KAI') ?? vscode.window.createTerminal('KAI');
    term.show();
    // Pre-fill without executing — the user reviews and presses Enter.
    term.sendText(command, false);
  }

  private async postState(): Promise<void> {
    if (!this.view) return;
    const capabilities = await this.orchestrator.getCapabilities();
    const keyStatus = await this.secretStore.status();
    const cfg = vscode.workspace.getConfiguration('kai');

    const agents = AGENT_ORDER.map((id) => {
      const provider = AGENT_PROVIDERS[id];
      const cap = capabilities.find((c) => c.id === id);
      return {
        id,
        displayName: provider.displayName,
        available: cap?.available ?? false,
        version: cap?.version ?? '',
        unavailableReason: cap?.unavailableReason ?? '',
        command: cfg.get<string>(provider.commandSetting, provider.defaultCommand),
        envVar: provider.envVar,
        installCommand: provider.installCommand,
        signInCommand: provider.signInCommand,
        authSummary: provider.authSummary,
        hasKey: keyStatus[id],
      };
    });

    await this.view.webview.postMessage({
      type: 'state',
      agents,
      proxy: {
        port: cfg.get<number>('proxyPort', 8082),
        script: cfg.get<string>('proxyScript', ''),
        running: this.proxyManager?.getStatus().running ?? false,
      },
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>KAI Settings</title>
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
    body { margin: 0; padding: 14px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
    .brand { display: flex; align-items: center; gap: 9px; margin-bottom: 6px; }
    .brand-mark { width: 26px; height: 26px; border-radius: 7px; flex: none; box-shadow: 0 1px 2px rgba(0,0,0,.2), 0 4px 12px rgba(0,0,0,.12); }
    .brand-title { font-size: 13px; font-weight: 700; letter-spacing: .2px; line-height: 1.1; }
    .brand-title .accent { color: var(--kai-accent); }
    .brand-sub { font-size: 10px; letter-spacing: .6px; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
    .intro { font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.5; margin: 4px 0 16px; }
    h3 { margin: 18px 0 8px; font-size: 11px; font-weight: 700; letter-spacing: .6px; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
    .card { border: 1px solid var(--kai-border); border-radius: 10px; padding: 12px; margin-bottom: 10px; background: var(--kai-surface); box-shadow: 0 1px 2px rgba(0,0,0,.08); }
    .card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
    .card-title { font-size: 13px; font-weight: 700; }
    .card-title .env { font-weight: 500; font-size: 10px; color: var(--vscode-descriptionForeground); margin-left: 6px; font-family: var(--vscode-editor-font-family, monospace); }
    .badge { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--kai-border); white-space: nowrap; }
    .badge::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
    .badge.ok { color: var(--vscode-testing-iconPassed); border-color: color-mix(in srgb, var(--vscode-testing-iconPassed) 45%, transparent); background: color-mix(in srgb, var(--vscode-testing-iconPassed) 10%, transparent); }
    .badge.warn { color: var(--vscode-testing-iconQueued); border-color: color-mix(in srgb, var(--vscode-testing-iconQueued) 45%, transparent); background: color-mix(in srgb, var(--vscode-testing-iconQueued) 10%, transparent); }
    .summary { font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.5; margin-bottom: 9px; }
    .field { margin-bottom: 8px; }
    .field label { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: .4px; color: var(--vscode-descriptionForeground); margin-bottom: 3px; }
    .row { display: flex; gap: 6px; }
    input {
      flex: 1; min-width: 0; width: 100%;
      border: 1px solid var(--vscode-input-border, var(--kai-border));
      color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border-radius: 5px; padding: 6px 8px; font: inherit; font-size: 12px;
      transition: border-color .12s ease, box-shadow .12s ease;
    }
    input:focus { outline: none; border-color: var(--kai-accent); box-shadow: 0 0 0 2px var(--kai-accent-soft); }
    button {
      cursor: pointer; font: inherit; font-size: 11px; font-weight: 600;
      border-radius: 5px; padding: 6px 12px; white-space: nowrap;
      color: var(--vscode-button-foreground); background: var(--vscode-button-background);
      border: 1px solid var(--vscode-button-background);
      transition: filter .12s ease, background .12s ease, box-shadow .12s ease;
    }
    button:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
    button.primary { color: #05202e; background: linear-gradient(180deg, var(--kai-accent) 0%, var(--kai-accent-strong) 100%); border-color: var(--kai-accent-strong); }
    button.primary:hover { filter: brightness(1.06); box-shadow: 0 2px 8px var(--kai-accent-soft); }
    button.ghost { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--kai-border); }
    button.ghost:hover { border-color: var(--kai-accent); color: var(--kai-accent-strong); background: var(--kai-accent-soft); }
    button.link { background: none; border: none; padding: 2px 0; color: var(--kai-accent-strong); text-decoration: underline; font-size: 10px; }
    .actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
    .keymeta { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 4px; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .note { font-size: 10px; color: var(--vscode-descriptionForeground); font-style: italic; }
    .toolbar { display: flex; gap: 6px; margin-top: 4px; }
    .toolbar button { flex: 1; }
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
      <div class="brand-title">K<span class="accent">A</span>I <span style="opacity:.7;font-weight:600;">Settings</span></div>
      <div class="brand-sub">Agents &middot; Auth &middot; Proxy</div>
    </div>
  </div>
  <div class="intro">
    <strong>Direct</strong> route uses each CLI's own sign-in (your personal account).
    <strong>Proxy</strong> route uses the API keys below. Keys are stored encrypted in your OS keychain &mdash; never in plain files.
  </div>

  <h3>Agents</h3>
  <div id="agents"></div>

  <h3>Proxy</h3>
  <div id="proxy"></div>

  <div class="toolbar">
    <button class="ghost" id="refresh">Re-check status</button>
    <button class="ghost" id="reload">Reload window</button>
  </div>

  <script nonce="${nonce}">
    var vscode = acquireVsCodeApi();
    var agentsEl = document.getElementById('agents');
    var proxyEl = document.getElementById('proxy');

    function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

    function renderAgents(agents) {
      agentsEl.innerHTML = agents.map(function (a) {
        var badge = a.available
          ? '<span class="badge ok">installed</span>'
          : '<span class="badge warn">not installed</span>';
        var keyPlaceholder = a.hasKey ? '•••••• saved — enter to replace' : 'Paste ' + a.envVar + '…';
        var installBtn = a.available ? '' : '<button class="ghost" data-act="install" data-id="' + a.id + '">Install</button>';
        var clearBtn = a.hasKey ? '<button class="link" data-act="clearKey" data-id="' + a.id + '">Remove key</button>' : '';
        return '' +
          '<div class="card">' +
            '<div class="card-head"><div class="card-title">' + esc(a.displayName) + '</div>' + badge + '</div>' +
            '<div class="summary">' + esc(a.authSummary) + '</div>' +
            (a.available ? '' : '<div class="note" style="margin-bottom:8px;">' + esc(a.unavailableReason || (a.command + ' not found on PATH')) + '</div>') +
            '<div class="field"><label>Command / path</label><div class="row">' +
              '<input data-field="command" data-id="' + a.id + '" value="' + esc(a.command) + '" placeholder="' + esc(a.id) + '" />' +
              '<button class="ghost" data-act="saveCommand" data-id="' + a.id + '">Save</button>' +
            '</div></div>' +
            '<div class="field"><label>API key <span class="env" style="font-size:9px;">' + esc(a.envVar) + '</span></label><div class="row">' +
              '<input type="password" data-field="key" data-id="' + a.id + '" placeholder="' + esc(keyPlaceholder) + '" />' +
              '<button class="primary" data-act="saveKey" data-id="' + a.id + '">Save key</button>' +
            '</div>' +
              '<div class="keymeta"><button class="link" data-act="openDocs" data-id="' + a.id + '">Get an API key ↗</button>' + clearBtn + '</div>' +
            '</div>' +
            '<div class="actions">' +
              installBtn +
              '<button class="ghost" data-act="signin" data-id="' + a.id + '">Sign in (Direct)</button>' +
            '</div>' +
          '</div>';
      }).join('');
    }

    function renderProxy(p) {
      var badge = p.running ? '<span class="badge ok">running</span>' : '<span class="badge warn">stopped</span>';
      proxyEl.innerHTML = '' +
        '<div class="card">' +
          '<div class="card-head"><div class="card-title">ClaudeCode-Proxy</div>' + badge + '</div>' +
          '<div class="summary">Point KAI at your proxy server script to enable the Proxy route. Leave the script empty to disable.</div>' +
          '<div class="field"><label>Proxy server script</label><div class="row">' +
            '<input data-field="proxyScript" value="' + esc(p.script) + '" placeholder="C:\\\\path\\\\to\\\\proxy.js" />' +
          '</div></div>' +
          '<div class="field"><label>Port</label><div class="row">' +
            '<input data-field="proxyPort" value="' + esc(p.port) + '" placeholder="8082" />' +
            '<button class="primary" data-act="saveProxy">Save proxy</button>' +
          '</div></div>' +
        '</div>';
    }

    function inputFor(field, id) {
      var sel = '[data-field="' + field + '"]' + (id ? '[data-id="' + id + '"]' : '');
      return document.querySelector(sel);
    }

    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      var id = btn.getAttribute('data-id');
      if (act === 'install') vscode.postMessage({ type: 'install', agent: id });
      else if (act === 'signin') vscode.postMessage({ type: 'signin', agent: id });
      else if (act === 'openDocs') vscode.postMessage({ type: 'openDocs', agent: id });
      else if (act === 'clearKey') vscode.postMessage({ type: 'clearKey', agent: id });
      else if (act === 'saveCommand') vscode.postMessage({ type: 'saveCommand', agent: id, value: inputFor('command', id).value });
      else if (act === 'saveKey') {
        var input = inputFor('key', id);
        vscode.postMessage({ type: 'saveKey', agent: id, value: input.value });
        input.value = '';
      } else if (act === 'saveProxy') {
        vscode.postMessage({
          type: 'saveProxy',
          port: parseInt(inputFor('proxyPort').value, 10),
          script: inputFor('proxyScript').value,
        });
      }
    });

    document.getElementById('refresh').addEventListener('click', function () { vscode.postMessage({ type: 'refresh' }); });
    document.getElementById('reload').addEventListener('click', function () { vscode.postMessage({ type: 'reload' }); });

    window.addEventListener('message', function (e) {
      var m = e.data;
      if (m.type === 'state') { renderAgents(m.agents); renderProxy(m.proxy); }
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
  for (let i = 0; i < 32; i += 1) nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  return nonce;
}
