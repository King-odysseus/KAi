import * as vscode from 'vscode';

interface ListItem {
  label: string;
  description?: string;
  tooltip?: string;
  iconPath?: vscode.ThemeIcon;
  children?: ListItem[];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function renderItems(items: ListItem[], depth: number): Promise<string> {
  const rows: string[] = [];
  for (const item of items) {
    const desc = item.description ? `<span class="desc">${escapeHtml(item.description)}</span>` : '';
    rows.push(`<li class="d${depth}"><span class="lbl">${escapeHtml(item.label)}</span>${desc}</li>`);
    if (item.children?.length) {
      rows.push(await renderItems(item.children, depth + 1));
    }
  }
  return rows.join('\n');
}

/**
 * Open a read-only editor tab listing a tree provider's items.
 *
 * Memory and Sessions were sidebar tree views. The sidebar is chat-only now, and
 * neither view is rich enough to justify a bespoke webview, so they share this
 * one renderer rather than motivating two more HTML surfaces.
 */
export function openListTab(
  title: string,
  provider: vscode.TreeDataProvider<ListItem>,
): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    `kai.list.${title.toLowerCase()}`,
    title,
    vscode.ViewColumn.Active,
    { enableScripts: false },
  );

  const paint = async (): Promise<void> => {
    let items: ListItem[] = [];
    let failure = '';
    try {
      items = (await provider.getChildren()) ?? [];
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }

    const body = failure
      ? `<p class="err">Could not load ${escapeHtml(title.toLowerCase())}: ${escapeHtml(failure)}</p>`
      : await renderItems(items, 0);

    panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body { margin: 0; padding: 18px 22px; font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); }
  h1 { font-size: 15px; font-weight: 600; margin: 0 0 14px; }
  ul { list-style: none; margin: 0; padding: 0; }
  ul ul { padding-left: 18px; }
  li { padding: 4px 0; border-bottom: 1px solid var(--vscode-panel-border, #3333); display: flex; gap: 10px; align-items: baseline; }
  li.d0 > .lbl { font-weight: 600; }
  .desc { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .err { color: var(--vscode-errorForeground); }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<ul>
${body}
</ul>
</body>
</html>`;
  };

  void paint();
  panel.onDidChangeViewState(() => {
    if (panel.visible) void paint();
  });

  return panel;
}
