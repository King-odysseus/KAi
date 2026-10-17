import * as path from 'node:path';
import { app, type JumpListCategory, type JumpListItem } from 'electron';

const NEW_WINDOW_FLAG = '--new-window';
const OPEN_PROJECT_FLAG = '--open-project';
/** The taskbar menu has room for about ten entries; more would be hidden by Windows anyway. */
const MAX_PROJECTS = 8;

/** What a launch asks for beyond "open KAI": a fresh window, or a window on a particular project. */
export type LaunchIntent = { kind: 'new-window' } | { kind: 'project'; projectId: string } | null;

export function launchIntentFromArgv(argv: readonly string[]): LaunchIntent {
  const projectIndex = argv.indexOf(OPEN_PROJECT_FLAG);
  const projectId = projectIndex >= 0 ? argv[projectIndex + 1] : undefined;
  if (projectId && !projectId.startsWith('--')) return { kind: 'project', projectId };
  if (argv.includes(NEW_WINDOW_FLAG)) return { kind: 'new-window' };
  return null;
}

export interface JumpListProject {
  id: string;
  name: string;
  path: string;
}

/** The taskbar right-click menu: a "New window" task and the user's projects, which Windows lets them pin. */
export function buildJumpList(projects: readonly JumpListProject[], program: string, icon: string): { tasks: Electron.Task[]; categories: JumpListCategory[] } {
  const tasks: Electron.Task[] = [{
    program,
    arguments: NEW_WINDOW_FLAG,
    iconPath: icon,
    iconIndex: 0,
    title: 'New window',
    description: 'Open a separate KAI window',
  }];
  const items: JumpListItem[] = projects.slice(0, MAX_PROJECTS).map((project) => ({
    type: 'task',
    program,
    args: `${OPEN_PROJECT_FLAG} ${project.id}`,
    iconPath: icon,
    iconIndex: 0,
    title: project.name,
    description: project.path,
  }));
  const categories: JumpListCategory[] = items.length > 0 ? [{ type: 'custom', name: 'Projects', items }] : [];
  return { tasks, categories };
}

/** Installs the menu. Windows only, and a failure is not worth stopping for: the menu is a convenience. */
export function applyJumpList(projects: readonly JumpListProject[], iconPath: string = process.execPath): void {
  if (process.platform !== 'win32') return;
  const { tasks, categories } = buildJumpList(projects, process.execPath, iconPath);
  try {
    app.setUserTasks(tasks);
    app.setJumpList(categories);
  } catch {
    // Left as it was.
  }
}

export function jumpListIconPath(): string {
  return app.isPackaged ? process.execPath : path.join(__dirname, '../../build/icon.ico');
}
