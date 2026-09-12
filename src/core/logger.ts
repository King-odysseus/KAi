import * as vscode from 'vscode';

/**
 * Severity levels for log entries.
 */
export type LogSeverity = 'debug' | 'info' | 'warn' | 'error';

/**
 * Error category for structured grouping and filtering.
 */
export type ErrorCategory =
  | 'agent_crash'
  | 'agent_unavailable'
  | 'config_failure'
  | 'c1_unreachable'
  | 'proxy_error'
  | 'diff_apply_failed'
  | 'handoff_failed'
  | 'orchestrator_error'
  | 'webview_error'
  | 'internal';

export interface LogEntry {
  timestamp: string;
  severity: LogSeverity;
  category: ErrorCategory;
  message: string;
  detail?: string;
  stack?: string;
}

/**
 * Centralized logger for KAI that writes to a VS Code output channel
 * and surfaces user-visible messages based on severity.
 */
export class KaiLogger {
  private readonly outputChannel: vscode.LogOutputChannel;
  private readonly buffer: LogEntry[] = [];
  private readonly maxBuffer = 1000;
  private readonly showUserThreshold: LogSeverity;

  constructor(
    channelName: string,
    options?: { showUserThreshold?: LogSeverity },
  ) {
    this.outputChannel = vscode.window.createOutputChannel(channelName, { log: true });
    this.showUserThreshold = options?.showUserThreshold ?? 'error';
  }

  /**
   * Log a structured entry and optionally surface to the user.
   */
  log(severity: LogSeverity, category: ErrorCategory, message: string, detail?: string, error?: unknown): void {
    const resolvedDetail = detail ?? errorDetail(error);
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      severity,
      category,
      message,
      detail: resolvedDetail,
      stack: error instanceof Error ? error.stack : undefined,
    };

    this.buffer.push(entry);
    if (this.buffer.length > this.maxBuffer) {
      this.buffer.shift();
    }

    // Write to VS Code output channel
    const formatted = `[${entry.timestamp}] [${severity.toUpperCase()}] [${category}] ${message}${resolvedDetail ? ` — ${resolvedDetail}` : ''}`;
    switch (severity) {
      case 'debug': this.outputChannel.debug(formatted); break;
      case 'info': this.outputChannel.info(formatted); break;
      case 'warn': this.outputChannel.warn(formatted); break;
      case 'error': this.outputChannel.error(formatted); break;
    }

    // Surface user-visible messages based on threshold
    if (this.shouldShowUser(severity)) {
      const userMessage = `${categoryIcon(category)} ${message}`;
      switch (severity) {
        case 'error':
          void vscode.window.showErrorMessage(userMessage, 'Show Log').then((choice) => {
            if (choice === 'Show Log') this.outputChannel.show();
          });
          break;
        case 'warn':
          void vscode.window.showWarningMessage(userMessage);
          break;
        case 'info':
          if (category !== 'internal') {
            void vscode.window.showInformationMessage(userMessage);
          }
          break;
      }
    }
  }

  debug(category: ErrorCategory, message: string, detail?: string): void {
    this.log('debug', category, message, detail);
  }

  info(category: ErrorCategory, message: string, detail?: string): void {
    this.log('info', category, message, detail);
  }

  warn(category: ErrorCategory, message: string, detail?: string): void {
    this.log('warn', category, message, detail);
  }

  error(category: ErrorCategory, message: string, detail?: string, err?: unknown): void {
    this.log('error', category, message, detail, err);
  }

  /**
   * Convenience: log and return the error so callers can `throw logger.error(...)` pattern.
   */
  errorAndThrow(category: ErrorCategory, message: string, detail?: string, err?: unknown): Error {
    this.log('error', category, message, detail, err);
    return new Error(`${message}${detail ? `: ${detail}` : ''}`);
  }

  /** Get the underlying output channel (for disposal or showing). */
  getChannel(): vscode.LogOutputChannel {
    return this.outputChannel;
  }

  /** Get a copy of the recent log buffer. */
  getRecentLogs(count?: number): LogEntry[] {
    return count ? this.buffer.slice(-count) : [...this.buffer];
  }

  /** Show the output channel in VS Code. */
  show(): void {
    this.outputChannel.show();
  }

  /** Dispose the output channel. */
  dispose(): void {
    this.outputChannel.dispose();
  }

  private shouldShowUser(severity: LogSeverity): boolean {
    const order: LogSeverity[] = ['debug', 'info', 'warn', 'error'];
    return order.indexOf(severity) >= order.indexOf(this.showUserThreshold);
  }
}

function errorDetail(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint') {
    return String(error);
  }
  return undefined;
}

function categoryIcon(category: ErrorCategory): string {
  switch (category) {
    case 'agent_crash': return '$(debug-stop)';
    case 'agent_unavailable': return '$(warning)';
    case 'config_failure': return '$(settings-gear)';
    case 'c1_unreachable': return '$(server)';
    case 'proxy_error': return '$(shield)';
    case 'diff_apply_failed': return '$(diff)';
    case 'handoff_failed': return '$(arrow-swap)';
    case 'orchestrator_error': return '$(hubot)';
    case 'webview_error': return '$(browser)';
    case 'internal': return '$(info)';
  }
}

/** Singleton accessor — created once during activation. */
let _logger: KaiLogger | undefined;

export function getLogger(): KaiLogger {
  if (!_logger) {
    _logger = new KaiLogger('KAI Agent Workbench');
  }
  return _logger;
}

export function initLogger(channelName?: string, options?: { showUserThreshold?: LogSeverity }): KaiLogger {
  _logger = new KaiLogger(channelName ?? 'KAI Agent Workbench', options);
  return _logger;
}
