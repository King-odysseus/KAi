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

/**
 * The taskbar right-click menu: a "New window" task and the user's projects, which Windows lets them pin.
 *
 * Both are one list. The menu used to be set in two calls, tasks first and then the project list, and the second call
 * replaces everything the first one set, so the "New window" entry was thrown away every time the menu was built and
 * Windows only ever showed the projects. Tasks are a category of the one list, not a separate setting.
 */
export function buildJumpList(projects: readonly JumpListProject[], program: string, icon: string): { categories: JumpListCategory[] } {
  const newWindow: JumpListItem = {
    type: 'task',
    program,
    args: NEW_WINDOW_FLAG,
    iconPath: icon,
    iconIndex: 0,
    title: 'New window',
    description: 'Open a separate KAI window',
  };
  const items: JumpListItem[] = projects.slice(0, MAX_PROJECTS).map((project) => ({
    type: 'task',
    program,
    args: `${OPEN_PROJECT_FLAG} ${project.id}`,
    iconPath: icon,
    iconIndex: 0,
    title: project.name,
    description: project.path,
  }));
  const categories: JumpListCategory[] = [{ type: 'tasks', items: [newWindow] }];
  if (items.length > 0) categories.push({ type: 'custom', name: 'Projects', items });
  return { categories };
}

/**
 * Installs the menu. Windows only, and a failure is not worth stopping for: the menu is a convenience. Returns what
 * Windows said ("ok", or why it refused) so a menu that did not take is noticed instead of silently missing.
 */
export function applyJumpList(projects: readonly JumpListProject[], iconPath: string = process.execPath): string {
  if (process.platform !== 'win32') return 'ok';
  const { categories } = buildJumpList(projects, process.execPath, iconPath);
  try {
    return app.setJumpList(categories);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function jumpListIconPath(): string {
  return app.isPackaged ? process.execPath : path.join(__dirname, '../../build/icon.ico');
}
