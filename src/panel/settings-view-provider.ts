import * as vscode from 'vscode';
import * as path from 'path';
import type { AgentId } from '../core/types';
import type { WorkbenchOrchestrator } from '../orchestrator/orchestrator';
import type { ProxyManager } from '../proxy/proxy-manager';
import type { SecretStore } from '../config/secret-store';
import { AGENT_ORDER, AGENT_PROVIDERS } from '../config/agent-catalog';
import { ClaudeConfigWriter } from '../config/claude-config';
import { QwenConfigWriter } from '../config/qwen-config';
import { CodexConfigWriter, defaultCodexConfigPath } from '../config/codex-config';

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
    | 'saveUpstream'
    | 'saveAgentBackend'
    | 'routeAgent'
    | 'directAgent'
    | 'routeAll'
    | 'directAll'
    | 'restartProxy'
    | 'openDocs'
    | 'openBrowser'
    | 'reload';
  agent?: AgentId;
  value?: string;
  port?: number;
  script?: string;
  baseUrl?: string;
  claudeUrl?: string;
  openaiUrl?: string;
  apiKey?: string;
  defaultModel?: string;
  enabled?: boolean;
}

export class SettingsViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'kai.settings';

  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly orchestrator: WorkbenchOrchestrator,
    private readonly secretStore: SecretStore,
    private readonly proxyManager?: ProxyManager,
    private readonly claudeConfigWriter = new ClaudeConfigWriter(),
    private readonly qwenConfigWriter = new QwenConfigWriter(),
    private readonly codexConfigWriter = new CodexConfigWriter(),
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
      case 'saveUpstream':
        await this.handleSaveUpstream(message);
        break;
      case 'saveAgentBackend':
        await this.handleSaveAgentBackend(message);
        break;
      case 'routeAgent':
        if (message.agent) await this.handleRouteAgent(message.agent);
        break;
      case 'directAgent':
        if (message.agent) await this.handleDirectAgent(message.agent);
        break;
      case 'routeAll':
        await this.handleRouteAll();
        break;
      case 'directAll':
        await this.handleDirectAll();
        break;
      case 'restartProxy':
        await this.handleRestartProxy();
        break;
      case 'openDocs':
        if (message.agent) {
          void vscode.env.openExternal(vscode.Uri.parse(AGENT_PROVIDERS[message.agent].keyDocsUrl));
        }
        break;
      case 'openBrowser':
        this.openInBrowser();
        break;
      case 'reload':
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
        break;
    }
  }

  private openInBrowser(): void {
    const port = 8000;
    const url = `http://127.0.0.1:${port}`;
    const term =
      vscode.window.terminals.find((t) => t.name === 'KAI Web') ??
      vscode.window.createTerminal('KAI Web');
    term.show();
    // Launch VS Code's built-in web server (serves the full editor + KAI to a browser).
    // Localhost-only, so the connection token is disabled for a friction-free open.
    term.sendText(
      `code serve-web --port ${port} --host 127.0.0.1 --without-connection-token --accept-server-license-terms`,
      true,
    );
    void vscode.window.showInformationMessage(
      `Starting VS Code Web on ${url} — opening your browser. This serves the full editor (with KAI) from this machine. If the tab is blank, wait a few seconds and refresh.`,
    );
    // Give the server a moment to boot before opening the browser.
    setTimeout(() => void vscode.env.openExternal(vscode.Uri.parse(url)), 3500);
  }

  // ---- Proxy config handlers ----

  private async handleSaveUpstream(message: SettingsMessage): Promise<void> {
    const proxyCfg = vscode.workspace.getConfiguration('claudeProxy');
    const baseUrl = message.baseUrl;
    const claudeUrl = message.claudeUrl || baseUrl;
    const openaiUrl = message.openaiUrl || baseUrl;

    if (baseUrl) {
      await proxyCfg.update('targetBaseUrl', baseUrl, vscode.ConfigurationTarget.Global);
    }
    if (message.apiKey !== undefined && baseUrl) {
      const apiKeys = proxyCfg.get<Record<string, string>>('apiKeys', {});
      apiKeys[baseUrl] = message.apiKey;
      // Also store key for derived endpoints so per-agent blocks can use it
      if (claudeUrl && claudeUrl !== baseUrl) apiKeys[claudeUrl] = message.apiKey;
      if (openaiUrl && openaiUrl !== baseUrl) apiKeys[openaiUrl] = message.apiKey;
      await proxyCfg.update('apiKeys', apiKeys, vscode.ConfigurationTarget.Global);
    }
    if (message.defaultModel !== undefined) {
      await proxyCfg.update('defaultModel', message.defaultModel, vscode.ConfigurationTarget.Global);
    }

    // Auto-populate per-agent configs with derived endpoints + shared key
    if (openaiUrl) {
      const codexCfg = { ...(proxyCfg.get<Record<string, unknown>>('codexConfig', {}) as Record<string, unknown>), baseUrl: openaiUrl, apiKey: message.apiKey || '', defaultModel: message.defaultModel || 'gpt-5.5' };
      await proxyCfg.update('codexConfig', codexCfg, vscode.ConfigurationTarget.Global);
      const qwenCfg = { ...(proxyCfg.get<Record<string, unknown>>('qwenConfig', {}) as Record<string, unknown>), baseUrl: openaiUrl, apiKey: message.apiKey || '', defaultModel: message.defaultModel || 'qwen-coder-plus' };
      await proxyCfg.update('qwenConfig', qwenCfg, vscode.ConfigurationTarget.Global);
    }

    void vscode.window.showInformationMessage('Upstream provider saved. Endpoints auto-configured for all agents. Restart the proxy to apply.');
    await this.postState();
  }

  private async handleSaveAgentBackend(message: SettingsMessage): Promise<void> {
    if (!message.agent) return;
    const proxyCfg = vscode.workspace.getConfiguration('claudeProxy');
    const key = message.agent === 'codex' ? 'codexConfig' : message.agent === 'qwen' ? 'qwenConfig' : null;
    if (!key) return;

    const current = proxyCfg.get<Record<string, unknown>>(key, {}) as Record<string, unknown>;
    const next: Record<string, unknown> = { ...current };
    if (message.enabled !== undefined) next.enabled = message.enabled;
    if (message.baseUrl !== undefined) next.baseUrl = message.baseUrl;
    if (message.apiKey !== undefined) next.apiKey = message.apiKey;
    if (message.defaultModel !== undefined) next.defaultModel = message.defaultModel;
    // Keep configModel for Codex if it exists
    if (key === 'codexConfig' && !next.configModel) next.configModel = 'gpt-5.5';

    await proxyCfg.update(key, next, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(`Saved ${message.agent} backend config. Restart the proxy to apply.`);
    await this.postState();
  }

  private async handleRouteAgent(agent: AgentId): Promise<void> {
    const proxyCfg = vscode.workspace.getConfiguration('claudeProxy');
    const cfg = vscode.workspace.getConfiguration('kai');
    const port = cfg.get<number>('proxyPort', 8082);

    if (agent === 'claude') {
      await proxyCfg.update('routeClaudeCode', true, vscode.ConfigurationTarget.Global);
      await this.claudeConfigWriter.ensureProxyConfig({ port });
    } else if (agent === 'codex') {
      await proxyCfg.update('routeCodex', true, vscode.ConfigurationTarget.Global);
      const codexCfg = proxyCfg.get<Record<string, unknown>>('codexConfig', {}) as Record<string, unknown>;
      const model = (codexCfg.configModel as string) || 'gpt-5.5';
      const profile = cfg.get<string>('codexProxyProfile', 'codeproxy');
      await this.codexConfigWriter.ensureProxyProfile({ profile, port, model });
    } else if (agent === 'qwen') {
      await this.qwenConfigWriter.ensureProxyConfig({ port });
    }

    // Set global route to proxy if any agent is routed
    if (this.orchestrator.getState().route !== 'proxy') {
      this.orchestrator.setRoute('proxy');
    }
    void vscode.window.showInformationMessage(`${AGENT_PROVIDERS[agent].displayName} routed through proxy.`);
    await this.postState();
  }

  private async handleDirectAgent(agent: AgentId): Promise<void> {
    const proxyCfg = vscode.workspace.getConfiguration('claudeProxy');

    if (agent === 'claude') {
      await proxyCfg.update('routeClaudeCode', false, vscode.ConfigurationTarget.Global);
      await this.claudeConfigWriter.restoreConfig();
    } else if (agent === 'codex') {
      await proxyCfg.update('routeCodex', false, vscode.ConfigurationTarget.Global);
      const cfg = vscode.workspace.getConfiguration('kai');
      const profile = cfg.get<string>('codexProxyProfile', 'codeproxy');
      try {
        await this.codexConfigWriter.restoreConfig(undefined, profile);
      } catch { /* config file may not exist */ }
    } else if (agent === 'qwen') {
      await this.qwenConfigWriter.restoreConfig();
    }

    // If no agents are routed, set global route to direct
    const routeClaude = proxyCfg.get<boolean>('routeClaudeCode', false);
    const routeCodex = proxyCfg.get<boolean>('routeCodex', false);
    if (!routeClaude && !routeCodex && this.orchestrator.getState().route !== 'direct') {
      this.orchestrator.setRoute('direct');
    }
    void vscode.window.showInformationMessage(`${AGENT_PROVIDERS[agent].displayName} restored to direct mode.`);
    await this.postState();
  }

  private async handleRouteAll(): Promise<void> {
    const proxyCfg = vscode.workspace.getConfiguration('claudeProxy');
    const cfg = vscode.workspace.getConfiguration('kai');
    const port = cfg.get<number>('proxyPort', 8082);

    await proxyCfg.update('routeClaudeCode', true, vscode.ConfigurationTarget.Global);
    await proxyCfg.update('routeCodex', true, vscode.ConfigurationTarget.Global);
    await this.claudeConfigWriter.ensureProxyConfig({ port });
    await this.qwenConfigWriter.ensureProxyConfig({ port });

    const codexCfg = proxyCfg.get<Record<string, unknown>>('codexConfig', {}) as Record<string, unknown>;
    const model = (codexCfg.configModel as string) || 'gpt-5.5';
    const profile = cfg.get<string>('codexProxyProfile', 'codeproxy');
    await this.codexConfigWriter.ensureProxyProfile({ profile, port, model });

    if (this.orchestrator.getState().route !== 'proxy') {
      this.orchestrator.setRoute('proxy');
    }
    void vscode.window.showInformationMessage('All agents routed through proxy.');
    await this.postState();
  }

  private async handleDirectAll(): Promise<void> {
    const proxyCfg = vscode.workspace.getConfiguration('claudeProxy');
    const cfg = vscode.workspace.getConfiguration('kai');
    await proxyCfg.update('routeClaudeCode', false, vscode.ConfigurationTarget.Global);
    await proxyCfg.update('routeCodex', false, vscode.ConfigurationTarget.Global);
    await this.claudeConfigWriter.restoreConfig();
    await this.qwenConfigWriter.restoreConfig();
    try {
      const profile = cfg.get<string>('codexProxyProfile', 'codeproxy');
      await this.codexConfigWriter.restoreConfig(undefined, profile);
    } catch { /* config file may not exist */ }

    if (this.orchestrator.getState().route !== 'direct') {
      this.orchestrator.setRoute('direct');
    }
    void vscode.window.showInformationMessage('All agents restored to direct mode.');
    await this.postState();
  }

  private async handleRestartProxy(): Promise<void> {
    if (!this.proxyManager) {
      void vscode.window.showWarningMessage('Proxy manager not available.');
      return;
    }
    try {
      const cfg = vscode.workspace.getConfiguration('kai');
      const script = cfg.get<string>('proxyScript', '');
      await this.proxyManager.stop();
      await this.proxyManager.start(script);
      void vscode.window.showInformationMessage('Proxy restarted.');
    } catch (e) {
      void vscode.window.showErrorMessage(`Proxy restart failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    await this.postState();
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
        strengths: provider.strengths,
        bestFor: provider.bestFor,
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
        upstream: this.getUpstreamState(),
        routing: this.getRoutingState(),
      },
    });
  }

  private getUpstreamState() {
    try {
      const pc = vscode.workspace.getConfiguration('claudeProxy');
      const codexCfg = pc.get<Record<string, unknown>>('codexConfig', {}) as Record<string, unknown>;
      const qwenCfg = pc.get<Record<string, unknown>>('qwenConfig', {}) as Record<string, unknown>;
      const baseUrl = pc.get<string>('targetBaseUrl', 'https://api.deepseek.com/anthropic');
      const apiKeys = pc.get<Record<string, string>>('apiKeys', {}) ?? {};
      return {
        baseUrl,
        hasKey: Boolean(apiKeys[baseUrl]),
        defaultModel: pc.get<string>('defaultModel', 'deepseek-v4-pro'),
        modelMap: pc.get<Record<string, string>>('modelMap', {}),
        codexConfig: codexCfg,
        qwenConfig: qwenCfg,
      };
    } catch {
      return { baseUrl: 'https://api.deepseek.com', hasKey: false, defaultModel: 'deepseek-v4-pro', modelMap: {}, codexConfig: {}, qwenConfig: {} };
    }
  }

  private getRoutingState() {
    try {
      const pc = vscode.workspace.getConfiguration('claudeProxy');
      return {
        claudeCode: pc.get<boolean>('routeClaudeCode', false),
        codex: pc.get<boolean>('routeCodex', false),
        globalRoute: this.orchestrator.getState().route,
      };
    } catch {
      return { claudeCode: false, codex: false, globalRoute: 'direct' };
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
    .strengths { border-left: 2px solid var(--kai-accent-line); padding-left: 9px; margin: 0 0 10px; }
    .strengths .st-text { font-size: 11px; line-height: 1.5; margin-bottom: 6px; }
    .tags { display: flex; flex-wrap: wrap; gap: 4px; }
    .tag { font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--kai-accent-soft); color: var(--kai-accent-strong); }
    .st-label { font-size: 9px; text-transform: uppercase; letter-spacing: .5px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; font-weight: 700; }
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
    .advanced-toggle { font-size: 10px; color: var(--vscode-descriptionForeground); cursor: pointer; padding: 4px 0; user-select: none; display: flex; align-items: center; gap: 4px; }
    .advanced-toggle:hover { color: var(--kai-accent-strong); }
    .advanced-toggle .toggle-arrow { display: inline-block; transition: transform .15s ease; font-size: 9px; width: 10px; }
    .advanced-toggle.open .toggle-arrow { transform: rotate(90deg); }
    .advanced-section { margin-top: 6px; padding-top: 8px; border-top: 1px solid var(--kai-border); display: none; }
    .endpoints-box { margin-top: 10px; padding: 8px 10px; background: var(--vscode-input-background); border-radius: 6px; border: 1px solid var(--kai-border); }
    .endpoints-label { font-size: 10px; font-weight: 600; color: var(--vscode-descriptionForeground); margin-bottom: 6px; text-transform: uppercase; letter-spacing: .5px; }
    .endpoint-row { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 11px; }
    .endpoint-row span { min-width: 50px; font-weight: 600; }
    .endpoint-row code { font-size: 10px; color: var(--vscode-descriptionForeground); background: var(--kai-surface); padding: 1px 6px; border-radius: 3px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .endpoint-format { font-size: 9px; color: var(--kai-accent-strong); background: var(--kai-accent-soft); padding: 1px 5px; border-radius: 3px; min-width: auto !important; }
    .toolbar { display: flex; gap: 6px; margin-top: 4px; }
    .toolbar button { flex: 1; }
    select {
      flex: 1; min-width: 0; width: 100%;
      border: 1px solid var(--vscode-input-border, var(--kai-border));
      color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border-radius: 5px; padding: 6px 8px; font: inherit; font-size: 12px;
      cursor: pointer;
    }
    select:focus { outline: none; border-color: var(--kai-accent); box-shadow: 0 0 0 2px var(--kai-accent-soft); }
    .divider { border: none; border-top: 1px solid var(--kai-border); margin: 10px 0; }
    .toggle-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .toggle-row label { font-size: 12px; font-weight: 600; cursor: pointer; }
    .toggle-row input[type=checkbox] { width: auto; flex: none; cursor: pointer; }
    .sub-section { margin-left: 12px; padding-left: 10px; border-left: 2px solid var(--kai-accent-soft); margin-bottom: 8px; }
    .route-row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
    .route-row .agent-label { font-size: 12px; font-weight: 600; min-width: 90px; }
    .route-row .route-badge { font-size: 10px; font-weight: 600; }
    .route-badge.routed { color: var(--vscode-testing-iconPassed); }
    .route-badge.direct { color: var(--vscode-descriptionForeground); }
    button.small { font-size: 10px; padding: 3px 8px; }
    button.warn { color: #fff; background: var(--vscode-inputValidation-warningBackground, #554400); border-color: var(--vscode-inputValidation-warningBorder, #886600); }
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

  <h3>Browser access</h3>
  <div class="card">
    <div class="summary">Operate KAI from Chrome. This starts VS Code's web server and opens it in your browser &mdash; the full editor with KAI, served from this machine (localhost only).</div>
    <div class="actions"><button class="primary" data-act="openBrowser">Open in browser ↗</button></div>
  </div>

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
        var tags = (a.bestFor || []).map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('');
        return '' +
          '<div class="card">' +
            '<div class="card-head"><div class="card-title">' + esc(a.displayName) + '</div>' + badge + '</div>' +
            '<div class="strengths">' +
              '<div class="st-label">Best for</div>' +
              '<div class="st-text">' + esc(a.strengths) + '</div>' +
              '<div class="tags">' + tags + '</div>' +
            '</div>' +
            '<div class="summary">' + esc(a.authSummary) + '</div>' +
            (a.available ? '' : '<div class="note" style="margin-bottom:8px;">' + esc(a.unavailableReason || (a.command + ' not found on PATH')) + '</div>') +
            '<div class="field"><label>Command / path</label><div class="row">' +
              '<input data-field="command" data-id="' + a.id + '" value="' + esc(a.command) + '" placeholder="' + esc(a.id) + '" />' +
              '<button class="ghost" data-act="saveCommand" data-id="' + a.id + '">Save</button>' +
            '</div></div>' +
            '<div class="advanced-toggle" data-toggle="key-' + a.id + '"><span class="toggle-arrow">▸</span> Advanced: API key (rarely needed — use for Proxy)</div>' +
            '<div class="advanced-section" id="key-' + a.id + '">' +
              '<div class="field"><label>API key <span class="env" style="font-size:9px;">' + esc(a.envVar) + '</span></label><div class="row">' +
                '<input type="password" data-field="key" data-id="' + a.id + '" placeholder="' + esc(keyPlaceholder) + '" />' +
                '<button class="primary" data-act="saveKey" data-id="' + a.id + '">Save key</button>' +
              '</div>' +
                '<div class="keymeta"><button class="link" data-act="openDocs" data-id="' + a.id + '">Get an API key ↗</button>' + clearBtn + '</div>' +
              '</div>' +
            '</div>' +
            '<div class="actions">' +
              installBtn +
              '<button class="ghost" data-act="signin" data-id="' + a.id + '">Sign in (Direct)</button>' +
            '</div>' +
          '</div>';
      }).join('');
    }

    var PROVIDER_PRESETS = [
      { label: 'DeepSeek', claudeUrl: 'https://api.deepseek.com/anthropic', openaiUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro' },
      
      { label: 'Groq', claudeUrl: null, openaiUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
      { label: 'Moonshot (Kimi)', claudeUrl: null, openaiUrl: 'https://api.moonshot.ai/v1', model: 'kimi-k2-5-flash-preview' },
      { label: 'Together AI', claudeUrl: null, openaiUrl: 'https://api.together.xyz/v1', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
      { label: 'Ollama (local)', claudeUrl: null, openaiUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder' },
      { label: 'LM Studio (local)', claudeUrl: null, openaiUrl: 'http://localhost:1234/v1', model: 'local-model' },
      { label: 'Anthropic (direct API)', claudeUrl: 'https://api.anthropic.com', openaiUrl: null, model: 'claude-sonnet-4-6' },
    ];

    function renderProxy(p) {
      var badge = p.running ? '<span class="badge ok">running</span>' : '<span class="badge warn">stopped</span>';
      var up = p.upstream || {};
      var rt = p.routing || {};

      // Preset matcher
      var presetOpts = PROVIDER_PRESETS.map(function (pr) {
        var sel = (pr.claudeUrl === up.baseUrl || pr.openaiUrl === up.baseUrl) ? ' selected' : '';
        return '<option value="' + esc(pr.label) + '" data-claude="' + esc(pr.claudeUrl || '') + '" data-openai="' + esc(pr.openaiUrl || '') + '" data-model="' + esc(pr.model) + '"' + sel + '>' + esc(pr.label) + '</option>';
      }).join('');

      // Agent route rows
      function routeRow(id, label) {
        var routed = (id === 'claude' && rt.claudeCode) || (id === 'codex' && rt.codex) || (id === 'qwen' && rt.globalRoute === 'proxy');
        var rBadge = routed ? '<span class="route-badge routed">proxy</span>' : '<span class="route-badge direct">direct</span>';
        return '<div class="route-row">' +
          '<span class="agent-label">' + esc(label) + '</span>' + rBadge +
          '<button class="ghost small" data-act="routeAgent" data-id="' + id + '">Route</button>' +
          '<button class="ghost small" data-act="directAgent" data-id="' + id + '">Direct</button>' +
        '</div>';
      }

      // Per-agent backend subsection
      function agentBackend(id, label, cfg) {
        cfg = cfg || {};
        var checked = cfg.enabled ? ' checked' : '';
        var sectionStyle = cfg.enabled ? '' : ' style="display:none;"';
        return '' +
          '<div class="toggle-row">' +
            '<input type="checkbox" data-field="agentBackendEnabled" data-id="' + id + '"' + checked + ' />' +
            '<label>Use different provider for ' + esc(label) + '</label>' +
          '</div>' +
          '<div class="sub-section" data-section="agentBackend" data-id="' + id + '"' + sectionStyle + '>' +
            '<div class="field"><label>Base URL</label><div class="row">' +
              '<input data-field="agentBackendUrl" data-id="' + id + '" value="' + esc(cfg.baseUrl || '') + '" />' +
            '</div></div>' +
            '<div class="field"><label>API Key</label><div class="row">' +
              '<input type="password" data-field="agentBackendKey" data-id="' + id + '" placeholder="' + (cfg.apiKey ? '•••••• saved' : 'Paste API key...') + '" />' +
            '</div></div>' +
            '<div class="field"><label>Model</label><div class="row">' +
              '<input data-field="agentBackendModel" data-id="' + id + '" value="' + esc(cfg.defaultModel || '') + '" />' +
              '<button class="primary small" data-act="saveAgentBackend" data-id="' + id + '">Save</button>' +
            '</div></div>' +
          '</div>';
      }

      proxyEl.innerHTML = '' +
        // ---- Server ----
        '<div class="card">' +
          '<div class="card-head"><div class="card-title">Proxy Server</div>' + badge + '</div>' +
          '<div class="field"><label>Script path</label><div class="row">' +
            '<input data-field="proxyScript" value="' + esc(p.script) + '" placeholder="Path to proxy server script" />' +
          '</div></div>' +
          '<div class="field"><label>Port</label><div class="row">' +
            '<input data-field="proxyPort" value="' + esc(p.port) + '" placeholder="8082" />' +
            '<button class="primary" data-act="saveProxy">Save</button>' +
          '</div></div>' +
          '<div class="actions" style="margin-top:8px;">' +
            '<button class="ghost" data-act="restartProxy">Restart proxy ↻</button>' +
          '</div>' +
        '</div>' +

        // ---- Upstream Provider ----
        '<div class="card">' +
          '<div class="card-head"><div class="card-title">Upstream Provider</div></div>' +
          '<div class="summary">Pick a provider, enter its API key. The proxy auto-routes each agent to the correct endpoint format.</div>' +
          '<div class="field"><label>Provider</label><div class="row">' +
            '<select data-field="upstreamPreset">' + presetOpts + '</select>' +
          '</div></div>' +
          '<div class="field"><label>API Key</label><div class="row">' +
            '<input type="password" data-field="upstreamKey" placeholder="' + (up.hasKey ? '•••••• saved — enter to replace' : 'Paste API key...') + '" />' +
            '<button class="primary" data-act="saveUpstream">Save</button>' +
          '</div></div>' +
          '<div class="field"><label>Default model</label><div class="row">' +
            '<input data-field="upstreamModel" value="' + esc(up.defaultModel) + '" />' +
            '<button class="primary" data-act="saveUpstream">Save</button>' +
          '</div></div>' +
          '<div class="endpoints-box">' +
            '<div class="endpoints-label">Agent endpoints (auto-derived from provider)</div>' +
            '<div class="endpoint-row"><span>Claude</span><code id="endpoint-claude">' + esc(up.baseUrl || '—') + '</code><span class="endpoint-format">Anthropic</span></div>' +
            '<div class="endpoint-row"><span>Codex</span><code id="endpoint-codex">' + esc((up.codexConfig && up.codexConfig.baseUrl) || '—') + '</code><span class="endpoint-format">OpenAI</span></div>' +
            '<div class="endpoint-row"><span>Qwen</span><code id="endpoint-qwen">' + esc((up.qwenConfig && up.qwenConfig.baseUrl) || '—') + '</code><span class="endpoint-format">OpenAI</span></div>' +
          '</div>' +
        '</div>' +

        // ---- Provider Overrides ----
        '<div class="card">' +
          '<div class="card-head"><div class="card-title">Provider Overrides</div></div>' +
          '<div class="summary">Only needed to switch an agent to a different provider. Endpoints are auto-derived from the upstream provider above.</div>' +
          agentBackend('codex', 'Codex', up.codexConfig) +
          agentBackend('qwen', 'Qwen', up.qwenConfig) +
        '</div>' +

        // ---- Agent Routing ----
        '<div class="card">' +
          '<div class="card-head"><div class="card-title">Agent Routing</div></div>' +
          '<div class="summary">Route rewrites each agent\'s config to point at <code>localhost:' + esc(p.port) + '</code>. Direct restores the default endpoint. Keys set above are used for direct mode; the upstream key is used in proxy mode.</div>' +
          '<div class="actions" style="margin-bottom:10px;">' +
            '<button class="primary small" data-act="routeAll">Route All</button>' +
            '<button class="ghost small" data-act="directAll">Direct All</button>' +
          '</div>' +
          routeRow('claude', 'Claude Code') +
          routeRow('codex', 'Codex') +
          routeRow('qwen', 'Qwen Code') +
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
      else if (act === 'openBrowser') vscode.postMessage({ type: 'openBrowser' });
      else if (act === 'clearKey') vscode.postMessage({ type: 'clearKey', agent: id });
      else if (act === 'reload') vscode.postMessage({ type: 'reload' });
      else if (act === 'restartProxy') vscode.postMessage({ type: 'restartProxy' });
      else if (act === 'routeAll') vscode.postMessage({ type: 'routeAll' });
      else if (act === 'directAll') vscode.postMessage({ type: 'directAll' });
      else if (act === 'routeAgent') vscode.postMessage({ type: 'routeAgent', agent: id });
      else if (act === 'directAgent') vscode.postMessage({ type: 'directAgent', agent: id });
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
      } else if (act === 'saveUpstream') {
        var presetSel = document.querySelector('[data-field="upstreamPreset"]');
        var presetOpt = presetSel ? presetSel.options[presetSel.selectedIndex] : null;
        var claudeUrl = presetOpt ? (presetOpt.getAttribute('data-claude') || '') : '';
        var openaiUrl = presetOpt ? (presetOpt.getAttribute('data-openai') || '') : '';
        vscode.postMessage({
          type: 'saveUpstream',
          baseUrl: claudeUrl || openaiUrl,
          claudeUrl: claudeUrl,
          openaiUrl: openaiUrl,
          apiKey: inputFor('upstreamKey').value,
          defaultModel: inputFor('upstreamModel').value,
        });
        var keyInput = inputFor('upstreamKey');
        if (keyInput) keyInput.value = '';
      } else if (act === 'saveAgentBackend') {
        var enabledEl = document.querySelector('[data-field="agentBackendEnabled"][data-id="' + id + '"]');
        vscode.postMessage({
          type: 'saveAgentBackend',
          agent: id,
          enabled: enabledEl ? enabledEl.checked : false,
          baseUrl: inputFor('agentBackendUrl', id).value,
          apiKey: inputFor('agentBackendKey', id).value,
          defaultModel: inputFor('agentBackendModel', id).value,
        });
        var backendKeyInput = inputFor('agentBackendKey', id);
        if (backendKeyInput) backendKeyInput.value = '';
      }
    });

    // Preset dropdown changes auto-fill URL + model
    document.addEventListener('change', function (e) {
      var sel = e.target;
      if (sel.getAttribute('data-field') !== 'upstreamPreset') return;
      var opt = sel.options[sel.selectedIndex];
      if (!opt) return;
      var modelInput = inputFor('upstreamModel');
      if (modelInput && opt.getAttribute('data-model')) modelInput.value = opt.getAttribute('data-model');
      // Update derived endpoint display
      var claudeUrl = opt.getAttribute('data-claude') || '';
      var openaiUrl = opt.getAttribute('data-openai') || '';
      var claudeEl = document.getElementById('endpoint-claude');
      var codexEl = document.getElementById('endpoint-codex');
      var qwenEl = document.getElementById('endpoint-qwen');
      if (claudeEl) claudeEl.textContent = claudeUrl || '—';
      if (codexEl) codexEl.textContent = openaiUrl || '—';
      if (qwenEl) qwenEl.textContent = openaiUrl || '—';
    });

    // Agent backend toggle shows/hides the sub-section
    document.addEventListener('change', function (e) {
      var cb = e.target;
      if (cb.getAttribute('data-field') !== 'agentBackendEnabled') return;
      var id = cb.getAttribute('data-id');
      var section = document.querySelector('[data-section="agentBackend"][data-id="' + id + '"]');
      if (section) section.style.display = cb.checked ? '' : 'none';
    });

    // Advanced toggle click handler
    document.addEventListener('click', function (e) {
      var toggle = e.target.closest('[data-toggle]');
      if (!toggle) return;
      var id = toggle.getAttribute('data-toggle');
      var section = document.getElementById(id);
      if (!section) return;
      var isOpen = getComputedStyle(section).display !== 'none';
      section.style.display = isOpen ? 'none' : 'block';
      toggle.classList.toggle('open', !isOpen);
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
