import type { AppSettings, LogEntry, ServiceState } from '@kai/contracts';
import { redactText } from '@kai/runtime';

// Tokens the shared redactor does not know: OpenAI-style keys, and long mixed-case runs such as loopback tokens.
const DASHED_KEY = /\bsk-[A-Za-z0-9_-]{8,}/g;
const LONG_TOKEN = /\b(?=[A-Za-z0-9_-]{32,}\b)(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+\b/g;
const USER_HOME = /(?:[A-Za-z]:\\Users\\|\/Users\/|\/home\/)[^\\/\s"']+/g;

/** Strip anything that looks like a credential, and the user name inside home-folder paths. */
export function redactForReport(text: string): string {
  return redactText(text)
    .replace(DASHED_KEY, '[REDACTED]')
    .replace(LONG_TOKEN, '[REDACTED]')
    .replace(USER_HOME, (match) => match.replace(/[^\\/]+$/, '<user>'));
}

function host(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return '(invalid address)';
  }
}

export interface ReportAgent {
  id: string;
  available: boolean;
  version?: string | null;
  detail?: string | null;
}

export interface ReportInput {
  generatedAt: Date;
  appName: string;
  version: string;
  platform: string;
  arch: string;
  versions: Record<string, string | undefined>;
  settings: AppSettings;
  services: readonly ServiceState[];
  agents: readonly ReportAgent[];
  logs: readonly LogEntry[];
}

/**
 * A plain-text report for bug reports. It lists versions, service states, a summary of settings and
 * recent errors. Credentials are never read; only non-secret settings are included, and the whole
 * text is passed through the redactor as a last line of defence.
 */
export function buildDiagnosticsReport(input: ReportInput): string {
  const { settings } = input;
  const lines: string[] = [
    `# ${input.appName} diagnostics`,
    `Generated: ${input.generatedAt.toISOString()}`,
    '',
    '## Environment',
    `- ${input.appName} ${input.version} on ${input.platform} ${input.arch}`,
    ...Object.entries(input.versions).filter(([, value]) => value).map(([name, value]) => `- ${name} ${value}`),
    '',
    '## Services',
    ...input.services.map((service) => `- ${service.kind}: ${service.status}${service.version ? ` (v${service.version})` : ''} — ${service.detail}${service.restarts ? ` [${service.restarts} automatic restarts${service.restartsExhausted ? ', gave up' : ''}]` : ''}`),
    '',
    '## Agents',
    ...input.agents.map((agent) => `- ${agent.id}: ${agent.available ? 'ready' : 'unavailable'}${agent.version ? ` ${agent.version}` : ''}${!agent.available && agent.detail ? ` — ${agent.detail}` : ''}`),
    '',
    '## Settings summary',
    `- Default agent ${settings.defaultAgent}, route ${settings.defaultRoute}, autonomy ${settings.defaultAutonomy}, theme ${settings.theme}`,
    `- Direct API: ${settings.directApi.enabled ? 'on' : 'off'}, provider ${settings.directApi.provider}, model ${settings.directApi.model || '(none)'}, host ${host(settings.directApi.baseUrl)}`,
    `- CLI model overrides: ${Object.keys(settings.agentModels).length ? Object.entries(settings.agentModels).map(([agent, model]) => `${agent}=${model}`).join(', ') : 'none'}`,
    `- Cognitive1: ${settings.cognitive1.enabled ? 'enabled' : 'disabled'}, Overwatch ${settings.cognitive1.overwatch.enabled ? `on (${settings.cognitive1.overwatch.provider})` : 'off'}`,
    `- Universal Proxy: ${settings.proxy.enabled ? 'enabled' : 'disabled'}, port ${settings.proxy.port}, upstream host ${host(settings.proxy.targetBaseUrl)}`,
    `- MCP servers: ${settings.mcpServers.length} configured, ${settings.mcpServers.filter((server) => server.enabled).length} enabled`,
    `- Budget: mode ${settings.usageBudget.mode}, daily ${settings.usageBudget.dailyUsd}, monthly ${settings.usageBudget.monthlyUsd}, per conversation ${settings.usageBudget.perConversationUsd}`,
    `- Tray ${settings.notifications.trayEnabled ? 'on' : 'off'}`,
    '',
    '## Recent problems',
  ];
  const problems = input.logs.filter((entry) => entry.severity === 'error' || entry.severity === 'warn').slice(-40);
  lines.push(...(problems.length ? problems.map((entry) => `- [${entry.severity}] ${entry.timestamp} ${entry.category}: ${entry.message}${entry.detail ? ` — ${String(entry.detail).slice(0, 300)}` : ''}`) : ['- none recorded']));
  return redactForReport(lines.join('\n'));
}
