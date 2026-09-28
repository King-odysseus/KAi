import * as path from 'node:path';
import type { DataLocation } from '@kai/contracts';

export interface DesktopPaths {
  root: string;
  settings: string;
  projects: string;
  preferences: string;
  conversations: string;
  logs: string;
  credentials: string;
  attachments: string;
  backups: string;
  learning: string;
  studio: string;
}

export function createDesktopPaths(root: string): DesktopPaths {
  const resolved = path.resolve(root);
  return {
    root: resolved,
    settings: path.join(resolved, 'settings.json'),
    projects: path.join(resolved, 'projects.json'),
    preferences: path.join(resolved, 'project-preferences.json'),
    conversations: path.join(resolved, 'conversations'),
    logs: path.join(resolved, 'logs'),
    credentials: path.join(resolved, 'credentials.vault.json'),
    attachments: path.join(resolved, 'attachments'),
    backups: path.join(resolved, 'backups'),
    learning: path.join(resolved, 'learning'),
    studio: path.join(resolved, 'studio'),
  };
}

export function dataLocations(paths: DesktopPaths): DataLocation[] {
  return [
    { label: 'Application data', path: paths.root, kind: 'runtime' },
    { label: 'Settings', path: paths.settings, kind: 'settings' },
    { label: 'Project preferences', path: paths.preferences, kind: 'settings' },
    { label: 'Conversations', path: paths.conversations, kind: 'conversations' },
    { label: 'Credentials', path: paths.credentials, kind: 'credentials' },
    { label: 'Diagnostics', path: paths.logs, kind: 'logs' },
    { label: 'Managed engines', path: path.join(paths.root, 'engines'), kind: 'runtime' },
    { label: 'Attachments', path: paths.attachments, kind: 'runtime' },
    { label: 'Configuration backups', path: paths.backups, kind: 'settings' },
    { label: 'Learning progress and teaching library', path: paths.learning, kind: 'runtime' },
    { label: 'Project Studio interviews', path: paths.studio, kind: 'runtime' },
  ];
}
