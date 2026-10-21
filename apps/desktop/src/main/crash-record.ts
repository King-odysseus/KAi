import { appendFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { app, crashReporter } from 'electron';

/**
 * A plain-text record of how KAI's own process ends, kept next to the app log.
 *
 * KAI ended twice with no word anywhere: no line in the app log, no Windows crash event, no dialog. Without a record
 * there was no telling a crash from a kill. This writes one line for every start and for every way a process can go
 * wrong that the app can see. The two things it lets a reader tell apart are the point of it: an exit line means KAI
 * left on its own, and a start with no exit line before it means something outside ended it.
 *
 * Each line is written synchronously, so it is on disk even when the process is about to go. Native crashes are kept
 * as minidumps in the app's crash folder; nothing is uploaded.
 */

export function crashLogPath(): string {
  return path.join(app.getPath('userData'), 'logs', 'crash.log');
}

/** Appends a line. Never throws: a record that could take the app down would defeat its purpose. */
export function crashNote(message: string): void {
  try {
    const file = crashLogPath();
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    // Nothing to do: there is nowhere else to say so.
  }
}

export function installCrashRecord(): void {
  try {
    crashReporter.start({ submitURL: '', uploadToServer: false, compress: true });
  } catch {
    // Dumps are a bonus; the notes below do not depend on them.
  }
  crashNote(`KAI ${app.getVersion()} started, pid ${process.pid}.`);
  // The monitor event only watches: it leaves Electron's own handling of the error exactly as it was.
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    crashNote(`Uncaught exception (${origin}): ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  });
  process.on('exit', (code) => crashNote(`The main process is exiting on its own, code ${code}.`));
  app.on('child-process-gone', (_event, details) => {
    crashNote(`A KAI process went away: ${details.type}${details.name ? ` (${details.name})` : ''}, reason ${details.reason}, exit code ${details.exitCode}.`);
  });
  app.on('render-process-gone', (_event, _contents, details) => {
    crashNote(`A window's renderer went away: reason ${details.reason}, exit code ${details.exitCode}.`);
  });
  app.on('before-quit', () => crashNote('KAI was asked to quit.'));
}
