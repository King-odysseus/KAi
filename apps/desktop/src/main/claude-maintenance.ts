import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProxyClaudeResetResult } from '@kai/contracts';

const PROXY_ENV_VARS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'API_TIMEOUT_MS',
] as const;

export interface ClaudeResetOptions {
  homeDirectory?: string;
  killProcess?: (pid: number) => void;
}

export function claudeSettingsPath(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, '.claude', 'settings.json');
}

export async function resetClaudeCodeConfig(
  options: ClaudeResetOptions = {},
): Promise<ProxyClaudeResetResult> {
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const claudeDirectory = path.join(homeDirectory, '.claude');
  const killProcess = options.killProcess ?? ((pid: number) => process.kill(pid));
  const warnings: string[] = [];
  let settingsUpdated = false;
  let credentialsCleared = false;
  let onboardingReset = false;
  let sessionsRemoved = 0;
  let processesStopped = 0;
  let sessionEnvRemoved = 0;

  const settingsPath = path.join(claudeDirectory, 'settings.json');
  try {
    const settings = await readObject(settingsPath);
    if (settings) {
      const env = isRecord(settings.env) ? { ...settings.env } : null;
      if (env) {
        for (const key of PROXY_ENV_VARS) {
          if (key in env) {
            delete env[key];
            settingsUpdated = true;
          }
        }
        if (Object.keys(env).length > 0) settings.env = env;
        else delete settings.env;
        if (settingsUpdated) await writeJson(settingsPath, settings);
      }
    }
  } catch (error) {
    warnings.push(`Claude settings could not be reset: ${messageOf(error)}`);
  }

  const sessionsDirectory = path.join(claudeDirectory, 'sessions');
  try {
    for (const entry of await fs.readdir(sessionsDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const sessionPath = path.join(sessionsDirectory, entry.name);
      try {
        const session = await readObject(sessionPath);
        const pid = session && Number.isInteger(session.pid) ? Number(session.pid) : 0;
        if (pid > 0 && pid !== process.pid) {
          try {
            killProcess(pid);
            processesStopped += 1;
          } catch {
            // A stale session commonly refers to a process that already exited.
          }
        }
        await fs.unlink(sessionPath);
        sessionsRemoved += 1;
      } catch (error) {
        warnings.push(`Session ${entry.name} could not be removed: ${messageOf(error)}`);
      }
    }
  } catch (error) {
    if (!isMissing(error)) warnings.push(`Claude sessions could not be cleared: ${messageOf(error)}`);
  }

  const credentialsPath = path.join(claudeDirectory, '.credentials.json');
  try {
    const credentials = await readObject(credentialsPath);
    if (credentials) {
      await writeJson(credentialsPath, {});
      credentialsCleared = true;
    }
  } catch (error) {
    warnings.push(`Claude credentials could not be cleared: ${messageOf(error)}`);
  }

  const sessionEnvDirectory = path.join(claudeDirectory, 'session-env');
  try {
    for (const entry of await fs.readdir(sessionEnvDirectory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      try {
        await fs.unlink(path.join(sessionEnvDirectory, entry.name));
        sessionEnvRemoved += 1;
      } catch (error) {
        warnings.push(`Session environment ${entry.name} could not be removed: ${messageOf(error)}`);
      }
    }
  } catch (error) {
    if (!isMissing(error)) warnings.push(`Claude session environment could not be cleared: ${messageOf(error)}`);
  }

  const mcpConfigPath = path.join(claudeDirectory, '.claude.json');
  try {
    const mcpConfig = await readObject(mcpConfigPath);
    if (mcpConfig && 'hasCompletedOnboarding' in mcpConfig) {
      delete mcpConfig.hasCompletedOnboarding;
      await writeJson(mcpConfigPath, mcpConfig);
      onboardingReset = true;
    }
  } catch (error) {
    warnings.push(`Claude onboarding state could not be reset: ${messageOf(error)}`);
  }

  return {
    settingsUpdated,
    sessionsRemoved,
    processesStopped,
    credentialsCleared,
    sessionEnvRemoved,
    onboardingReset,
    warnings,
  };
}

export async function ensureClaudeSettingsFile(homeDirectory = os.homedir()): Promise<string> {
  const settingsPath = claudeSettingsPath(homeDirectory);
  try {
    await fs.access(settingsPath);
  } catch {
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await writeJson(settingsPath, {});
  }
  return settingsPath;
}

async function readObject(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
