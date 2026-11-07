import { File as FileFallback, Folder, FolderOpen } from 'lucide-react';
import { useSyncExternalStore, type ReactNode } from 'react';
import { fileIconId, fileIconUrl, folderIconId, type FileIconTheme } from '../file-icons';

/** The theme family the page is in, kept live so a switch in Settings repaints every icon without a reload. */
function subscribeToTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme-family', 'data-file-icons'] });
  return () => observer.disconnect();
}

function currentTheme(): FileIconTheme {
  return document.documentElement.dataset.themeFamily === 'light' ? 'light' : 'dark';
}

export function useFileIconTheme(): FileIconTheme {
  return useSyncExternalStore(subscribeToTheme, currentTheme, () => 'dark');
}

/** Settings can turn the type icons off, which brings back the plain file and folder glyphs. */
function useFileIconsOn(): boolean {
  return useSyncExternalStore(subscribeToTheme, () => document.documentElement.dataset.fileIcons !== 'off', () => true);
}

/** A file's type icon, chosen from its name. Decorative: the name beside it already says what the file is. */
export function FileTypeIcon({ name, size = 14 }: { name: string; size?: number }): ReactNode {
  const theme = useFileIconTheme();
  if (!useFileIconsOn()) return <FileFallback className="file-type-icon plain" size={size - 1} aria-hidden="true" />;
  return <img className="file-type-icon" src={fileIconUrl(fileIconId(name, theme))} width={size} height={size} alt="" aria-hidden="true" draggable={false} />;
}

/** A folder's icon, with the open artwork while it is expanded. */
export function FolderTypeIcon({ name, open, size = 14 }: { name: string; open: boolean; size?: number }): ReactNode {
  const theme = useFileIconTheme();
  if (!useFileIconsOn()) return open ? <FolderOpen className="file-type-icon plain" size={size - 1} aria-hidden="true" /> : <Folder className="file-type-icon plain" size={size - 1} aria-hidden="true" />;
  return <img className="file-type-icon" src={fileIconUrl(folderIconId(name, open, theme))} width={size} height={size} alt="" aria-hidden="true" draggable={false} />;
}
