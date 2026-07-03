import type * as vscode from 'vscode';
import type { AgentId } from '../core/types';
import { AGENT_ORDER, AGENT_PROVIDERS } from './agent-catalog';

/**
 * Stores per-agent API keys in the OS-backed VSCode SecretStorage and mirrors
 * them into `process.env` so spawned agent CLIs (and the proxy) inherit them.
 * Keys are never written to settings.json or any plain file.
 */
export class SecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

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

  /** Load every stored key into the current process env (call at activation). */
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
}
