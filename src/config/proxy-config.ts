import * as vscode from 'vscode';
import type { SecretStore } from './secret-store';
import type { ProxyServerConfig } from '../proxy/proxy-server';

/**
 * Unified proxy-config reader.
 *
 * **Authoritative namespace**: `kai.proxy.*` (KAI-owned).
 * **Legacy fallback**: `claudeProxy.*` — read-only backward compatibility.
 *
 * API keys are resolved from VS Code SecretStorage (never plaintext settings).
 * Legacy plaintext keys in `claudeProxy.*` are migrated on first read, then
 * cleared from settings without losing non-secret config.
 */

// ---- resolved config types ----

export interface ResolvedProxyConfig {
  port: number;
  targetBaseUrl: string;
  apiKey: string;
  defaultModel: string;
  modelMap: Record<string, string>;
  codexConfig: ResolvedAgentBackend;
  qwenConfig: ResolvedAgentBackend;
  /** Raw routing flags (read from both namespaces). */
  routing: {
    routeClaudeCode: boolean;
    routeCodex: boolean;
  };
}

export interface ResolvedAgentBackend {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  configModel?: string;
}

// ---- SecretStorage keys ----

const SECRET_UPSTREAM = 'kai.proxy.upstreamKey';
const SECRET_CODEX_BACKEND = 'kai.proxy.codexBackendKey';
const SECRET_QWEN_BACKEND = 'kai.proxy.qwenBackendKey';

// ---- defaults ----

const DEFAULT_TARGET_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-v4-pro';

// ---- public API ----

/**
 * Read the effective proxy configuration by merging kai.proxy.* (primary) with
 * claudeProxy.* (legacy fallback). API keys always come from SecretStorage;
 * legacy plaintext keys trigger a one-time migration.
 */
export async function resolveProxyConfig(
  kaiCfg: vscode.WorkspaceConfiguration,
  legacyCfg: vscode.WorkspaceConfiguration,
  secrets: SecretStore,
): Promise<ResolvedProxyConfig> {
  const port = kaiCfg.get<number>('proxyPort', 8082);

  // Non-secret values: kai.proxy.* first, then claudeProxy.* fallback
  const targetBaseUrl = normalizeBaseUrl(firstOf(
    kaiCfg.get<string>('proxy.targetBaseUrl', ''),
    legacyCfg.get<string>('targetBaseUrl', ''),
    DEFAULT_TARGET_BASE_URL,
  ));

  const defaultModel = firstOf(
    kaiCfg.get<string>('proxy.defaultModel', ''),
    legacyCfg.get<string>('defaultModel', ''),
    DEFAULT_MODEL,
  );

  const modelMap = firstOf(
    nonEmptyRecord(kaiCfg.get<Record<string, string>>('proxy.modelMap', {})),
    nonEmptyRecord(legacyCfg.get<Record<string, string>>('modelMap', {})),
    {},
  );

  // API keys: SecretStorage → legacy migration fallback
  const apiKey = await resolveUpstreamKey(secrets, legacyCfg);

  // Routing flags
  const routeClaudeCode = kaiCfg.get<boolean>('proxy.routeClaudeCode', false)
    || legacyCfg.get<boolean>('routeClaudeCode', false);
  const routeCodex = kaiCfg.get<boolean>('proxy.routeCodex', false)
    || legacyCfg.get<boolean>('routeCodex', false);

  // Agent backends
  const codexConfig = await resolveAgentBackend(
    'codex', kaiCfg, legacyCfg, secrets, SECRET_CODEX_BACKEND,
  );
  const qwenConfig = await resolveAgentBackend(
    'qwen', kaiCfg, legacyCfg, secrets, SECRET_QWEN_BACKEND,
  );

  return {
    port,
    targetBaseUrl,
    apiKey,
    defaultModel,
    modelMap,
    codexConfig,
    qwenConfig,
    routing: { routeClaudeCode, routeCodex },
  };
}

/**
 * Convert resolved config into the shape KaiProxyServer expects.
 */
export function toProxyServerConfig(resolved: ResolvedProxyConfig): ProxyServerConfig {
  return {
    port: resolved.port,
    targetBaseUrl: resolved.targetBaseUrl,
    apiKey: resolved.apiKey,
    defaultModel: resolved.defaultModel,
    modelMap: resolved.modelMap,
    codexConfig: resolved.codexConfig.enabled
      ? {
          enabled: resolved.codexConfig.enabled,
          baseUrl: resolved.codexConfig.baseUrl,
          apiKey: resolved.codexConfig.apiKey,
          defaultModel: resolved.codexConfig.defaultModel,
        }
      : undefined,
  };
}

/**
 * One-time migration: move legacy plaintext API keys into SecretStorage, then
 * clear them from settings. Non-secret config is preserved.
 *
 * Safe to call on every activation — skips keys already in SecretStorage.
 */
export async function migrateLegacyProxySecrets(
  legacyCfg: vscode.WorkspaceConfiguration,
  kaiCfg: vscode.WorkspaceConfiguration,
  secrets: SecretStore,
): Promise<{ migrated: string[] }> {
  const migrated: string[] = [];

  // 1. claudeProxy.apiKey → SecretStorage
  const legacyApiKey = legacyCfg.get<string>('apiKey', '');
  if (legacyApiKey.trim()) {
    const existing = await secrets.getUpstreamKey();
    if (!existing) {
      await secrets.setUpstreamKey(legacyApiKey);
      migrated.push('claudeProxy.apiKey');
    }
    await legacyCfg.update('apiKey', '', vscode.ConfigurationTarget.Global);
  }

  // 2. claudeProxy.apiKeys (per-url keys) → SecretStorage (first non-empty value wins)
  const legacyApiKeys = legacyCfg.get<Record<string, string>>('apiKeys', {});
  const firstLegacyKey = Object.values(legacyApiKeys ?? {}).find(v => v.trim());
  if (firstLegacyKey) {
    const existing = await secrets.getUpstreamKey();
    if (!existing) {
      await secrets.setUpstreamKey(firstLegacyKey);
      migrated.push('claudeProxy.apiKeys');
    }
    await legacyCfg.update('apiKeys', undefined, vscode.ConfigurationTarget.Global);
  }

  // 3. claudeProxy.codexConfig.apiKey → SecretStorage
  await migrateBackendKey(legacyCfg, 'codexConfig', SECRET_CODEX_BACKEND, secrets, migrated);

  // 4. claudeProxy.qwenConfig.apiKey → SecretStorage
  await migrateBackendKey(legacyCfg, 'qwenConfig', SECRET_QWEN_BACKEND, secrets, migrated);

  // 5. kai.proxy.apiKey (if it somehow exists, it's the new namespace) → SecretStorage
  const kaiApiKey = kaiCfg.get<string>('proxy.apiKey', '');
  if (kaiApiKey.trim()) {
    const existing = await secrets.getUpstreamKey();
    if (!existing) {
      await secrets.setUpstreamKey(kaiApiKey);
      migrated.push('kai.proxy.apiKey');
    }
    await kaiCfg.update('proxy.apiKey', '', vscode.ConfigurationTarget.Global);
  }

  return { migrated };
}

// ---- internal helpers ----

async function resolveUpstreamKey(
  secrets: SecretStore,
  legacyCfg: vscode.WorkspaceConfiguration,
): Promise<string> {
  // 1. SecretStorage
  const stored = await secrets.getUpstreamKey();
  if (stored) return stored;

  // 2. Legacy claudeProxy.apiKey (plaintext — migrate on next activation)
  const legacyKey = legacyCfg.get<string>('apiKey', '');
  if (legacyKey.trim()) return legacyKey;

  // 3. Legacy claudeProxy.apiKeys (first value)
  const legacyKeys = legacyCfg.get<Record<string, string>>('apiKeys', {});
  const firstKey = Object.values(legacyKeys ?? {}).find(v => v.trim());
  if (firstKey) return firstKey;

  return '';
}

async function resolveAgentBackend(
  agent: 'codex' | 'qwen',
  kaiCfg: vscode.WorkspaceConfiguration,
  legacyCfg: vscode.WorkspaceConfiguration,
  secrets: SecretStore,
  secretKey: string,
): Promise<ResolvedAgentBackend> {
  const kaiSection = kaiCfg.get<Record<string, unknown>>(`proxy.${agent}Config`, {}) as Record<string, unknown>;
  const legacySection = legacyCfg.get<Record<string, unknown>>(`${agent}Config`, {}) as Record<string, unknown>;

  const enabled = Boolean(firstOf(
    kaiSection?.enabled as boolean | undefined,
    legacySection?.enabled as boolean | undefined,
    false,
  ));

  const baseUrl = firstOf(
    (kaiSection?.baseUrl as string) || '',
    (legacySection?.baseUrl as string) || '',
    '',
  );

  const defaultModel = firstOf(
    (kaiSection?.defaultModel as string) || '',
    (legacySection?.defaultModel as string) || '',
    '',
  );

  const configModel = firstOf(
    kaiSection?.configModel as string | undefined,
    legacySection?.configModel as string | undefined,
    undefined,
  );

  // API key: SecretStorage → legacy plaintext fallback
  let apiKey = await secrets.secretStorageGet(secretKey);
  if (!apiKey) {
    apiKey = (legacySection?.apiKey as string) || '';
  }

  return { enabled, baseUrl, apiKey, defaultModel, configModel };
}

async function migrateBackendKey(
  legacyCfg: vscode.WorkspaceConfiguration,
  sectionKey: string,
  secretKey: string,
  secrets: SecretStore,
  migrated: string[],
): Promise<void> {
  const section = legacyCfg.get<Record<string, unknown>>(sectionKey, {}) as Record<string, unknown>;
  const plainKey = (section?.apiKey as string) || '';
  if (plainKey.trim()) {
    const existing = await secrets.secretStorageGet(secretKey);
    if (!existing) {
      await secrets.secretStorageSet(secretKey, plainKey);
      migrated.push(`claudeProxy.${sectionKey}.apiKey`);
    }
    // Clear the key from the config object while preserving other fields
    const cleaned = { ...section };
    delete cleaned.apiKey;
    await legacyCfg.update(sectionKey, cleaned, vscode.ConfigurationTarget.Global);
  }
}

// ---- value helpers ----

/** Return the first truthy (non-empty-string / defined) value. */
function firstOf<T>(...candidates: (T | undefined | null | '')[]): T {
  for (const c of candidates) {
    if (c !== undefined && c !== null && c !== '') return c;
  }
  return undefined as unknown as T;
}

/** Return the record if it has at least one key, otherwise undefined. */
function nonEmptyRecord<T extends Record<string, unknown>>(r: T): T | undefined {
  if (!r || typeof r !== 'object') return undefined;
  return Object.keys(r).length > 0 ? r : undefined;
}

/**
 * Strip Anthropic API path suffixes from a base URL while preserving OpenAI
 * compatible paths such as /v1.
 */
function normalizeBaseUrl(url: string): string {
  for (const suffix of ['/anthropic/v1', '/anthropic']) {
    if (url.endsWith(suffix)) {
      return url.slice(0, -suffix.length);
    }
  }
  return url;
}
