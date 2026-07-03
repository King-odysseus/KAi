import * as vscode from 'vscode';
import type { Cognitive1Client } from '../cognitive1/cognitive1-client';

interface MemoryItem {
  label: string;
  description?: string;
  tooltip?: string;
  iconPath?: vscode.ThemeIcon;
  children?: MemoryItem[];
}

export class MemoryTreeProvider implements vscode.TreeDataProvider<MemoryItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<MemoryItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private items: MemoryItem[] = [];

  constructor(private readonly cognitive1: Cognitive1Client) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: MemoryItem): vscode.TreeItem {
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

  async getChildren(element?: MemoryItem): Promise<MemoryItem[]> {
    if (element) {
      return element.children || [];
    }

    // Root: fetch health and populate top-level sections
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
        label: 'Briefing',
        iconPath: new vscode.ThemeIcon('book'),
        tooltip: 'Current project briefing',
        children: [{ label: 'Loading...', iconPath: new vscode.ThemeIcon('sync~spin') }],
      },
      {
        label: 'Recalls',
        iconPath: new vscode.ThemeIcon('search'),
        tooltip: 'Recent recall results',
      },
      {
        label: 'Handoffs',
        iconPath: new vscode.ThemeIcon('arrow-swap'),
        tooltip: 'Agent handoff history',
      },
      {
        label: 'Sessions',
        iconPath: new vscode.ThemeIcon('history'),
        tooltip: 'Session history',
      },
      {
        label: 'Patterns',
        iconPath: new vscode.ThemeIcon('lightbulb'),
        tooltip: 'Learned patterns and gotchas',
      },
      {
        label: 'Knowledge',
        iconPath: new vscode.ThemeIcon('database'),
        tooltip: 'Project knowledge entries',
      },
    ];
  }
}
