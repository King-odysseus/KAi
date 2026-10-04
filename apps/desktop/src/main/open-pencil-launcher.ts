import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Gets open-pencil running and readable, for the design-build loop. KAI never bundles or owns open-pencil — it is a
 * separate app the user installs — so this only launches the executable already on disk and waits for the discovery
 * file it writes itself once its MCP server is listening.
 */

/** The editor's own "I am listening" file: written fresh on every start, token included when auth is on. Checked
 * before launching anything, and re-read every time a build step runs, because the token is reissued on every
 * start (when there is one) and a cached one goes stale the moment the editor restarts. */
interface OpenPencilDiscovery {
  httpPort: number;
  authRequired: boolean;
  authToken: string | null;
}

/** Checked in order: the modded build first (what this machine runs), then the unmodified baseline. */
const INSTALL_FOLDERS = ['OpenPencilMod', 'OpenPencil'];

function candidatePaths(localAppData: string, exeName: string): string[] {
  return INSTALL_FOLDERS.map((folder) => path.join(localAppData, folder, exeName));
}

async function readDiscovery(file: string): Promise<OpenPencilDiscovery | null> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const value = JSON.parse(raw) as Partial<OpenPencilDiscovery>;
    if (typeof value.httpPort !== 'number') return null;
    const authRequired = value.authRequired === true;
    // A file claiming auth is required but holding no usable token is not a running server worth connecting to;
    // one claiming auth is off is valid even with authToken: null, which is exactly what it sends in that case.
    if (authRequired && (typeof value.authToken !== 'string' || !value.authToken)) return null;
    return { httpPort: value.httpPort, authRequired, authToken: authRequired ? (value.authToken as string) : null };
  } catch {
    return null;
  }
}

export interface OpenPencilConnection {
  endpoint: string;
  /** Null when the editor is running with auth off — callers should send no Authorization header at all, not a
   * header holding the literal word "null". */
  token: string | null;
}

/** Open-pencil's live discovery file, read fresh. Null when it is not running (no file) or starting (file not
 * written yet). */
export async function readOpenPencilDiscovery(
  localAppData = process.env.LOCALAPPDATA,
): Promise<OpenPencilConnection | null> {
  if (!localAppData) return null;
  for (const file of candidatePaths(localAppData, 'mcp.json')) {
    const discovery = await readDiscovery(file);
    if (discovery) return { endpoint: `http://127.0.0.1:${discovery.httpPort}/mcp`, token: discovery.authToken };
  }
  return null;
}

/**
 * Open-pencil running and ready to answer, launching it when it is not. KAI only starts the process; the editor
 * itself decides when it is ready by writing the discovery file, which is what this polls for.
 */
export async function ensureOpenPencilRunning(
  options: { localAppData?: string; timeoutMs?: number; pollMs?: number } = {},
): Promise<OpenPencilConnection> {
  const localAppData = options.localAppData ?? process.env.LOCALAPPDATA;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 750;
  const existing = await readOpenPencilDiscovery(localAppData);
  if (existing) return existing;

  if (!localAppData) {
    throw new Error('open-pencil could not be found: %LOCALAPPDATA% is not set. Start the editor yourself, then try again.');
  }
  const exe = await findExisting(candidatePaths(localAppData, 'OpenPencilMod.exe').concat(candidatePaths(localAppData, 'OpenPencil.exe')));
  if (!exe) {
    throw new Error('open-pencil is not installed where KAI expects it (%LOCALAPPDATA%\\OpenPencilMod or \\OpenPencil). Install or start it yourself, then try again.');
  }
  const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, pollMs); });
    const discovery = await readOpenPencilDiscovery(localAppData);
    if (discovery) return discovery;
  }
  throw new Error('open-pencil did not finish starting within 30 seconds. Open it yourself and try again.');
}

async function findExisting(paths: readonly string[]): Promise<string | null> {
  for (const candidate of paths) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}
