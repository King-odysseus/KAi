import * as fs from 'fs/promises';
import * as path from 'path';
import { randomBytes } from 'crypto';

const TOKEN_FILE = 'proxy-token';

/**
 * The token KAI's own agents present to the built-in proxy — written into
 * ~/.claude/settings.json as ANTHROPIC_AUTH_TOKEN, and required back by
 * proxy-server.ts on /v1/messages.
 *
 * Persisted per installation rather than regenerated on each activation.
 * KAI only rewrites that settings file just before a proxy-routed run, so a
 * per-activation token would be stale from the moment a new window opened —
 * any agent started another way (`claude` typed into a terminal, say) would
 * get a 401 until KAI happened to run one itself. A stable token keeps the
 * same protection, since it is no less unguessable and anything that can
 * read it here could equally read it out of the settings file it is
 * written into.
 */
export async function loadOrCreateProxyToken(storageDir: string): Promise<string> {
  const tokenPath = path.join(storageDir, TOKEN_FILE);

  try {
    const existing = (await fs.readFile(tokenPath, 'utf8')).trim();
    if (existing.length > 0) return existing;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  const token = randomBytes(24).toString('hex');
  await fs.mkdir(storageDir, { recursive: true });
  // 0o600 — owner-only, matching how the token is treated elsewhere.
  await fs.writeFile(tokenPath, token + '\n', { encoding: 'utf8', mode: 0o600 });
  return token;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
