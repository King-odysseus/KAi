import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LogEntry } from '@kai/contracts';
import type { LoggerSink } from '@kai/runtime';

const MAX_LOG_BYTES = 5 * 1024 * 1024;

export class RotatingLogSink implements LoggerSink {
  private readonly filePath: string;

  constructor(directory: string) {
    this.filePath = path.join(directory, 'kai.jsonl');
  }

  write(entry: LogEntry): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const line = `${JSON.stringify(entry)}\n`;
      const size = fs.existsSync(this.filePath) ? fs.statSync(this.filePath).size : 0;
      if (size + Buffer.byteLength(line) > MAX_LOG_BYTES) {
        fs.renameSync(this.filePath, `${this.filePath}.${Date.now()}`);
      }
      fs.appendFileSync(this.filePath, line, 'utf8');
    } catch {
      // Diagnostics must never break the desktop application.
    }
  }
}
