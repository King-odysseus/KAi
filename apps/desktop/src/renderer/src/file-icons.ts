// Picks a file-type icon for a file or folder name, the way VS Code's icon themes do.
// The lookup tables are generated from Material Icon Theme (see scripts/generate-file-icons.mjs).
import {
  ICON_Base,
  ICON_FileExtensions,
  ICON_FileNames,
  ICON_FolderNames,
  ICON_FolderOpen,
  ICON_LightFileExtensions,
  ICON_LightFileNames,
  ICON_LightFolderNames,
  ICON_LightFolderOpen,
} from './file-icons.generated';

/** KAI's own file and folder kinds, checked before the theme so they win over a generic match. */
const KAI_FILE_NAMES: Readonly<Record<string, string>> = {
  'claude.md': 'claude',
  'agents.md': 'robot',
  'gemini.md': 'gemini-ai',
  'skill.md': 'skill',
  '.mcp.json': 'console',
  'code-guide.json': 'document',
};

const KAI_FOLDER_NAMES: Readonly<Record<string, string>> = {
  '.kai': 'folder-robot',
  '.claude': 'folder-claude',
  '.codex': 'folder-robot',
  plans: 'folder-tasks',
  skills: 'folder-skills',
  recipes: 'folder-resource',
  checkpoints: 'folder-backup',
  reports: 'folder-docs',
  handoffs: 'folder-resource',
};

export type FileIconTheme = 'dark' | 'light';

function pick(tables: ReadonlyArray<Readonly<Record<string, string>>>, key: string): string | undefined {
  for (const table of tables) {
    const hit = table[key];
    if (hit) return hit;
  }
  return undefined;
}

/** Icon id for a file name (`package.json`, `app.test.ts`, `Dockerfile`). */
export function fileIconId(fileName: string, theme: FileIconTheme = 'dark'): string {
  const name = fileName.toLowerCase();
  const names = theme === 'light' ? [KAI_FILE_NAMES, ICON_LightFileNames, ICON_FileNames] : [KAI_FILE_NAMES, ICON_FileNames];
  const byName = pick(names, name);
  if (byName) return byName;
  const extensions = theme === 'light' ? [ICON_LightFileExtensions, ICON_FileExtensions] : [ICON_FileExtensions];
  // `app.test.ts` tries `test.ts` before `ts`, so a compound extension beats a plain one.
  for (let dot = name.indexOf('.'); dot !== -1; dot = name.indexOf('.', dot + 1)) {
    const byExtension = pick(extensions, name.slice(dot + 1));
    if (byExtension) return byExtension;
  }
  return ICON_Base.file;
}

/** Icon id for a folder name; `open` picks the open-folder artwork. */
export function folderIconId(folderName: string, open: boolean, theme: FileIconTheme = 'dark'): string {
  const name = folderName.toLowerCase();
  const closed = pick(theme === 'light' ? [KAI_FOLDER_NAMES, ICON_LightFolderNames, ICON_FolderNames] : [KAI_FOLDER_NAMES, ICON_FolderNames], name);
  if (!closed) return open ? ICON_Base.folderOpen : ICON_Base.folder;
  if (!open) return closed;
  const exception = pick(theme === 'light' ? [ICON_LightFolderOpen, ICON_FolderOpen] : [ICON_FolderOpen], name);
  return exception ?? `${closed}-open`;
}

/** Where an icon's SVG is served from; the files live in the renderer's `public/file-icons/`. */
export function fileIconUrl(id: string): string {
  return `./file-icons/${id}.svg`;
}
