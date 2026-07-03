import * as vscode from 'vscode';
import type { RawFallbackEvent, WorkbenchEvent } from '../core/events';

export class RawEventInspector {
  private static readonly MAX_EVENTS = 50;
  private events: RawFallbackEvent[] = [];

  push(event: WorkbenchEvent): void {
    if (event.type !== 'raw.fallback') return;
    this.events.push(event);
    if (this.events.length > RawEventInspector.MAX_EVENTS) {
      this.events.shift();
    }
  }

  getEvents(): RawFallbackEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
  }
}

export function registerRawInspectorCommand(
  context: vscode.ExtensionContext,
  inspector: RawEventInspector,
): vscode.Disposable {
  return vscode.commands.registerCommand('kai.inspectRawEvents', async () => {
    const events = inspector.getEvents();
    if (events.length === 0) {
      void vscode.window.showInformationMessage('No raw fallback events captured yet.');
      return;
    }

    const items = events.map((event, i) => ({
      label: `${event.timestamp} — ${event.sourceType || 'raw'}`,
      description: typeof event.payload === 'string'
        ? event.payload.slice(0, 80)
        : JSON.stringify(event.payload).slice(0, 80),
      detail: `#${events.length - i} — ${event.agent || 'unknown'} | Click to copy payload`,
      event,
    }));

    const picked = await vscode.window.showQuickPick(items.reverse(), {
      title: 'KAI Raw Event Inspector',
      placeHolder: 'Select an event to copy its payload',
    });

    if (picked) {
      const payload = typeof picked.event.payload === 'string'
        ? picked.event.payload
        : JSON.stringify(picked.event.payload, null, 2);
      await vscode.env.clipboard.writeText(payload);
      void vscode.window.showInformationMessage('Raw event payload copied to clipboard.');
    }
  });
}
