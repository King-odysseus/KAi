import type { LogCategory, LogEntry, LogSeverity, LoggerPort } from '@kai/contracts';
import { redactText } from './redaction';

export interface LoggerSink {
  write(entry: LogEntry): void;
}

export class RedactedLogger implements LoggerPort {
  private readonly buffer: LogEntry[] = [];

  constructor(
    private readonly sink?: LoggerSink,
    private readonly maxBuffer = 2000,
  ) {}

  debug(category: LogCategory, message: string, detail?: string): void {
    this.log('debug', category, message, detail);
  }

  info(category: LogCategory, message: string, detail?: string): void {
    this.log('info', category, message, detail);
  }

  warn(category: LogCategory, message: string, detail?: string): void {
    this.log('warn', category, message, detail);
  }

  error(category: LogCategory, message: string, detail?: string, error?: unknown): void {
    this.log('error', category, message, detail ?? errorText(error), error);
  }

  recent(count?: number): LogEntry[] {
    return count === undefined ? [...this.buffer] : this.buffer.slice(-count);
  }

  private log(severity: LogSeverity, category: LogCategory, message: string, detail?: string, error?: unknown): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      severity,
      category,
      message: redactText(message),
    };
    if (detail) entry.detail = redactText(detail);
    if (error instanceof Error && error.stack) entry.stack = redactText(error.stack);

    this.buffer.push(entry);
    if (this.buffer.length > this.maxBuffer) this.buffer.splice(0, this.buffer.length - this.maxBuffer);
    this.sink?.write(entry);
  }
}

function errorText(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return undefined;
}
