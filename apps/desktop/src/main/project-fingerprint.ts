import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { gitOverview } from './git-tools';

/**
 * A fingerprint of every changed file's actual content, for "did anything change since I last looked". A review's diff
 * text cannot answer that: it stops at a number of files, cuts each diff, and shows a new file as a bare name, so
 * editing a new file or the far end of a big diff looked like no change at all.
 *
 * The Architect uses it to tell whether a turn changed anything, and the Crew uses it to avoid paying for a second
 * review of work that has not changed since the first.
 */
export async function projectFingerprint(root: string): Promise<string> {
  const changes = (await gitOverview(root)).changes.map((change) => change.path).sort();
  const hash = createHash('sha1');
  for (const file of changes) {
    hash.update(`${file}\0`);
    try {
      const info = await stat(path.join(root, file));
      // A file this large is told apart by size and time; reading it all for a hash is not worth it.
      if (info.size > 5 * 1024 * 1024) hash.update(`${info.size}:${info.mtimeMs}`);
      else hash.update(await readFile(path.join(root, file)));
    } catch {
      hash.update('missing');
    }
    hash.update('\0');
  }
  return `${changes.length}:${hash.digest('hex')}`;
}
