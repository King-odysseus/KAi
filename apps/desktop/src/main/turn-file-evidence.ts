import { writtenPaths, type PersistedEvent, type TurnFileChange } from '@kai/contracts';
import { readProjectFile } from './project-files';

/** Capture actual file hashes before the completed turn is published; never trust a model's reported hashes. */
export async function captureTurnFileEvidence(projectRoot: string, changes: readonly TurnFileChange[], events: readonly PersistedEvent[]): Promise<Array<{ path: string; hash: string | null }>> {
  const paths = new Set(changes.map((file) => file.path));
  for (const event of events) {
    for (const file of writtenPaths(event)) paths.add(file);
  }
  return Promise.all([...paths].slice(0, 50).map(async (file) => {
    // The shared reader checks project ownership and size before reading, including symlink targets.
    const opened = await readProjectFile(projectRoot, file).catch(() => null);
    return { path: file, hash: opened?.hash ?? null };
  }));
}
