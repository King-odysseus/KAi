import type * as vscode from 'vscode';
import type { AgentId } from '../core/types';
import { AGENT_ORDER, AGENT_PROVIDERS } from './agent-catalog';

// ---- SecretStorage key constants (shared with proxy-config.ts) ----

export const SECRET_UPSTREAM = 'kai.proxy.upstreamKey';
export const SECRET_CODEX_BACKEND = 'kai.proxy.codexBackendKey';
export const SECRET_QWEN_BACKEND = 'kai.proxy.qwenBackendKey';

/**
 * Stores per-agent API keys AND upstream/provider backend keys in the
 * OS-backed VS Code SecretStorage and mirrors them into `process.env` so
 * spawned agent CLIs (and the proxy) inherit them.
 * Keys are never written to settings.json or any plain file.
 */
export class SecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  // ---- Per-agent keys (unchanged API) ----

  private storageKey(agentId: AgentId): string {
    return `kai.apiKey.${agentId}`;
  }

  async get(agentId: AgentId): Promise<string | undefined> {
    return this.secrets.get(this.storageKey(agentId));
  }

  async set(agentId: AgentId, value: string): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed) {
      await this.delete(agentId);
      return;
    }
    await this.secrets.store(this.storageKey(agentId), trimmed);
    process.env[AGENT_PROVIDERS[agentId].envVar] = trimmed;
  }

  async delete(agentId: AgentId): Promise<void> {
    await this.secrets.delete(this.storageKey(agentId));
    delete process.env[AGENT_PROVIDERS[agentId].envVar];
  }

  /** Load every stored per-agent key into the current process env (call at activation). */
  async loadIntoEnv(): Promise<void> {
    for (const id of AGENT_ORDER) {
      const value = await this.get(id);
      if (value) {
        process.env[AGENT_PROVIDERS[id].envVar] = value;
      }
    }
  }

  /** Map of agentId → whether a key is currently stored (never returns values). */
  async status(): Promise<Record<AgentId, boolean>> {
    const out = {} as Record<AgentId, boolean>;
    for (const id of AGENT_ORDER) {
      out[id] = Boolean(await this.get(id));
    }
    return out;
  }

  // ---- Upstream proxy key ----

  async getUpstreamKey(): Promise<string | undefined> {
    return this.secrets.get(SECRET_UPSTREAM);
  }

  async setUpstreamKey(value: string): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed) {
      await this.secrets.delete(SECRET_UPSTREAM);
      return;
    }
    await this.secrets.store(SECRET_UPSTREAM, trimmed);
  }

  async deleteUpstreamKey(): Promise<void> {
    await this.secrets.delete(SECRET_UPSTREAM);
  }

  // ---- Per-agent provider backend keys ----

  async getCodexBackendKey(): Promise<string | undefined> {
    return this.secrets.get(SECRET_CODEX_BACKEND);
  }

  async setCodexBackendKey(value: string): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed) {
      await this.secrets.delete(SECRET_CODEX_BACKEND);
      return;
    }
    await this.secrets.store(SECRET_CODEX_BACKEND, trimmed);
  }

  async getQwenBackendKey(): Promise<string | undefined> {
    return this.secrets.get(SECRET_QWEN_BACKEND);
  }

  async setQwenBackendKey(value: string): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed) {
      await this.secrets.delete(SECRET_QWEN_BACKEND);
      return;
    }
    await this.secrets.store(SECRET_QWEN_BACKEND, trimmed);
  }

  // ---- Low-level access (used by proxy-config migration) ----

  async secretStorageGet(key: string): Promise<string | undefined> {
    return this.secrets.get(key);
  }

  async secretStorageSet(key: string, value: string): Promise<void> {
    await this.secrets.store(key, value.trim());
  }

  // ---- Proxy key status (never returns values) ----

  async proxyKeyStatus(): Promise<{
    upstream: boolean;
    codexBackend: boolean;
    qwenBackend: boolean;
  }> {
    const [upstream, codexBackend, qwenBackend] = await Promise.all([
      this.getUpstreamKey(),
      this.getCodexBackendKey(),
      this.getQwenBackendKey(),
    ]);
    return {
      upstream: Boolean(upstream),
      codexBackend: Boolean(codexBackend),
      qwenBackend: Boolean(qwenBackend),
    };
  }
}
