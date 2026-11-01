import * as vscode from 'vscode';
import type { ConventionService, ConventionsState } from './conventions-service';

/** Asks for the folder that holds all the developer's projects, and remembers it. Returns null when they cancel. */
export async function chooseConventionsFolder(): Promise<string | null> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Use this folder',
    title: 'Choose the folder that holds all your projects',
  });
  const folder = picked?.[0]?.fsPath;
  if (!folder) return null;
  await vscode.workspace.getConfiguration('kai').update('conventionsRoot', folder, vscode.ConfigurationTarget.Global);
  return folder;
}

type Action = 'rescan' | 'rule' | 'removeRule' | 'references' | 'toggle' | 'folder';

interface MenuItem extends vscode.QuickPickItem { action: Action }

function menu(state: ConventionsState, root: string): MenuItem[] {
  const served = state.items.filter((item) => !item.muted).length;
  const chosen = state.projects.filter((project) => project.reference).length;
  return [
    { action: 'rescan', label: '$(sync) Read my projects again', description: state.scanning ? 'reading now…' : 'Finds a new habit after you start a new project' },
    { action: 'rule', label: '$(add) Add a rule…', description: 'For example: never use 1px hairline borders' },
    ...(state.rules.length > 0 ? [{ action: 'removeRule' as const, label: '$(trash) Remove a rule…', description: `${state.rules.length} written` }] : []),
    { action: 'references', label: '$(paintcan) Choose the projects that show how I want things to look…', description: `${chosen} chosen` },
    { action: 'toggle', label: '$(checklist) Turn conventions on or off…', description: `${served} of ${state.items.length} given to agents` },
    { action: 'folder', label: '$(folder) Change the folder that holds my projects…', description: root || 'not chosen yet' },
  ];
}

/**
 * The one place to see and steer what KAI has learned about how the developer builds. Every agent run is given the
 * conventions that are switched on; a rule written here, or the look of a project chosen here, is followed in every
 * project without being asked again.
 */
export async function manageConventions(service: ConventionService): Promise<void> {
  const settings = vscode.workspace.getConfiguration('kai');
  let root = settings.get<string>('conventionsRoot', '').trim();
  if (!root) {
    root = (await chooseConventionsFolder()) ?? '';
    if (!root) return;
    await service.refresh();
  }
  for (;;) {
    const state = await service.state();
    const fresh = state.items.filter((item) => item.isNew && !item.muted).length;
    const pick = await vscode.window.showQuickPick(menu(state, root), {
      title: 'How you build',
      placeHolder: `${state.total} projects read · ${state.items.filter((item) => !item.muted).length} conventions given to every agent run${fresh > 0 ? ` · ${fresh} new` : ''}`,
    });
    if (!pick) { await service.markSeen(); return; }

    if (pick.action === 'rescan') {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Reading your projects…' }, () => service.refresh());
    } else if (pick.action === 'rule') {
      const text = await vscode.window.showInputBox({ title: 'A rule for every agent', prompt: 'It is followed in every project.', placeHolder: 'Never use 1px hairline borders', ignoreFocusOut: true });
      if (text?.trim()) await service.addRule(text);
    } else if (pick.action === 'removeRule') {
      const choice = await vscode.window.showQuickPick(state.rules.map((rule) => ({ label: rule.text, id: rule.id })), { title: 'Remove which rule?' });
      if (choice) await service.removeRule(choice.id);
    } else if (pick.action === 'references') {
      const items = state.projects.map((project) => ({ label: project.name, description: project.path, picked: project.reference, path: project.path }));
      const chosen = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        title: 'Which projects show how you want things to look?',
        placeHolder: 'What their buttons and cards do becomes how agents write styles.',
      });
      if (chosen) {
        const wanted = new Set(chosen.map((item) => item.path));
        for (const project of state.projects) {
          if (wanted.has(project.path) !== project.reference) await service.setReference(project.path, wanted.has(project.path));
        }
      }
    } else if (pick.action === 'toggle') {
      const items = state.items.map((item) => ({ label: item.text, description: item.source === 'rule' ? 'your rule' : item.source === 'style' ? 'how it looks' : 'what you build with', detail: item.evidence, picked: !item.muted, key: item.key }));
      const chosen = await vscode.window.showQuickPick(items, { canPickMany: true, title: 'Give these to every agent run', placeHolder: 'Untick one to stop agents following it.' });
      if (chosen) {
        const on = new Set(chosen.map((item) => item.key));
        for (const item of state.items) if (on.has(item.key) === item.muted) await service.setMuted(item.key, !on.has(item.key));
      }
    } else if (pick.action === 'folder') {
      const folder = await chooseConventionsFolder();
      if (folder) {
        root = folder;
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Reading your projects…' }, () => service.refresh());
      }
    }
  }
}
