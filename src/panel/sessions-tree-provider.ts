import * as vscode from 'vscode';
import type { Cognitive1Client } from '../cognitive1/cognitive1-client';

interface SessionItem {
  label: string;
  description?: string;
  tooltip?: string;
  iconPath?: vscode.ThemeIcon;
  children?: SessionItem[];
}

export class SessionsTreeProvider implements vscode.TreeDataProvider<SessionItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SessionItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly cognitive1: Cognitive1Client) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SessionItem): vscode.TreeItem {
    const collapsible = element.children && element.children.length > 0
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;

    return {
      label: element.label,
      description: element.description,
      tooltip: element.tooltip || element.label,
      iconPath: element.iconPath,
      collapsibleState: collapsible,
    };
  }

  async getChildren(element?: SessionItem): Promise<SessionItem[]> {
    if (element) {
      return element.children || [];
    }

    const health = await this.cognitive1.health();

    if (!health.available) {
      return [{
        label: 'Cognitive1 unavailable',
        description: health.detail,
        iconPath: new vscode.ThemeIcon('warning'),
      }];
    }

    return [
      {
        label: 'Today',
        iconPath: new vscode.ThemeIcon('calendar'),
        tooltip: 'Sessions from today',
        children: [{ label: 'Connect Cognitive1 to see sessions', iconPath: new vscode.ThemeIcon('info') }],
      },
      {
        label: 'This Week',
        iconPath: new vscode.ThemeIcon('calendar'),
        tooltip: 'Sessions from this week',
      },
      {
        label: 'Cost Summary',
        iconPath: new vscode.ThemeIcon('graph'),
        tooltip: 'Cost and token estimates',
        children: [
          { label: 'Direct route costs', iconPath: new vscode.ThemeIcon('circuit-board') },
          { label: 'Proxy route costs', iconPath: new vscode.ThemeIcon('server') },
        ],
      },
      {
        label: 'By Agent',
        iconPath: new vscode.ThemeIcon('person'),
        tooltip: 'Sessions grouped by agent',
        children: [
          { label: 'Claude', iconPath: new vscode.ThemeIcon('hubot') },
          { label: 'Codex', iconPath: new vscode.ThemeIcon('symbol-class') },
          { label: 'Qwen', iconPath: new vscode.ThemeIcon('symbol-parameter') },
          { label: 'Gemini', iconPath: new vscode.ThemeIcon('star') },
        ],
      },
    ];
  }
}
